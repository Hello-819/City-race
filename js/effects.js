// Particle effects: tyre smoke, skid marks and crash sparks.
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

    update(dt) {
        this.smoke.update(dt); this.sparks.update(dt);
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

    clearTransient() { this.smoke.clear(); this.sparks.clear(); }

    dispose() {
        this.smoke.dispose(); this.sparks.dispose();
        this.scene.remove(this.marks);
        this.marks.geometry.dispose();
    }
}
