// Builds the meshes for one map chunk at a given level of detail.
//   lod 0 (near): textured terrain, roads, junctions, crossings, pavements,
//                 textured buildings, signs, instanced lamps / trees / rocks.
//   lod 1 (far):  coarse terrain, roads, ONE merged vertex-coloured mesh for
//                 every building and tree in the chunk (2-4 draw calls total).
// All geometry is draped on map.heightAt(); three.js space is (x, z, -y).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { worldMaterials, signMaterial } from './materials.js';
import { clamp, Rng, hashSeed } from '../core/rng.js';

const CHUNK = CONFIG.streaming.chunkSize;
const MC = CONFIG.map;

// ---------------------------------------------------------------------------
// Minimal geometry accumulator (indexed, optional vertex colour).
class Geo {
    constructor(color = false) { this.p = []; this.n = []; this.uv = []; this.c = color ? [] : null; this.i = []; this.v = 0; }
    vert(x, y, z, u, v, nx = 0, ny = 1, nz = 0, col = null) {
        // input in MAP frame (x, y, z=height) -> three (x, z, -y)
        this.p.push(x, z, -y); this.n.push(nx, nz, -ny); this.uv.push(u, v);
        if (this.c) { const c = col || WHITE; this.c.push(c.r, c.g, c.b); }
        return this.v++;
    }
    quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    build() {
        if (!this.v) return null;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
        if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
        g.setIndex(this.v > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
        g.computeBoundingSphere();
        return g;
    }
}
const WHITE = new THREE.Color(1, 1, 1);

// Axis aligned box in map frame. Side uvs are in metres * (us, vs) measured from z0.
function box(g, x0, y0, x1, y1, z0, z1, us, vs, col = null, { top = true, sides = true, topCol = null, topUv = null } = {}) {
    const h = z1 - z0;
    if (sides) {
        const faces = [
            [x0, y0, x1, y0, 0, -1], [x1, y0, x1, y1, 1, 0], [x1, y1, x0, y1, 0, 1], [x0, y1, x0, y0, -1, 0],
        ];
        let u0 = 0;
        for (const [ax, ay, bx, by, nx, ny] of faces) {
            const w = Math.hypot(bx - ax, by - ay);
            const a = g.vert(ax, ay, z0, u0 * us, 0, nx, ny, 0, col);
            const b = g.vert(bx, by, z0, (u0 + w) * us, 0, nx, ny, 0, col);
            const c = g.vert(bx, by, z1, (u0 + w) * us, h * vs, nx, ny, 0, col);
            const d = g.vert(ax, ay, z1, u0 * us, h * vs, nx, ny, 0, col);
            g.quad(a, b, c, d);
            u0 += w;
        }
    }
    if (top) {
        const tc = topCol || col;
        const uv = topUv || ((x, y) => [x / 8, y / 8]);
        const a = g.vert(x0, y0, z1, ...uv(x0, y0), 0, 0, 1, tc);
        const b = g.vert(x1, y0, z1, ...uv(x1, y0), 0, 0, 1, tc);
        const c = g.vert(x1, y1, z1, ...uv(x1, y1), 0, 0, 1, tc);
        const d = g.vert(x0, y1, z1, ...uv(x0, y1), 0, 0, 1, tc);
        g.quad(a, b, c, d);
    }
}

// Gable roof over an axis-aligned rect, ridge along x (ridgeX) or y.
function gable(g, x0, y0, x1, y1, z, rise, ridgeX, col = null) {
    const o = 0.4;   // overhang
    x0 -= o; y0 -= o; x1 += o; y1 += o;
    if (ridgeX) {
        const ym = (y0 + y1) / 2, s = Math.hypot(rise, (y1 - y0) / 2), ny = (y1 - y0) / 2 / s, nz = rise / s;
        let a = g.vert(x0, y0, z, 0, 0, 0, -ny, nz, col), b = g.vert(x1, y0, z, 1, 0, 0, -ny, nz, col), c = g.vert(x1, ym, z + rise, 1, 1, 0, -ny, nz, col), d = g.vert(x0, ym, z + rise, 0, 1, 0, -ny, nz, col);
        g.quad(a, b, c, d);
        a = g.vert(x1, y1, z, 0, 0, 0, ny, nz, col); b = g.vert(x0, y1, z, 1, 0, 0, ny, nz, col); c = g.vert(x0, ym, z + rise, 1, 1, 0, ny, nz, col); d = g.vert(x1, ym, z + rise, 0, 1, 0, ny, nz, col);
        g.quad(a, b, c, d);
        // gable ends
        a = g.vert(x0, y1, z, 0, 0, -1, 0, 0, col); b = g.vert(x0, y0, z, 1, 0, -1, 0, 0, col); c = g.vert(x0, ym, z + rise, 0.5, 1, -1, 0, 0, col);
        g.i.push(a, b, c);
        a = g.vert(x1, y0, z, 0, 0, 1, 0, 0, col); b = g.vert(x1, y1, z, 1, 0, 1, 0, 0, col); c = g.vert(x1, ym, z + rise, 0.5, 1, 1, 0, 0, col);
        g.i.push(a, b, c);
    } else {
        const xm = (x0 + x1) / 2, s = Math.hypot(rise, (x1 - x0) / 2), nx = (x1 - x0) / 2 / s, nz = rise / s;
        let a = g.vert(x0, y1, z, 0, 0, -nx, 0, nz, col), b = g.vert(x0, y0, z, 1, 0, -nx, 0, nz, col), c = g.vert(xm, y0, z + rise, 1, 1, -nx, 0, nz, col), d = g.vert(xm, y1, z + rise, 0, 1, -nx, 0, nz, col);
        g.quad(a, b, c, d);
        a = g.vert(x1, y0, z, 0, 0, nx, 0, nz, col); b = g.vert(x1, y1, z, 1, 0, nx, 0, nz, col); c = g.vert(xm, y1, z + rise, 1, 1, nx, 0, nz, col); d = g.vert(xm, y0, z + rise, 0, 1, nx, 0, nz, col);
        g.quad(a, b, c, d);
        a = g.vert(x0, y0, z, 0, 0, 0, -1, 0, col); b = g.vert(x1, y0, z, 1, 0, 0, -1, 0, col); c = g.vert(xm, y0, z + rise, 0.5, 1, 0, -1, 0, col);
        g.i.push(a, b, c);
        a = g.vert(x1, y1, z, 0, 0, 0, 1, 0, col); b = g.vert(x0, y1, z, 1, 0, 0, 1, 0, col); c = g.vert(xm, y1, z + rise, 0.5, 1, 0, 1, 0, col);
        g.i.push(a, b, c);
    }
}

// A horizontal rect draped on the terrain, subdivided every `step` metres.
function drape(g, map, x0, y0, x1, y1, lift, step, uvFn, col = null) {
    const nx = Math.max(1, Math.ceil((x1 - x0) / step)), ny = Math.max(1, Math.ceil((y1 - y0) / step));
    const base = g.v;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * j / ny;
        const [u, v] = uvFn(x, y);
        g.vert(x, y, map.heightAt(x, y) + lift, u, v, 0, 0, 1, col);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        g.quad(a, a + 1, a + nx + 2, a + nx + 1);
    }
}

