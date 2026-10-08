// Sky, sun/moon, fog, image-based lighting and time-of-day presets.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export const TIMES = {
    day: {
        label: 'Day', elevation: 48, azimuth: 35, turbidity: 5, rayleigh: 1.2, mie: 0.004, mieG: 0.8,
        sun: 0xfff3e0, sunI: 3.2, hemiSky: 0xbfd6ff, hemiGround: 0x6b6250, hemiI: 1.0,
        fog: 0xc3d3e2, exposure: 0.62, night: false, envBoost: 1,
    },
    sunset: {
        label: 'Sunset', elevation: 3.5, azimuth: 200, turbidity: 9, rayleigh: 3.0, mie: 0.006, mieG: 0.93,
        sun: 0xffa060, sunI: 2.6, hemiSky: 0x9fa8d8, hemiGround: 0x5a4030, hemiI: 0.75,
        fog: 0xd59a76, exposure: 0.55, night: false, envBoost: 1,
    },
    night: {
        label: 'Night', elevation: 35, azimuth: 120,
        sun: 0x9fb4ff, sunI: 0.6, hemiSky: 0x3b4a7a, hemiGround: 0x3a2c20, hemiI: 0.85,
        fog: 0x0d1424, exposure: 1.1, night: true, envBoost: 0.6,
    },
};

export class Environment {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.pmrem = new THREE.PMREMGenerator(renderer);

        this.sky = new Sky();
        this.sky.scale.setScalar(3500);
        this.sky.frustumCulled = false;

        this.nightSky = this._makeNightSky();
        this.stars = this._makeStars();

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
        this.envRT = null;
    }

    _makeNightSky() {
        const geo = new THREE.SphereGeometry(3400, 32, 16);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide, depthWrite: false, fog: false,
            uniforms: { top: { value: new THREE.Color(0x02040c) }, horizon: { value: new THREE.Color(0x15203a) }, glow: { value: new THREE.Color(0x3a2a30) } },
            vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }',
            fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; varying vec3 vDir; void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, pow(max(h,0.0), 0.45)); c += glow * exp(-abs(h) * 14.0) * 0.6; gl_FragColor = vec4(c, 1.0); }',
        });
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        m.renderOrder = -10;
        return m;
    }

    _makeStars() {
        const N = 2500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const u = Math.random(), v = Math.random() * 0.9 + 0.08;
            const th = u * Math.PI * 2, ph = Math.acos(1 - v);
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
        const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, transparent: true }));
        p.frustumCulled = false;
        return p;
    }

    apply(timeKey, kind) {
        const t = this.preset = TIMES[timeKey];
        this.kind = kind;
        const scene = this.scene;
        scene.remove(this.sky, this.nightSky, this.stars);

        const phi = THREE.MathUtils.degToRad(90 - t.elevation);
        const theta = THREE.MathUtils.degToRad(t.azimuth);
        this.sunDir.setFromSphericalCoords(1, phi, theta);

        const envScene = new THREE.Scene();
        if (!t.night) {
            const u = this.sky.material.uniforms;
            u.turbidity.value = t.turbidity; u.rayleigh.value = t.rayleigh;
            u.mieCoefficient.value = t.mie; u.mieDirectionalG.value = t.mieG;
            u.sunPosition.value.copy(this.sunDir);
            scene.add(this.sky);
            const envSky = new Sky();
            envSky.scale.setScalar(100);
            Object.assign(envSky.material.uniforms.turbidity, { value: t.turbidity });
            envSky.material.uniforms.rayleigh.value = t.rayleigh;
            envSky.material.uniforms.mieCoefficient.value = t.mie;
            envSky.material.uniforms.mieDirectionalG.value = t.mieG;
            envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
            envScene.add(envSky);
        } else {
            scene.add(this.nightSky, this.stars);
            envScene.add(this.nightSky.clone());
            // a few bright "city light" panels so paint has something to reflect
            const lm = new THREE.MeshBasicMaterial({ color: 0xffd6a0 });
            for (let i = 0; i < 10; i++) {
                const p = new THREE.Mesh(new THREE.PlaneGeometry(14, 3), lm);
                const a = i / 10 * Math.PI * 2;
                p.position.set(Math.cos(a) * 40, 12 + (i % 3) * 6, Math.sin(a) * 40);
                p.lookAt(0, 0, 0);
                envScene.add(p);
            }
        }
        // ground hemisphere for reflections
        const ground = new THREE.Mesh(new THREE.CircleGeometry(90, 24), new THREE.MeshBasicMaterial({ color: t.night ? 0x050608 : (kind === 'city' ? 0x3a3a3c : 0x2f3a24) }));
        ground.rotation.x = -Math.PI / 2; ground.position.y = -2;
        envScene.add(ground);
        if (this.envRT) this.envRT.dispose();
        this.envRT = this.pmrem.fromScene(envScene, 0, 0.1, 400);
        scene.environment = this.envRT.texture;

        this.sunLight.color.set(t.sun);
        this.sunLight.intensity = t.sunI;
        this.hemi.color.set(t.hemiSky);
        this.hemi.groundColor.set(t.hemiGround);
        this.hemi.intensity = t.hemiI;
        this.renderer.toneMappingExposure = t.exposure;

        const far = kind === 'city' ? (t.night ? 650 : 900) : (t.night ? 700 : 1500);
        scene.fog = new THREE.Fog(t.fog, kind === 'city' ? 40 : 80, far);
        scene.background = new THREE.Color(t.fog);
        this.fogFar = far;
    }

    update(focus, camera) {
        // keep the shadow frustum centred on the car, snapped to texels to avoid shimmering
        const L = this.sunLight;
        const texel = 140 / 2048;
        const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
        L.target.position.set(fx, focus.y, fz);
        L.position.set(fx + this.sunDir.x * 200, focus.y + this.sunDir.y * 200, fz + this.sunDir.z * 200);
        if (this.preset && this.preset.night) {
            this.nightSky.position.copy(camera.position);
            this.stars.position.copy(camera.position);
        } else {
            this.sky.position.copy(camera.position);
        }
    }
}
