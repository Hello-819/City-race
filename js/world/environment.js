// Sky, sun/moon, fog and image-based lighting driven by ONE continuous
// day/night clock (no presets / modes). `update()` advances the clock and
// smoothly interpolates every lighting parameter from the sun elevation.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG } from '../config.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';

// Key frames indexed by sun elevation (degrees). Values are interpolated.
const KEYS = [
    { el: -14, sun: 0x8fa6ff, sunI: 0.35, sky: 0x2c3a66, ground: 0x2a2018, hemiI: 0.55, fog: 0x0b1222, exposure: 1.05 },
    { el: -4, sun: 0x9a8cff, sunI: 0.3, sky: 0x55507a, ground: 0x3a2a24, hemiI: 0.6, fog: 0x3a3450, exposure: 0.9 },
    { el: 2, sun: 0xff9a55, sunI: 1.6, sky: 0x9fa8d8, ground: 0x5a4030, hemiI: 0.7, fog: 0xd59a76, exposure: 0.6 },
    { el: 12, sun: 0xffd6a8, sunI: 2.6, sky: 0xaec6f0, ground: 0x65584a, hemiI: 0.9, fog: 0xc9c4c0, exposure: 0.6 },
    { el: 35, sun: 0xfff3e0, sunI: 3.2, sky: 0xbfd6ff, ground: 0x6b6250, hemiI: 1.0, fog: 0xc3d3e2, exposure: 0.62 },
];
const _c1 = new THREE.Color(), _c2 = new THREE.Color();

function sample(el) {
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    if (el <= a.el) b = a;
    else if (el >= b.el) a = b;
    else for (let i = 1; i < KEYS.length; i++) if (el <= KEYS[i].el) { a = KEYS[i - 1]; b = KEYS[i]; break; }
    const t = a === b ? 0 : (el - a.el) / (b.el - a.el);
    const col = (k) => _c1.set(a[k]).lerp(_c2.set(b[k]), t).getHex();
    return {
        sun: col('sun'), sky: col('sky'), ground: col('ground'), fog: col('fog'),
        sunI: lerp(a.sunI, b.sunI, t), hemiI: lerp(a.hemiI, b.hemiI, t), exposure: lerp(a.exposure, b.exposure, t),
    };
}

export class Environment {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.pmrem = new THREE.PMREMGenerator(renderer);
        this.hour = CONFIG.time.startHour;
        this.fogNear = 60; this.fogFar = 1400;

        this.sky = new Sky();
        this.sky.scale.setScalar(3500);
        this.sky.frustumCulled = false;
        const u = this.sky.material.uniforms;
        u.turbidity.value = 6; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.85;