// Vertical kerb strip along a line, from terrain to terrain+lift, facing (nx, ny).
function kerb(g, map, ax, ay, bx, by, lift, nx, ny, step) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    let prev = null;
    for (let i = 0; i <= n; i++) {
        const x = ax + (bx - ax) * i / n, y = ay + (by - ay) * i / n;
        const h = map.heightAt(x, y);
        const lo = g.vert(x, y, h - 0.05, i, 0, nx, ny, 0), hi = g.vert(x, y, h + lift, i, 0.05, nx, ny, 0);
        if (prev) g.quad(prev[0], lo, hi, prev[1]);
        prev = [lo, hi];
    }
}

// ---------------------------------------------------------------- colours
const COL = {
    city: new THREE.Color(0x77736b), suburb: new THREE.Color(0x5e8139), grass: new THREE.Color(0x5b7f35),
    wheat: new THREE.Color(0xb59f52), plough: new THREE.Color(0x6e553b), sand: new THREE.Color(0xd8c48f),
    wetSand: new THREE.Color(0x9f8d66), rock: new THREE.Color(0x7c776c), snow: new THREE.Color(0xeef0f2),
    forest: new THREE.Color(0x46612c),
};
const _col = new THREE.Color();

export function terrainColor(map, x, y, h, slope, out = _col) {
    const zone = map.zoneAt(x, y);
    if (h < 2.2 && map.shoreDist(x, y) < MC.beachWidth + 60) return out.copy(h < 0 ? COL.wetSand : COL.sand);
    if (h < map.waterLevel(x, y) + 0.6) return out.copy(COL.wetSand);
    if (y > MC.mountainY && (slope > 0.55 || h > 120)) return out.copy(h > 270 ? COL.snow : COL.rock);
    if (zone === 'city') return out.copy(COL.city);
    if (zone === 'suburb') return out.copy(COL.suburb);
    const f = map.noise3.noise(x / 260, y / 260);
    if (f > 0.42) out.copy(COL.wheat); else if (f < -0.5) out.copy(COL.plough);
    else out.copy(COL.grass).lerp(COL.forest, clamp(map.noise2.fbm(x / 1400 + 9, y / 1400 - 3, 2) * 2, 0, 1));
    return out;
}

