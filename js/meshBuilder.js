// Small helpers for accumulating merged geometry.
import * as THREE from 'three';

export class GeoBuilder {
    constructor(withColor = false) {
        this.pos = []; this.uv = []; this.idx = []; this.nor = [];
        this.col = withColor ? [] : null;
        this.vcount = 0;
    }
    get empty() { return this.vcount === 0; }

    vertex(x, y, z, u, v, nx = 0, ny = 1, nz = 0, r = 1, g = 1, b = 1) {
        this.pos.push(x, y, z); this.uv.push(u, v); this.nor.push(nx, ny, nz);
        if (this.col) this.col.push(r, g, b);
        return this.vcount++;
    }
    tri(a, b, c) { this.idx.push(a, b, c); }
    quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

    // A box in three.js space; local X along `yaw`, base at y. uv scales in metres.
    box(cx, y, cz, sx, sy, sz, yaw, { uScale = 1, vScale = 1, top = true, sides = true, bottom = false, uOffset = 0, vOffset = 0 } = {}) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const hx = sx / 2, hz = sz / 2;
        // rotation.y = yaw : local (lx, lz) -> (lx*c + lz*s, -lx*s + lz*c)
        const P = (lx, ly, lz) => [cx + lx * c + lz * s, y + ly, cz - lx * s + lz * c];
        const N = (lx, lz) => [lx * c + lz * s, 0, -lx * s + lz * c];
        const face = (p0, p1, p2, p3, n, w, h, uo = 0) => {
            const a = this.vertex(...p0, uOffset + uo, vOffset, ...n);
            const b = this.vertex(...p1, uOffset + uo + w * uScale, vOffset, ...n);
            const cc = this.vertex(...p2, uOffset + uo + w * uScale, vOffset + h * vScale, ...n);
            const d = this.vertex(...p3, uOffset + uo, vOffset + h * vScale, ...n);
            this.quad(a, b, cc, d);
        };
        if (sides) {
            face(P(-hx, 0, hz), P(hx, 0, hz), P(hx, sy, hz), P(-hx, sy, hz), N(0, 1), sx, sy, 0);
            face(P(hx, 0, hz), P(hx, 0, -hz), P(hx, sy, -hz), P(hx, sy, hz), N(1, 0), sz, sy, sx * uScale);
            face(P(hx, 0, -hz), P(-hx, 0, -hz), P(-hx, sy, -hz), P(hx, sy, -hz), N(0, -1), sx, sy, (sx + sz) * uScale);
            face(P(-hx, 0, -hz), P(-hx, 0, hz), P(-hx, sy, hz), P(-hx, sy, -hz), N(-1, 0), sz, sy, (2 * sx + sz) * uScale);
        }
        if (top) {
            const n = [0, 1, 0];
            const a = this.vertex(...P(-hx, sy, hz), 0, 0, ...n);
            const b = this.vertex(...P(hx, sy, hz), sx / 8, 0, ...n);
            const cc = this.vertex(...P(hx, sy, -hz), sx / 8, sz / 8, ...n);
            const d = this.vertex(...P(-hx, sy, -hz), 0, sz / 8, ...n);
            this.quad(a, b, cc, d);
        }
        if (bottom) {
            const n = [0, -1, 0];
            const a = this.vertex(...P(-hx, 0, hz), 0, 0, ...n);
            const b = this.vertex(...P(-hx, 0, -hz), 0, 1, ...n);
            const cc = this.vertex(...P(hx, 0, -hz), 1, 1, ...n);
            const d = this.vertex(...P(hx, 0, hz), 1, 0, ...n);
            this.quad(a, b, cc, d);
        }
    }

    // gable roof: ridge along local X
    gable(cx, y, cz, sx, sz, h, yaw) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const P = (lx, ly, lz) => [cx + lx * c + lz * s, y + ly, cz - lx * s + lz * c];
        const hx = sx / 2, hz = sz / 2;
        const v = (p, u, w) => this.vertex(...p, u, w);
        // slopes
        let a = v(P(-hx, 0, hz), 0, 0), b = v(P(hx, 0, hz), sx / 4, 0), d = v(P(hx, h, 0), sx / 4, 1), e = v(P(-hx, h, 0), 0, 1);
        this.quad(a, b, d, e);
        a = v(P(hx, 0, -hz), 0, 0); b = v(P(-hx, 0, -hz), sx / 4, 0); d = v(P(-hx, h, 0), sx / 4, 1); e = v(P(hx, h, 0), 0, 1);
        this.quad(a, b, d, e);
        // gable ends
        a = v(P(hx, 0, hz), 0, 0); b = v(P(hx, 0, -hz), 1, 0); d = v(P(hx, h, 0), 0.5, 1); this.tri(a, b, d);
        a = v(P(-hx, 0, -hz), 0, 0); b = v(P(-hx, 0, hz), 1, 0); d = v(P(-hx, h, 0), 0.5, 1); this.tri(a, b, d);
    }

    build(computeNormals = false) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
        if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
        g.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
        if (computeNormals) g.computeVertexNormals();
        g.computeBoundingSphere();
        return g;
    }
}

// Keyed collection of builders, one per material.
export class MultiBuilder {
    constructor() { this.map = new Map(); }
    get(key, withColor = false) {
        let b = this.map.get(key);
        if (!b) { b = new GeoBuilder(withColor); this.map.set(key, b); }
        return b;
    }
    // materials: { key: material }; returns array of meshes
    meshes(materials, { castShadow = false, receiveShadow = true, computeNormals = false } = {}) {
        const out = [];
        for (const [key, b] of this.map) {
            if (b.empty) continue;
            const mesh = new THREE.Mesh(b.build(computeNormals), materials[key]);
            mesh.castShadow = castShadow;
            mesh.receiveShadow = receiveShadow;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();
            out.push(mesh);
        }
        return out;
    }
}

// Ribbon along the road between global sample indices [i0, i1].
// fn(sample, which) -> {d, h} for the two edges; skip(sa, sb) -> bool to leave gaps.
export function ribbon(builder, road, i0, i1, d0, d1, h0, h1, { uScale = 1, vPeriod = 10, uMode = 'norm', skip = null, flip = false } = {}) {
    let prev = null;
    for (let i = i0; i <= i1; i++) {
        const s = road.sample(i);
        if (!s) continue;
        const nx = -s.sn, ny = s.c;
        const edge = (d, h) => {
            const x = s.x + nx * d, y = s.y + ny * d;
            const z = s.z - d * s.bank + h;
            return [x, z, -y];
        };
        const A = edge(d0, h0), B = edge(d1, h1);
        let v = s.s / vPeriod, vA = v, vB = v;
        let uA = uMode === 'norm' ? 0 : d0 * uScale;
        let uB = uMode === 'norm' ? uScale : d1 * uScale;
        if (uMode === 'world') { uA = A[0] * uScale; vA = A[2] * uScale; uB = B[0] * uScale; vB = B[2] * uScale; }
        const ia = builder.vertex(...A, uA, vA);
        const ib = builder.vertex(...B, uB, vB);
        if (prev && !(skip && skip(prev.s, s.s))) {
            // default winding faces +Y when d0 < d1 (or outward for vertical strips with flip)
            if (flip) builder.quad(prev.ia, prev.ib, ib, ia);
            else builder.quad(prev.ia, ia, ib, prev.ib);
        }
        prev = { ia, ib, s: s.s };
    }
}

export const toThree = (x, y, z) => [x, z, -y];
