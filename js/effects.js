// Particle effects: tyre smoke, skid marks, sparks, engine smoke / fire, explosions.
import * as THREE from 'three';
import { glowTexture } from './textures.js';

const MARK_MAX = 900;

// One draw call per system; per-particle position / size / colour / alpha.
class ParticleSystem {
    constructor(scene, max, { additive = false, scale = 600 } = {}) {
        this.max = max;
        const g = new THREE.BufferGeometry();
        this.pos = new Float32Array(max * 3);
        this.size = new Float32Array(max);
        this.alpha = new Float32Array(max);
        this.col = new Float32Array(max * 3);
        g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
        g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
        g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
        g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
        this.points = new THREE.Points(g, new THREE.ShaderMaterial({
            uniforms: { map: { value: glowTexture() }, scale: { value: scale } },
            vertexShader: `attribute float size; attribute float alpha; attribute vec3 pcolor; varying float vAlpha; varying vec3 vColor; uniform float scale;
                void main(){ vAlpha = alpha; vColor = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `uniform sampler2D map; varying float vAlpha; varying vec3 vColor;
                void main(){ vec4 t = texture2D(map, gl_PointCoord); if (vAlpha <= 0.001) discard; gl_FragColor = vec4(vColor, t.a * vAlpha); }`,
            transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        }));
        this.points.frustumCulled = false;
        this.p = [];
        for (let i = 0; i < max; i++) this.p.push({ life: 0 });
        this.next = 0;
        scene.add(this.points);
        this.scene = scene;
    }

    emit(o) {
        const q = this.p[this.next];
        this.next = (this.next + 1) % this.max;
        q.max = q.life = o.life;
        q.x = o.x; q.y = o.y; q.z = o.z;
        q.vx = o.vx || 0; q.vy = o.vy || 0; q.vz = o.vz || 0;
        q.size = o.size; q.grow = o.grow ?? 2; q.a = o.alpha ?? 0.5;
        q.r = o.r ?? 1; q.g = o.g ?? 1; q.b = o.b ?? 1;
        q.r2 = o.r2 ?? q.r; q.g2 = o.g2 ?? q.g; q.b2 = o.b2 ?? q.b;
        q.gravity = o.gravity ?? 0; q.drag = o.drag ?? 0.96; q.fadeIn = o.fadeIn ?? 6;
    }

    update(dt) {
        for (let i = 0; i < this.max; i++) {
            const q = this.p[i];
            if (q.life > 0) {
                q.life -= dt;
                q.vx *= q.drag; q.vz *= q.drag; q.vy = q.vy * q.drag - q.gravity * dt;
                q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
                const t = 1 - q.life / q.max;
                this.pos[i * 3] = q.x; this.pos[i * 3 + 1] = q.y; this.pos[i * 3 + 2] = q.z;
                this.size[i] = q.size * (0.6 + t * q.grow);
                this.alpha[i] = Math.max(0, (1 - t) * q.a * Math.min(1, t * q.fadeIn));
                this.col[i * 3] = q.r + (q.r2 - q.r) * t; this.col[i * 3 + 1] = q.g + (q.g2 - q.g) * t; this.col[i * 3 + 2] = q.b + (q.b2 - q.b) * t;
            } else this.alpha[i] = 0;
        }
        const a = this.points.geometry.attributes;
        a.position.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = a.pcolor.needsUpdate = true;
    }

    clear() { for (const q of this.p) q.life = 0; }
    dispose() { this.scene.remove(this.points); this.points.geometry.dispose(); }
}

export class Effects {
    constructor(scene, night) {
        this.scene = scene;
        this.night = night;
        this.smoke = new ParticleSystem(scene, 420);
        this.fire = new ParticleSystem(scene, 260, { additive: true });
        this.sparks = new ParticleSystem(scene, 260, { additive: true, scale: 300 });

        // skid marks: ring buffer of quads
        const mg = new THREE.BufferGeometry();
        this.mPos = new Float32Array(MARK_MAX * 4 * 3);
        this.mAlpha = new Float32Array(MARK_MAX * 4);
        const idx = new Uint32Array(MARK_MAX * 6);
        for (let i = 0; i < MARK_MAX; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
        mg.setAttribute('position', new THREE.BufferAttribute(this.mPos, 3));
        mg.setAttribute('alpha', new THREE.BufferAttribute(this.mAlpha, 1));
        mg.setIndex(new THREE.BufferAttribute(idx, 1));
        this.marks = new THREE.Mesh(mg, new THREE.ShaderMaterial({
            vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
            fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.02,0.02,0.02, vA); }',
            transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        }));
        this.marks.frustumCulled = false;
        this.markNext = 0;
        this.lastWheel = new Map();
        scene.add(this.marks);

        // explosion flash light (always present so the light count never changes)
        this.flash = new THREE.PointLight(0xffa050, 0, 90, 1.6);
        scene.add(this.flash);
        this.flashT = 0;

        // debris chunks
        this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9, metalness: 0.2 }), 40);
        this.debrisMesh.count = 0;
        this.debrisMesh.frustumCulled = false;
        this.debrisMesh.castShadow = true;
        scene.add(this.debrisMesh);
        this.debris = [];
        this.tmp = new THREE.Vector3();
        this.m4 = new THREE.Matrix4();
        this.q = new THREE.Quaternion();
        this.e = new THREE.Euler();
    }

    // tyre smoke + skid marks for any car rig with a skid amount
    tyres(dt, rig, skid, speed, id = rig) {
        const rear = rig.wheels.filter(w => !w.front);
        rear.forEach((w, k) => {
            const p = this.tmp.set(w.center.x, 0.03, w.center.z).applyMatrix4(rig.root.matrixWorld);
            const key = id + ':' + k;
            const last = this.lastWheel.get(key);
            if (skid > 0.35 && speed > 3) {
                if (last && last.distanceToSquared(p) > 0.09 && last.distanceToSquared(p) < 16) this._mark(last, p, Math.min(0.75, skid));
                if (!last || last.distanceToSquared(p) > 0.09) this.lastWheel.set(key, p.clone());
            } else this.lastWheel.delete(key);
            if (skid > 0.45 && speed > 2.5 && Math.random() < skid * dt * 50) {
                const s = this.night ? 0.35 : 0.85;
                this.smoke.emit({ x: p.x + (Math.random() - 0.5) * 0.3, y: p.y + 0.15, z: p.z + (Math.random() - 0.5) * 0.3,
                    vx: (Math.random() - 0.5) * 1.5, vy: 0.4 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 1.5,
                    life: 1.2 + Math.random(), size: 1 + skid * 1.2, grow: 2.4, alpha: 0.45, r: s, g: s, b: s });
            }
        });
    }

    // engine smoke / fire for a damaged car (health 0..100)
    damage(dt, rig, health, enginePos) {
        if (health > 55) return;
        const p = this.tmp.copy(enginePos).applyMatrix4(rig.root.matrixWorld);
        const sev = 1 - health / 55;
        if (Math.random() < dt * (8 + sev * 30)) {
            const dark = health < 25 ? 0.12 : 0.5;
            this.smoke.emit({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 0.6, vy: 1.4 + Math.random(), vz: (Math.random() - 0.5) * 0.6,
                life: 1.6 + Math.random() * 1.2, size: 0.8 + sev, grow: 3, alpha: 0.55, r: dark, g: dark, b: dark, drag: 0.985 });
        }
        if (health < 22 && Math.random() < dt * 40) {
            this.fire.emit({ x: p.x + (Math.random() - 0.5) * 0.5, y: p.y, z: p.z + (Math.random() - 0.5) * 0.5,
                vx: (Math.random() - 0.5) * 0.4, vy: 1.5 + Math.random() * 1.5, vz: (Math.random() - 0.5) * 0.4,
                life: 0.45 + Math.random() * 0.3, size: 0.9, grow: 0.6, alpha: 0.9, r: 1, g: 0.7, b: 0.25, r2: 0.9, g2: 0.15, b2: 0.02, fadeIn: 20 });
        }
    }

    // sparks at a contact point (three.js space) moving along (vx, vz)
    impactSparks(x, y, z, vx, vz, strength) {
        const n = Math.min(40, 6 + strength * 2);
        for (let i = 0; i < n; i++) {
            this.sparks.emit({ x, y, z, vx: vx * 0.5 + (Math.random() - 0.5) * 8, vy: 1 + Math.random() * 4, vz: vz * 0.5 + (Math.random() - 0.5) * 8,
                life: 0.3 + Math.random() * 0.4, size: 0.18, grow: 0, alpha: 1, r: 1, g: 0.8, b: 0.4, r2: 1, g2: 0.3, b2: 0.05, gravity: 14, drag: 0.98, fadeIn: 30 });
        }
    }

    scrape(x, y, z, vx, vz) {
        if (Math.random() < 0.5) this.impactSparks(x, y, z, vx, vz, 0);
    }

    explode(pos, scale = 1) {
        for (let i = 0; i < 90 * scale; i++) {
            const a = Math.random() * Math.PI * 2, u = Math.random();
            const sp = 4 + Math.random() * 10 * scale;
            this.fire.emit({ x: pos.x, y: pos.y + 0.8, z: pos.z, vx: Math.cos(a) * sp * u, vy: 2 + Math.random() * 9 * scale, vz: Math.sin(a) * sp * u,
                life: 0.6 + Math.random() * 0.8, size: 2.5 * scale, grow: 1.5, alpha: 1, r: 1, g: 0.85, b: 0.4, r2: 0.8, g2: 0.15, b2: 0.02, drag: 0.92, fadeIn: 40 });
        }
        for (let i = 0; i < 60 * scale; i++) {
            const a = Math.random() * Math.PI * 2;
            this.smoke.emit({ x: pos.x + Math.cos(a) * 1.5, y: pos.y + 1, z: pos.z + Math.sin(a) * 1.5, vx: Math.cos(a) * 3, vy: 3 + Math.random() * 4, vz: Math.sin(a) * 3,
                life: 2.5 + Math.random() * 2, size: 3 * scale, grow: 2.5, alpha: 0.7, r: 0.08, g: 0.08, b: 0.08, drag: 0.97, fadeIn: 3 });
        }
        this.impactSparks(pos.x, pos.y + 0.8, pos.z, 0, 0, 30);
        for (let i = 0; i < 14 * scale && this.debris.length < 40; i++) {
            const a = Math.random() * Math.PI * 2;
            this.debris.push({ x: pos.x, y: pos.y + 1, z: pos.z, vx: Math.cos(a) * (4 + Math.random() * 8), vy: 5 + Math.random() * 9, vz: Math.sin(a) * (4 + Math.random() * 8),
                rx: Math.random() * 6, ry: Math.random() * 6, wx: (Math.random() - 0.5) * 12, wy: (Math.random() - 0.5) * 12, s: 0.08 + Math.random() * 0.18, groundY: pos.y });
        }
        this.flash.position.set(pos.x, pos.y + 2, pos.z);
        this.flashT = 1;
    }

    update(dt) {
        this.smoke.update(dt); this.fire.update(dt); this.sparks.update(dt);
        if (this.flashT > 0) { this.flashT = Math.max(0, this.flashT - dt * 1.6); this.flash.intensity = 4000 * this.flashT * this.flashT; }
        let n = 0;
        for (const d of this.debris) {
            if (d.y > d.groundY + d.s * 0.5 || d.vy > 0) {
                d.vy -= 18 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
                d.rx += d.wx * dt; d.ry += d.wy * dt;
                if (d.y < d.groundY + d.s * 0.5) { d.y = d.groundY + d.s * 0.5; d.vy *= -0.3; d.vx *= 0.5; d.vz *= 0.5; d.wx *= 0.5; d.wy *= 0.5; }
            }
            this.e.set(d.rx, d.ry, 0);
            this.m4.compose(this.tmp.set(d.x, d.y, d.z), this.q.setFromEuler(this.e), new THREE.Vector3(d.s * 1.6, d.s * 0.5, d.s));
            this.debrisMesh.setMatrixAt(n++, this.m4);
        }
        this.debrisMesh.count = n;
        this.debrisMesh.instanceMatrix.needsUpdate = true;
    }

    _mark(a, b, alpha) {
        const i = this.markNext;
        this.markNext = (this.markNext + 1) % MARK_MAX;
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len * 0.13, nz = dx / len * 0.13;
        this.mPos.set([a.x + nx, a.y, a.z + nz, a.x - nx, a.y, a.z - nz, b.x - nx, b.y, b.z - nz, b.x + nx, b.y, b.z + nz], i * 12);
        this.mAlpha.set([alpha, alpha, alpha, alpha], i * 4);
        const ga = this.marks.geometry.attributes;
        ga.position.needsUpdate = true; ga.alpha.needsUpdate = true;
    }

    clearTransient() { this.smoke.clear(); this.fire.clear(); this.sparks.clear(); this.debris.length = 0; this.flashT = 0; this.flash.intensity = 0; }

    dispose() {
        this.smoke.dispose(); this.fire.dispose(); this.sparks.dispose();
        this.scene.remove(this.marks, this.flash, this.debrisMesh);
        this.marks.geometry.dispose();
    }
}