function terrain(map, x0, y0, size, res, lower = 0) {
    const g = new Geo(true);
    const step = size / res;
    const e = 2;
    const vert = (x, y, zOff) => {
        const h = map.heightAt(x, y);
        const dx = (map.heightAt(x + e, y) - map.heightAt(x - e, y)) / (2 * e);
        const dy = (map.heightAt(x, y + e) - map.heightAt(x, y - e)) / (2 * e);
        const len = Math.hypot(dx, dy, 1);
        const col = terrainColor(map, x, y, h, Math.hypot(dx, dy));
        const z = h - lower - Math.max(0, h) * (lower ? 0.08 : 0) + zOff;
        return g.vert(x, y, z, x / 16, y / 16, -dx / len, -dy / len, 1 / len, col);
    };
    for (let j = 0; j <= res; j++) for (let i = 0; i <= res; i++) vert(x0 + i * step, y0 + j * step, 0);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const a = j * (res + 1) + i;
        g.quad(a, a + 1, a + res + 2, a + res + 1);
    }
    if (!lower) {
        // skirts hide cracks between neighbouring chunks of different LOD
        const skirt = (ids, pts) => {
            const low = pts.map(([x, y]) => vert(x, y, -6));
            for (let k = 0; k + 1 < ids.length; k++) { g.quad(ids[k], ids[k + 1], low[k + 1], low[k]); g.quad(ids[k + 1], ids[k], low[k], low[k + 1]); }
        };
        const row = (j) => Array.from({ length: res + 1 }, (_, i) => j * (res + 1) + i);
        const col = (i) => Array.from({ length: res + 1 }, (_, j) => j * (res + 1) + i);
        skirt(row(0), row(0).map((_, i) => [x0 + i * step, y0]));
        skirt(row(res), row(res).map((_, i) => [x0 + i * step, y0 + size]));
        skirt(col(0), col(0).map((_, j) => [x0, y0 + j * step]));
        skirt(col(res), col(res).map((_, j) => [x0 + size, y0 + j * step]));
    }
    return g.build();
}

// ------------------------------------------------------------------ roads
// Every road (straight grid road, flyover, curved ramp, mountain road) is a
// ribbon along its edge; each piece belongs to the chunk containing its
// midpoint. Heights come from map.roadHeight (decks, profiles or terrain).
function roads(map, d, lod) {
    const gCity = new Geo(), gCountry = new Geo(), gJ = new Geo(), gX = new Geo();
    const step = lod === 0 ? 8 : 32;
    const inChunk = (p) => p.x >= d.x0 && p.x < d.x1 && p.y >= d.y0 && p.y < d.y1;
    const P = {};
    for (const e of map.edgesInRect(d.x0, d.y0, d.x1, d.y1)) {
        const na = map.nodes[e.a], nb = map.nodes[e.b];
        const cutA = na.edges.length > 1 ? na.half : 0, cutB = nb.edges.length > 1 ? nb.half : 0;
        const s0 = cutA, s1 = e.len - cutB;
        if (s1 <= s0) continue;
        const g = e.type === 'city' || e.type === 'highway' ? gCity : gCountry;
        const lat = lod === 0 ? [-e.half, 0, e.half] : [-e.half, e.half];
        const L = lat.length;
        const n = Math.max(1, Math.ceil((s1 - s0) / step));
        let prev = -1;
        for (let k = 0; k < n; k++) {
            const a = s0 + (s1 - s0) * k / n, b = s0 + (s1 - s0) * (k + 1) / n;
            map.edgePoint(e, (a + b) / 2, 0, P);
            if (!inChunk(P)) { prev = -1; continue; }
            // emit the two rows (reuse the previous row when contiguous)
            const row = (s) => {
                const base = g.v;
                for (const dd of lat) {
                    map.edgePoint(e, s, dd, P);
                    g.vert(P.x, P.y, map.roadHeight(e, s, e.elev ? null : P.x, P.y) + 0.06, (dd + e.half) / (2 * e.half), s / 12);
                }
                return base;
            };
            const r0 = prev >= 0 ? prev : row(a);
            const r1 = row(b);
            for (let j = 0; j + 1 < L; j++) g.quad(r0 + j, r0 + j + 1, r1 + j + 1, r1 + j);
            prev = r1;
        }
        // zebra crossings in front of signalled junctions
        if (lod === 0) {
            for (const [nd, sA, dir] of [[na, s0, 1], [nb, s1, -1]]) {
                if (!nd.signal) continue;
                map.edgePoint(e, sA, 0, P);
                if (!inChunk(P)) continue;
                const ids = [];
                for (const ss of [sA, sA + dir * 4]) for (const dd of [-e.half, e.half]) {
                    map.edgePoint(e, ss, dd, P);
                    ids.push(gX.vert(P.x, P.y, map.roadHeight(e, ss, P.x, P.y) + 0.08, (dd + e.half) / 13, ss === sA ? 0 : 1));
                }
                gX.quad(ids[0], ids[1], ids[3], ids[2]);
            }
        }
    }
    for (const n of map.nodes) {
        if (n.x < d.x0 || n.x >= d.x1 || n.y < d.y0 || n.y >= d.y1 || n.edges.length < 2) continue;
        drape(gJ, map, n.x - n.half, n.y - n.half, n.x + n.half, n.y + n.half, 0.06, lod === 0 ? 8 : 20, (x, y) => [x / 10, y / 10]);
    }
    const m = worldMaterials();
    return [[gCity, m.roadCity], [gCountry, m.roadCountry], [gJ, m.asphalt], [gX, m.crosswalk]];
}

