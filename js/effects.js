// Tyre smoke particles and skid marks.
import * as THREE from 'three';
import { glowTexture } from './textures.js';

const SMOKE_MAX = 260;
const MARK_MAX = 900;

export class Effects {
    constructor(scene, night) {
        this.scene = scene;
        // --- smoke: one Points draw call with per-particle size / alpha ---
        const g = new THREE.BufferGeometry();
        this.sPos = new Float32Array(SMOKE_MAX * 3);
        this.sSize = new Float32Array(SMOKE_MAX);
        this.sAlpha = new Float32Array(SMOKE_MAX);
        g.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
        g.setAttribute('size', new THREE.BufferAttribute(this.sSize, 1));
        g.setAttribute('alpha', new THREE.BufferAttribute(this.sAlpha, 1));
        const shade = night ? 0.35 : 0.85;
        this.smoke = new THREE.Points(g, new THREE.ShaderMaterial({
            uniforms: { map: { value: glowTexture() }, color: { value: new THREE.Color(shade, shade, shade) }, scale: { value: 600 } },
            vertexShader: `attribute float size; attribute float alpha; varying float vAlpha; uniform float scale;
                void main(){ vAlpha = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `uniform sampler2D map; uniform vec3 color; varying float vAlpha;
                void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(color, t.a * vAlpha); }`,
            transparent: true, depthWrite: false,
        }));
        this.smoke.frustumCulled = false;
        this.particles = [];
        for (let i = 0; i < SMOKE_MAX; i++) this.particles.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1 });
        this.next = 0;
        scene.add(this.smoke);

        // --- skid marks: ring buffer of quads ---
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
        this.lastWheel = [null, null];
        scene.add(this.marks);
        this.tmp = new THREE.Vector3();
    }

    // rig: player car rig, veh: vehicle, road surface height function provided via car root
    update(dt, rig, veh) {
        const skid = veh.skid;
        const speed = veh.speed;
        rig.root.updateMatrixWorld(true);
        const rear = rig.wheels.filter(w => !w.front);
        rear.forEach((w, k) => {
            const p = this.tmp.set(w.center.x, 0.03, w.center.z).applyMatrix4(rig.root.matrixWorld);
            // marks
            if (skid > 0.35 && speed > 3) {
                const last = this.lastWheel[k];
                if (last && last.distanceToSquared(p) > 0.09 && last.distanceToSquared(p) < 16) this._mark(last, p, Math.min(0.75, skid));
                if (!last || last.distanceToSquared(p) > 0.09) this.lastWheel[k] = p.clone();
            } else this.lastWheel[k] = null;
            // smoke
            if (skid > 0.45 && speed > 2.5) {
                const n = Math.random() < skid * dt * 60 * 0.8 ? 1 : 0;
                for (let i = 0; i < n; i++) this._emit(p.x, p.y + 0.15, p.z, skid);
            }
        });

        // simulate particles
        let alive = 0;
        for (let i = 0; i < SMOKE_MAX; i++) {
            const q = this.particles[i];
            if (q.life > 0) {
                q.life -= dt;
                q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
                q.vx *= 0.96; q.vz *= 0.96; q.vy = q.vy * 0.98 + 0.4 * dt;
                const t = 1 - q.life / q.max;
                this.sPos[i * 3] = q.x; this.sPos[i * 3 + 1] = q.y; this.sPos[i * 3 + 2] = q.z;
                this.sSize[i] = q.size * (0.6 + t * 2.4);
                this.sAlpha[i] = Math.max(0, (1 - t) * 0.45 * Math.min(1, t * 6));
                alive++;
            } else this.sAlpha[i] = 0;
        }
        const ga = this.smoke.geometry.attributes;
        ga.position.needsUpdate = ga.size.needsUpdate = ga.alpha.needsUpdate = true;
    }

    _emit(x, y, z, s) {
        const q = this.particles[this.next];
        this.next = (this.next + 1) % SMOKE_MAX;
        q.max = q.life = 1.2 + Math.random() * 1.0;
        q.x = x + (Math.random() - 0.5) * 0.3; q.y = y; q.z = z + (Math.random() - 0.5) * 0.3;
        q.vx = (Math.random() - 0.5) * 1.5; q.vy = 0.4 + Math.random() * 0.6; q.vz = (Math.random() - 0.5) * 1.5;
        q.size = 1.0 + s * 1.2;
    }

    _mark(a, b, alpha) {
        const i = this.markNext;
        this.markNext = (this.markNext + 1) % MARK_MAX;
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len * 0.13, nz = dx / len * 0.13;
        const P = this.mPos;
        P.set([a.x + nx, a.y, a.z + nz, a.x - nx, a.y, a.z - nz, b.x - nx, b.y, b.z - nz, b.x + nx, b.y, b.z + nz], i * 12);
        this.mAlpha.set([alpha, alpha, alpha, alpha], i * 4);
        const ga = this.marks.geometry.attributes;
        ga.position.needsUpdate = true; ga.alpha.needsUpdate = true;
    }

    dispose() {
        this.scene.remove(this.smoke, this.marks);
        this.smoke.geometry.dispose(); this.marks.geometry.dispose();
    }
}
