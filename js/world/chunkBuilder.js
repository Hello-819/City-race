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
function roads(map, d, lod) {
    const gCity = new Geo(), gCountry = new Geo(), gJ = new Geo(), gX = new Geo();
    const step = lod === 0 ? 10 : 40;
    for (const e of edgesInChunk(map, d)) {
        const na = map.nodes[e.a], nb = map.nodes[e.b];
        const cutA = na.edges.length > 1 ? na.half : 0, cutB = nb.edges.length > 1 ? nb.half : 0;
        const along0 = e.axis === 'x' ? d.y0 : d.x0, along1 = e.axis === 'x' ? d.y1 : d.x1;
        const t0 = Math.max(e.t0 + cutA, along0), t1 = Math.min(e.t1 - cutB, along1);
        if (t1 <= t0) continue;
        const g = e.type === 'city' || e.type === 'highway' ? gCity : gCountry;
        const n = Math.max(1, Math.ceil((t1 - t0) / step));
        const lat = lod === 0 ? [-e.half, 0, e.half] : [-e.half, e.half];
        const base = g.v;
        for (let k = 0; k <= n; k++) {
            const t = t0 + (t1 - t0) * k / n;
            for (const dd of lat) {
                const x = e.axis === 'x' ? e.c + dd : t, y = e.axis === 'x' ? t : e.c - dd;
                g.vert(x, y, map.heightAt(x, y) + 0.06, (dd + e.half) / (2 * e.half), t / 12);
            }
        }
        const L = lat.length;
        for (let k = 0; k < n; k++) for (let j = 0; j + 1 < L; j++) {
            const a = base + k * L + j;
            // winding must face up for both axes
            g.quad(a, a + 1, a + L + 1, a + L);
        }
        // zebra crossings in front of signalled junctions
        if (lod === 0) {
            for (const [nd, t, dir] of [[na, e.t0 + cutA, 1], [nb, e.t1 - cutB, -1]]) {
                if (!nd.signal || t < along0 || t > along1) continue;
                const ta = t, tb = t + dir * 4;
                const pts = [];
                for (const tt of [ta, tb]) for (const dd of [-e.half, e.half]) {
                    const x = e.axis === 'x' ? e.c + dd : tt, y = e.axis === 'x' ? tt : e.c - dd;
                    pts.push(gX.vert(x, y, map.heightAt(x, y) + 0.08, (dd + e.half) / (2 * e.half) * (2 * e.half / 13), tt === ta ? 0 : 1));
                }
                if ((e.axis === 'x') === (dir > 0)) gX.quad(pts[0], pts[1], pts[3], pts[2]); else gX.quad(pts[1], pts[0], pts[2], pts[3]);
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

export function edgesInChunk(map, d) {
    const out = [];
    const seen = new Set();
    for (let x = d.x0; x <= d.x1; x += 60) for (let y = d.y0; y <= d.y1; y += 60) {
        for (const id of map.edgesNear(Math.min(x, d.x1 - 1), Math.min(y, d.y1 - 1))) {
            if (seen.has(id)) continue; seen.add(id);
            const e = map.edges[id];
            const perp0 = e.axis === 'x' ? d.x0 : d.y0, perp1 = e.axis === 'x' ? d.x1 : d.y1;
            if (e.c < perp0 || e.c >= perp1) continue;
            const a0 = e.axis === 'x' ? d.y0 : d.x0, a1 = e.axis === 'x' ? d.y1 : d.x1;
            if (e.t1 < a0 || e.t0 > a1) continue;
            out.push(e);
        }
    }
    return out;
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
    const size = MC.size + 2000, res = 120;
    const geo = terrain(map, -size / 2, -size / 2, size, res, 3);
    const mesh = new THREE.Mesh(geo, worldMaterials().horizon);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
}

export function disposeChunk(group) {
    group.traverse((o) => {
        if (o.isMesh && o.geometry && !Object.values(PROP_GEO).includes(o.geometry) && o.geometry !== SIGN_GEO && o.geometry !== DOOR_GEO && o.geometry !== FRAME_GEO && o.geometry !== WINDOW_GEO) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
    });
}