// Bridge / flyover decks: underside slab + parapets for every elevated piece,
// concrete pillars down to the ground.
function structures(map, d, lod) {
    const g = new Geo();
    const P = {}, Q = {};
    for (const st of d.structs) {
        const e = st.e;
        const corners = (s, side, out) => map.edgePoint(e, s, side * (e.half + 0.5), out);
        // underside: a slab 0.8 m thick under the deck, and its two side faces
        const a0 = corners(st.s0, -1, {}), a1 = corners(st.s0, 1, {}), b0 = corners(st.s1, -1, {}), b1 = corners(st.s1, 1, {});
        const zb0 = st.z0 - 0.85, zb1 = st.z1 - 0.85;
        let i = g.v;
        g.vert(a0.x, a0.y, zb0, 0, 0, 0, 0, -1); g.vert(b0.x, b0.y, zb1, 0, 1, 0, 0, -1); g.vert(b1.x, b1.y, zb1, 1, 1, 0, 0, -1); g.vert(a1.x, a1.y, zb0, 1, 0, 0, 0, -1);
        g.quad(i, i + 1, i + 2, i + 3);
        for (const [p0, p1, side] of [[a0, b0, -1], [a1, b1, 1]]) {
            const t = map.tangent(e, (st.s0 + st.s1) / 2), nx = t.y * side, ny = -t.x * side;
            i = g.v;
            // outer face from slab bottom to the parapet top
            g.vert(p0.x, p0.y, zb0, 0, 0, nx, ny, 0); g.vert(p1.x, p1.y, zb1, 1, 0, nx, ny, 0);
            g.vert(p1.x, p1.y, st.z1 + 1.0, 1, 1, nx, ny, 0); g.vert(p0.x, p0.y, st.z0 + 1.0, 0, 1, nx, ny, 0);
            if (side < 0) g.quad(i, i + 1, i + 2, i + 3); else g.quad(i + 1, i, i + 3, i + 2);
            if (lod === 0) {
                // inner face of the parapet
                corners(st.s0, side * 0.96, P); corners(st.s1, side * 0.96, Q);
                i = g.v;
                g.vert(P.x, P.y, st.z0, 0, 0, -nx, -ny, 0); g.vert(Q.x, Q.y, st.z1, 1, 0, -nx, -ny, 0);
                g.vert(Q.x, Q.y, st.z1 + 1.0, 1, 1, -nx, -ny, 0); g.vert(P.x, P.y, st.z0 + 1.0, 0, 1, -nx, -ny, 0);
                if (side < 0) g.quad(i + 1, i, i + 3, i + 2); else g.quad(i, i + 1, i + 2, i + 3);
                // parapet top
                i = g.v;
                g.vert(p0.x, p0.y, st.z0 + 1.0, 0, 0); g.vert(p1.x, p1.y, st.z1 + 1.0, 1, 0); g.vert(Q.x, Q.y, st.z1 + 1.0, 1, 1); g.vert(P.x, P.y, st.z0 + 1.0, 0, 1);
                if (side < 0) g.quad(i, i + 1, i + 2, i + 3); else g.quad(i + 1, i, i + 3, i + 2);
            }
        }
    }
    for (const p of d.pillars) box(g, p.x - 0.8, p.y - 0.8, p.x + 0.8, p.y + 0.8, p.z0, p.z1, 0.3, 0.3, null, { top: false });
    return g.build();
}