        this.nightSky = this._makeNightSky();
        this.stars = this._makeStars();
        scene.add(this.sky, this.nightSky, this.stars);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
        this.sunLight.castShadow = true;
        const sc = this.sunLight.shadow.camera;
        sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 500;
        this.sunLight.shadow.mapSize.set(2048, 2048);
        this.sunLight.shadow.bias = -0.0004;
        this.sunLight.shadow.normalBias = 0.04;
        this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        scene.add(this.sunLight, this.sunLight.target, this.hemi);
        this.sunDir = new THREE.Vector3();
        this.lightDir = new THREE.Vector3();
        this.envRT = null;
        this.envHour = -99;
        this.night = 0;          // 0 = full day .. 1 = full night (for street lights, windows)
        scene.fog = new THREE.Fog(0xc3d3e2, this.fogNear, this.fogFar);
        scene.background = new THREE.Color(0xc3d3e2);
        this.listeners = [];     // fn(nightFactor) called when lighting changes noticeably
        this._lastNight = -1;
        this._apply(true);
    }

    _makeNightSky() {
        const geo = new THREE.SphereGeometry(3400, 32, 16);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide, depthWrite: false, fog: false, transparent: true,
            uniforms: { top: { value: new THREE.Color(0x02040c) }, horizon: { value: new THREE.Color(0x15203a) }, glow: { value: new THREE.Color(0x3a2a30) }, alpha: { value: 0 } },
            vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }',
            fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform float alpha; varying vec3 vDir; void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, pow(max(h,0.0), 0.45)); c += glow * exp(-abs(h) * 14.0) * 0.6; gl_FragColor = vec4(c, alpha); }',
        });
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        m.renderOrder = -9;
        return m;
    }

    _makeStars() {
        const N = 2500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const uu = Math.random(), v = Math.random() * 0.9 + 0.08;
            const th = uu * Math.PI * 2, ph = Math.acos(1 - v);
            const r = 3200;
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = r * Math.cos(ph);
            pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
            const b = 0.5 + Math.random() * 0.5;
            col[i * 3] = b; col[i * 3 + 1] = b; col[i * 3 + 2] = b * (0.9 + Math.random() * 0.2);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, transparent: true, opacity: 0 }));
        p.frustumCulled = false;
        p.renderOrder = -8;
        return p;
    }

    // Sun elevation (deg) from the clock: rises 06:00, peaks 12:00, sets 18:00.
    get sunElevation() { return 62 * Math.sin((this.hour - 6) / 12 * Math.PI); }
    get clockText() {
        const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    setHour(h) { this.hour = ((h % 24) + 24) % 24; this._apply(true); }

    _apply(forceEnv = false) {
        const el = this.sunElevation;
        const az = THREE.MathUtils.degToRad(90 + (this.hour - 12) * 15);   // east -> south -> west
        this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - el), az);
        const k = sample(el);
        this.night = smoothstep(2, -8, el);
        // the directional light follows the sun by day and the (opposite) moon by night
        if (el > -3) this.lightDir.copy(this.sunDir);
        else this.lightDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - clamp(-el, 25, 60)), az + Math.PI);
        if (this.lightDir.y < 0.08) { this.lightDir.y = 0.08; this.lightDir.normalize(); }

        this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
        this.nightSky.material.uniforms.alpha.value = this.night;
        this.stars.material.opacity = smoothstep(-2, -12, el);
        this.sky.visible = this.night < 0.999;

        this.sunLight.color.set(k.sun);
        this.sunLight.intensity = k.sunI;
        this.hemi.color.set(k.sky);
        this.hemi.groundColor.set(k.ground);
        this.hemi.intensity = k.hemiI;
        this.renderer.toneMappingExposure = k.exposure;
        this.scene.fog.color.set(k.fog);
        this.scene.background.set(k.fog);
        this.scene.fog.near = this.fogNear;
        this.scene.fog.far = this.fogFar * lerp(1, 0.7, this.night);

        let dh = Math.abs(this.hour - this.envHour); dh = Math.min(dh, 24 - dh);
        if (forceEnv || dh >= CONFIG.time.envRefreshHours) this._bakeEnv();
        if (Math.abs(this.night - this._lastNight) > 0.02 || forceEnv) {
            this._lastNight = this.night;
            for (const fn of this.listeners) fn(this.night);
        }
    }

    // Reflection probe: a small copy of the current sky (+ some warm "city light" panels at night).
    _bakeEnv() {
        this.envHour = this.hour;
        const envScene = new THREE.Scene();
        const envSky = new Sky();
        envSky.scale.setScalar(100);
        for (const key of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'sunPosition']) {
            const v = this.sky.material.uniforms[key].value;
            envSky.material.uniforms[key].value = v.clone ? v.clone() : v;
        }
        if (this.night < 0.95) envScene.add(envSky);
        if (this.night > 0.05) {
            const ns = new THREE.Mesh(new THREE.SphereGeometry(90, 16, 8), this.nightSky.material.clone());
            ns.material.uniforms.alpha.value = this.night;
            envScene.add(ns);
            const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd6a0).multiplyScalar(this.night) });
            for (let i = 0; i < 10; i++) {
                const p = new THREE.Mesh(new THREE.PlaneGeometry(14, 3), lm);
                const a = i / 10 * Math.PI * 2;
                p.position.set(Math.cos(a) * 40, 12 + (i % 3) * 6, Math.sin(a) * 40);
                p.lookAt(0, 0, 0);
                envScene.add(p);
            }
        }
        const ground = new THREE.Mesh(new THREE.CircleGeometry(90, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a3a3c).multiplyScalar(1 - this.night * 0.9) }));
        ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
        envScene.add(ground);
        const rt = this.pmrem.fromScene(envScene, 0, 0.1, 400);
        if (this.envRT) this.envRT.dispose();
        this.envRT = rt;
        this.scene.environment = rt.texture;
        envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }

    // Advance the clock and keep shadows centred on `focus`.
    update(dt, focus, camera) {
        this.hour = (this.hour + dt * 24 / (CONFIG.time.dayLengthMinutes * 60)) % 24;
        this._apply(false);
        const L = this.sunLight;
        const texel = 140 / 2048;
        const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
        L.target.position.set(fx, focus.y, fz);
        L.position.set(fx + this.lightDir.x * 200, focus.y + this.lightDir.y * 200, fz + this.lightDir.z * 200);
        this.sky.position.copy(camera.position);
        this.nightSky.position.copy(camera.position);
        this.stars.position.copy(camera.position);
    }
}