// River water surface in this chunk.
function riverWater(map, d) {
    const R = map.river, W = CONFIG.map.river.width / 2 + 6;
    if (d.x1 < R.bx0 || d.x0 > R.bx1 || d.y1 < R.by0 || d.y0 > R.by1) return null;
    const g = new Geo();
    const poly = R.poly, step = 12;
    let prev = -1;
    for (let s = 0; s < poly.len; s += step) {
        const s1 = Math.min(poly.len, s + step), m = poly.at((s + s1) / 2);
        if (m.x < d.x0 || m.x >= d.x1 || m.y < d.y0 || m.y >= d.y1) { prev = -1; continue; }
        const row = (ss) => {
            const p = poly.at(ss), z = R.waterZ(ss) - 0.05, base = g.v;
            g.vert(p.x - p.ty * W, p.y + p.tx * W, z, 0, ss / 20);
            g.vert(p.x + p.ty * W, p.y - p.tx * W, z, 1, ss / 20);
            return base;
        };
        const r0 = prev >= 0 ? prev : row(s), r1 = row(s1);
        g.quad(r0, r0 + 1, r1 + 1, r1);
        prev = r1;
    }
    return g.build();
}

// -------------------------------------------------------------- pavements
function pavements(map, d) {
    const g = new Geo(), gp = new Geo();
    const uv = (x, y) => [x / 3, y / 3];
    for (const b of d.blocks) {
        const L = 0.15;
        if (b.zone === 'city') drape(g, map, b.x0, b.y0, b.x1, b.y1, L, 25, uv);
        else {
            const s = b.sw;
            drape(g, map, b.x0, b.y0, b.x1, b.y0 + s, L, 24, uv);
            drape(g, map, b.x0, b.y1 - s, b.x1, b.y1, L, 24, uv);
            drape(g, map, b.x0, b.y0 + s, b.x0 + s, b.y1 - s, L, 24, uv);
            drape(g, map, b.x1 - s, b.y0 + s, b.x1, b.y1 - s, L, 24, uv);
        }
        kerb(g, map, b.x0, b.y0, b.x1, b.y0, L, 0, -1, 24);
        kerb(g, map, b.x1, b.y1, b.x0, b.y1, L, 0, 1, 24);
        kerb(g, map, b.x0, b.y1, b.x0, b.y0, L, -1, 0, 24);
        kerb(g, map, b.x1, b.y0, b.x1, b.y1, L, 1, 0, 24);
        for (const p of map.blockContent(b).parking) drape(gp, map, p.x0, p.y0, p.x1, p.y1, 0.17, 20, (x, y) => [x / 8, y / 8]);
    }
    const m = worldMaterials();
    return [[g, m.pavement], [gp, m.parking]];
}

// -------------------------------------------------------------- buildings
function footprintHeights(map, b) {
    const hs = [map.heightAt(b.x0, b.y0), map.heightAt(b.x1, b.y0), map.heightAt(b.x0, b.y1), map.heightAt(b.x1, b.y1)];
    return [Math.min(...hs), Math.max(...hs)];
}

const STYLE_TINT = {
    glass: new THREE.Color(0x9ab4cf), office: new THREE.Color(0xffffff), stone: new THREE.Color(0xeadcc0),
    brick: new THREE.Color(0xc48a70), house: new THREE.Color(0xe6dccb), shop: new THREE.Color(0xeadcc0),
    hospital: new THREE.Color(0xffffff), police: new THREE.Color(0xc48a70), farm: new THREE.Color(0xe6dccb), barn: new THREE.Color(0xa83a2c),
};
const FAC_U = 1 / 32, FAC_V = 1 / 28;          // facade texture: 8 bays x 4 m, 8 floors x 3.5 m

function buildingsNear(map, d, group) {
    const m = worldMaterials();
    const gs = new Map();
    const geo = (key) => { if (!gs.has(key)) gs.set(key, new Geo()); return gs.get(key); };
    const specials = [];
    for (const b of d.buildings) {
        const [lo, hi] = footprintHeights(map, b);
        const z0 = lo - 0.4, z1 = hi + b.h;
        if (b.style === 'house' || b.style === 'farm') {
            box(geo('house' + (b.variant || 0)), b.x0, b.y0, b.x1, b.y1, z0, z1, 1 / 8, 1 / 6, null, { top: false });
            gable(geo('houseRoof'), b.x0, b.y0, b.x1, b.y1, z1, 2.4, b.ridgeX);
        } else if (b.style === 'barn') {
            box(geo('barn'), b.x0, b.y0, b.x1, b.y1, z0, z1, 1, 1, null, { top: false });
            gable(geo('houseRoof'), b.x0, b.y0, b.x1, b.y1, z1, 4, b.ridgeX);
        } else {
            const style = b.style === 'shop' ? 'stone' : b.style === 'hospital' ? 'office' : b.style === 'police' ? 'brick' : b.style;
            box(geo('f:' + style), b.x0, b.y0, b.x1, b.y1, z0, z1, FAC_U, FAC_V, null, { top: false });
            box(geo('roof'), b.x0, b.y0, b.x1, b.y1, z0, z1, 1, 1, null, { sides: false });
            if (b.tier) {
                const t = b.tier;
                box(geo('f:' + style), t.x0, t.y0, t.x1, t.y1, z1, z1 + t.h, FAC_U, FAC_V, null, { top: false });
                box(geo('roof'), t.x0, t.y0, t.x1, t.y1, z1, z1 + t.h, 1, 1, null, { sides: false });
            }
            if (b.special) specials.push({ b, z0: lo, z1 });
        }
    }
    const matFor = (key) => key.startsWith('f:') ? m.facade[key.slice(2)] : key.startsWith('house') && key !== 'houseRoof' ? m.house[+key.slice(5)] : m[key];
    for (const [key, g] of gs) {
        const mesh = new THREE.Mesh(g.build(), matFor(key));
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
    }
    // signs, doors and shop windows of special buildings
    for (const { b, z0 } of specials) {
        const door = d.doors.find(dr => dr.x >= b.x0 - 2 && dr.x <= b.x1 + 2 && dr.y >= b.y0 - 2 && dr.y <= b.y1 + 2);
        if (!door) continue;
        const g = new THREE.Group();
        g.position.set(door.x - door.nx * 0.85, z0, -(door.y - door.ny * 0.85));
        g.rotation.y = yawFromNormal(door.nx, door.ny);   // local +z faces the street
        const signH = b.special === 'hospital' ? 14 : Math.min(b.h - 1.6, 5.2);
        const sign = new THREE.Mesh(SIGN_GEO, signMaterial(b.special));
        sign.position.set(0, signH, 0.12);
        if (b.special === 'hospital') sign.scale.set(1.6, 1.6, 1);
        const doorMesh = new THREE.Mesh(DOOR_GEO, DOOR_MAT);
        doorMesh.position.set(0, 1.4, 0.06);
        const frame = new THREE.Mesh(FRAME_GEO, signMaterial(b.special));
        frame.position.set(0, 2.95, 0.08);
        g.add(sign, doorMesh, frame);
        for (const side of [-1, 1]) {
            const win = new THREE.Mesh(WINDOW_GEO, WINDOW_MAT);
            win.position.set(side * 4.2, 1.9, 0.05);
            g.add(win);
        }
        group.add(g);
    }
}
function yawFromNormal(nx, ny) {
    // local +z (three) should point along the map-frame normal (nx, ny) -> three (nx, -ny)
    return Math.atan2(nx, -ny);
}
const SIGN_GEO = new THREE.PlaneGeometry(9, 1.9);
const DOOR_GEO = new THREE.PlaneGeometry(2.2, 2.8);
const FRAME_GEO = new THREE.PlaneGeometry(2.6, 0.25);
const WINDOW_GEO = new THREE.PlaneGeometry(4.6, 2.6);
const DOOR_MAT = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.3, metalness: 0.4 });
const WINDOW_MAT = new THREE.MeshStandardMaterial({ color: 0x3a4a58, emissive: 0xffe2b0, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.5 });

function buildingsFar(map, d, trees) {
    const g = new Geo(true);
    const roofCol = new THREE.Color(0x55524d);
    const topUv = () => [0.995, 0.995];
    for (const b of d.buildings) {
        const [lo, hi] = footprintHeights(map, b);
        const tint = STYLE_TINT[b.style] || WHITE;
        const z1 = hi + b.h;
        box(g, b.x0, b.y0, b.x1, b.y1, lo - 0.5, z1, FAC_U, FAC_V, tint, { topCol: roofCol, topUv });
        if (b.tier) box(g, b.tier.x0, b.tier.y0, b.tier.x1, b.tier.y1, z1, z1 + b.tier.h, FAC_U, FAC_V, tint, { topCol: roofCol, topUv });
        if (b.style === 'house' || b.style === 'farm' || b.style === 'barn') gable(g, b.x0, b.y0, b.x1, b.y1, z1, 2.4, b.ridgeX, roofCol);
    }
    // trees as simple coloured pyramids
    const leaf = new THREE.Color(0x3d5a26), pine = new THREE.Color(0x2c4420);
    for (const t of trees) {
        if (t.type === 'rock' || t.type === 'lamp') continue;
        const h = map.heightAt(t.x, t.y), s = (t.s || 1) * (t.type === 'pine' ? 1.3 : 1);
        const r = 2.4 * s, top = h + 9 * s;
        const col = t.type === 'pine' ? pine : leaf;
        const pts = [[t.x - r, t.y - r], [t.x + r, t.y - r], [t.x + r, t.y + r], [t.x - r, t.y + r]];
        for (let k = 0; k < 4; k++) {
            const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % 4];
            const nx = (ay - t.y + by - t.y), ny = -(ax - t.x + bx - t.x);
            const l = Math.hypot(nx, ny) || 1;
            const a = g.vert(ax, ay, h + 1.5 * s, 0.995, 0.995, ny / l * -1, nx / l, 0.5, col);
            const b2 = g.vert(bx, by, h + 1.5 * s, 0.995, 0.995, ny / l * -1, nx / l, 0.5, col);
            const c = g.vert(t.x, t.y, top, 0.995, 0.995, 0, 0, 1, col);
            g.i.push(a, b2, c, c, b2, a);
        }
    }
    const geo = g.build();
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, worldMaterials().farBuildings);
    return mesh;
}

// ------------------------------------------------------------------ props
const PROP_GEO = {};
function propGeos() {
    if (PROP_GEO.lamp) return PROP_GEO;
    const pole = new THREE.CylinderGeometry(0.08, 0.12, 7, 6); pole.translate(0, 3.5, 0);
    const arm = new THREE.BoxGeometry(1.8, 0.1, 0.1); arm.translate(0.9, 6.9, 0);
    PROP_GEO.lamp = mergeSimple([pole, arm]);
    PROP_GEO.lampHead = new THREE.BoxGeometry(0.7, 0.14, 0.32).translate(1.65, 6.82, 0);
    PROP_GEO.pool = new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2).translate(1.6, 0.25, 0);
    PROP_GEO.trunk = new THREE.CylinderGeometry(0.14, 0.24, 3, 6).translate(0, 1.5, 0);
    PROP_GEO.crown = new THREE.IcosahedronGeometry(2.1, 0).translate(0, 4.2, 0);
    PROP_GEO.pineCrown = new THREE.ConeGeometry(1.9, 6.5, 7).translate(0, 5.2, 0);
    PROP_GEO.palmTrunk = new THREE.CylinderGeometry(0.12, 0.2, 6.5, 6).translate(0, 3.25, 0);
    PROP_GEO.palmCrown = new THREE.ConeGeometry(2.6, 1.2, 7).translate(0, 6.6, 0);
    PROP_GEO.rock = new THREE.DodecahedronGeometry(1.2, 0).translate(0, 0.4, 0);
    return PROP_GEO;
}
function mergeSimple(list) {
    const pos = [], nor = [], uv = [];
    for (const g of list) {
        const ng = g.index ? g.toNonIndexed() : g;
        pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array); uv.push(...ng.attributes.uv.array);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function inst(geo, mat, items, fn, shadow = true, colorFn = null) {
    if (!items.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => {
        const [x, y, z, yaw, sx, sy, sz] = fn(it);
        _p.set(x, z, -y); _e.set(0, yaw, 0); _q.setFromEuler(_e); _s.set(sx, sy ?? sx, sz ?? sx);
        im.setMatrixAt(i, _m4.compose(_p, _q, _s));
        if (colorFn) im.setColorAt(i, colorFn(it, i));
    });
    im.castShadow = shadow; im.receiveShadow = false;
    im.computeBoundingSphere();
    return im;
}

function props(map, d, group) {
    const G = propGeos(), m = worldMaterials();
    const all = [...d.circles];
    const lamps = all.filter(p => p.type === 'lamp');
    const trees = all.filter(p => p.type === 'tree');
    const pines = all.filter(p => p.type === 'pine');
    const palms = all.filter(p => p.type === 'palm');
    const rocks = all.filter(p => p.type === 'rock');
    const h = (p) => map.heightAt(p.x, p.y) + (p.type === 'lamp' ? 0.15 : 0);
    // lamp arm points towards the road
    const lampYaw = (p) => Math.atan2(p.fy, p.fx);
    const add = (o) => { if (o) group.add(o); };
    add(inst(G.lamp, m.metal, lamps, p => [p.x, p.y, h(p), lampYaw(p), 1]));
    add(inst(G.lampHead, m.lampHead, lamps, p => [p.x, p.y, h(p), lampYaw(p), 1], false));
    add(inst(G.pool, m.lightPool, lamps, p => [p.x, p.y, h(p) - 0.15, lampYaw(p), 1], false));
    const rng = new Rng(hashSeed(d.cx, d.cy, 5));
    const leafCol = () => new THREE.Color().setHSL(0.22 + rng.range(-0.04, 0.05), 0.45, 0.24 + rng.range(-0.05, 0.06));
    add(inst(G.trunk, m.trunk, [...trees, ...pines], p => [p.x, p.y, h(p), 0, p.s || 1]));
    add(inst(G.crown, m.leaves, trees, p => [p.x, p.y, h(p), p.x, p.s || 1], true, leafCol));
    add(inst(G.pineCrown, m.leaves, pines, p => [p.x, p.y, h(p), 0, (p.s || 1) * 1.1], true, () => new THREE.Color().setHSL(0.3, 0.4, 0.16 + rng.range(-0.03, 0.04))));
    add(inst(G.palmTrunk, m.trunk, palms, p => [p.x, p.y, h(p), 0, p.s || 1]));
    add(inst(G.palmCrown, m.leaves, palms, p => [p.x, p.y, h(p), p.y, p.s || 1], true, () => new THREE.Color(0x4f7a2a)));
    add(inst(G.rock, m.rock, rocks, p => [p.x, p.y, h(p), p.x * 0.37, p.s || 1]));
}

// ---------------------------------------------------------------- public
export function buildChunk(map, cx, cy, lod) {
    const d = map.chunkData(cx, cy);
    const group = new THREE.Group();
    group.name = `chunk ${cx},${cy} lod${lod}`;
    const m = worldMaterials();
    const t = new THREE.Mesh(terrain(map, d.x0, d.y0, CHUNK, lod === 0 ? 24 : 8), m.terrain);
    t.receiveShadow = lod === 0;
    group.add(t);
    const parts = [...roads(map, d, lod)];
    if (lod === 0) parts.push(...pavements(map, d));
    if (d.structs.length || d.pillars.length) parts.push([{ build: () => structures(map, d, lod) }, m.concrete]);
    parts.push([{ build: () => riverWater(map, d) }, m.ocean]);
    for (const [g, mat] of parts) {
        const geo = g.build();
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = lod === 0;
        group.add(mesh);
    }
    if (lod === 0) {
        buildingsNear(map, d, group);
        props(map, d, group);
    } else {
        const far = buildingsFar(map, d, d.circles.filter(c => c.type !== 'lamp'));
        if (far) group.add(far);
    }
    group.traverse((o) => { if (o.isMesh) { o.matrixAutoUpdate = false; o.updateMatrix(); } });
    return group;
}

// One coarse mesh of the whole island, drawn beneath the streamed chunks so
// distant mountains and coastline are always visible.
export function buildHorizon(map) {
    const B = map.bounds, pad = 1200;
    const w = B.x1 - B.x0 + 2 * pad, h = B.y1 - B.y0 + 2 * pad;
    const g = terrainRect(map, B.x0 - pad, B.y0 - pad, w, h, Math.round(w / 85), Math.round(h / 85));
    const mesh = new THREE.Mesh(g, worldMaterials().horizon);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
}

// Coarse, lowered terrain for the horizon (rectangular, no skirts).
function terrainRect(map, x0, y0, w, h, nx, ny) {
    const g = new Geo(true);
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + w * i / nx, y = y0 + h * j / ny;
        const z = map.heightAt(x, y);
        g.vert(x, y, z - 3 - Math.max(0, z) * 0.08, 0, 0, 0, 0, 1, terrainColor(map, x, y, z, 0));
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; g.quad(a, a + 1, a + nx + 2, a + nx + 1); }
    const geo = g.build();
    geo.computeVertexNormals();
    return geo;
}

export function disposeChunk(group) {
    group.traverse((o) => {
        if (o.isMesh && o.geometry && !Object.values(PROP_GEO).includes(o.geometry) && o.geometry !== SIGN_GEO && o.geometry !== DOOR_GEO && o.geometry !== FRAME_GEO && o.geometry !== WINDOW_GEO) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
    });
}
