// ============================================================================
// GameMap: the deterministic layout of the whole island.
//
// Nothing here creates meshes. It answers questions about the world:
//   - heightAt / surfaceAt(x, y)     terrain height, road / pavement / water
//   - the road GRAPH (nodes = junctions, edges = road pieces) used by AI
//   - blocks (city / suburb plots) and their buildings, props and doors
//   - collidersNear(x, y, r)         static AABBs + circles for physics
//
// Coordinates are the 2D "map frame": x east, y north, z up.
// Three.js space is (x, z, -y).
//
// Layout (all sizes in CONFIG.map):
//   downtown grid (120 m blocks) -> suburbs (240 m blocks) -> countryside
//   (960 m grid) -> highway ring -> beaches / ocean, mountains to the north.
// ============================================================================
import { CONFIG } from '../config.js';
import { Rng, Simplex, hashSeed, clamp, smoothstep, lerp } from '../core/rng.js';

const C = CONFIG.map;
const CHUNK = CONFIG.streaming.chunkSize;
const EDGE_CELL = 60;

export const ZONE = { CITY: 'city', SUBURB: 'suburb', COUNTRY: 'country' };

// Shop / service building types. Counts are tuned in CONFIG.shops (step 4);
// these defaults are used when that section is missing.
const DEFAULT_SPECIALS = { hospital: 4, police: 3, gun: 5, clothes: 6, dealership: 3, convenience: 10, cafe: 8 };

export class GameMap {
    constructor(seed = C.seed) {
        this.seed = seed;
        this.half = C.size / 2;
        this.noise = new Simplex(seed);
        this.noise2 = new Simplex(seed + 101);
        this.noise3 = new Simplex(seed + 202);
        this._buildRoads();
        this._buildBlocks();
        this._placeSpecials();
        this.chunkCache = new Map();
    }

    // ------------------------------------------------------------------ zones
    zoneAt(x, y) {
        const m = Math.max(Math.abs(x), Math.abs(y));
        if (m <= C.cityHalf) return ZONE.CITY;
        if (m <= C.suburbHalf) return ZONE.SUBURB;
        return ZONE.COUNTRY;
    }

    // Distance (m) inland from the coastline; negative = out at sea.
    shoreDist(x, y) {
        const ax = Math.abs(x), ay = Math.abs(y);
        const r = Math.pow(ax ** 4 + ay ** 4, 0.25);
        const coast = C.coastRadius + this.noise2.fbm(x / 900, y / 900, 3) * C.coastNoise;
        return coast - r;
    }

    // Terrain height (m) at a point. Smooth, cheap, deterministic.
    heightAt(x, y) {
        const shore = this.shoreDist(x, y);
        if (shore < -420) return -26;
        const m = Math.max(Math.abs(x), Math.abs(y));
        const a1 = smoothstep(C.cityHalf - 100, C.cityHalf + 300, m);
        const a2 = smoothstep(C.suburbHalf - 100, C.suburbHalf + 400, m);
        const amp = lerp(lerp(C.hills.city, C.hills.suburb, a1), C.hills.country, a2);
        let h = C.landBase + amp * (0.5 + 0.5 * this.noise.fbm(x / 760, y / 760, 3));
        // mountains along the north coast form a natural map edge
        const mt = smoothstep(C.mountainY, C.mountainY + 450, y);
        if (mt > 0) h += mt * (30 + C.mountainHeight * this.noise3.ridged(x / 650, y / 650, 4));
        // beaches: blend down to just below sea level at the coast, then deep water
        const beach = smoothstep(-40, C.beachWidth, shore);
        h = lerp(-2.2, h, beach);
        if (shore < 0) h = lerp(h, -26, smoothstep(0, -380, shore));
        return h;
    }

    // Height of whatever you stand on (terrain + road / kerb), plus surface type.
    // out: { h, kind: 'road'|'pavement'|'grass'|'sand'|'rock'|'water', water: depth }
    surfaceAt(x, y, out = {}) {
        let h = this.heightAt(x, y);
        let kind = 'grass';
        const r = this.roadAt(x, y);
        if (r) { h += 0.06; kind = 'road'; }
        else {
            const b = this.blockAt(x, y);
            if (b && this._onPavement(b, x, y)) { h += 0.15; kind = 'pavement'; }
            else if (h < 1.6 && this.shoreDist(x, y) < C.beachWidth + 40) kind = 'sand';
            else if (y > C.mountainY + 150 && h > 60) kind = 'rock';
        }
        out.h = h;
        out.kind = kind;
        out.water = Math.max(0, C.seaLevel - h);
        if (out.water > 0.3 && kind !== 'road') out.kind = 'water';
        return out;
    }

    _onPavement(b, x, y) {
        if (b.zone === ZONE.CITY) return true;    // whole city block is paved plaza
        return x < b.x0 + b.sw || x > b.x1 - b.sw || y < b.y0 + b.sw || y > b.y1 - b.sw;
    }

    // ------------------------------------------------------------------ roads
    // Roads are axis-aligned "lines": axis 'x' = constant x (runs north-south).
    _buildRoads() {
        const lines = { x: new Map(), y: new Map() };
        const add = (axis, c, a0, a1) => {
            const m = lines[axis];
            if (!m.has(c)) m.set(c, []);
            m.get(c).push([a0, a1]);
        };
        const grid = (half, step, span) => {
            for (let c = -half; c <= half + 1e-6; c += step) { add('x', c, -span, span); add('y', c, -span, span); }
        };
        grid(C.cityHalf, C.cityBlock, C.cityHalf);
        grid(C.suburbHalf, C.suburbBlock, C.suburbHalf);
        for (let c = -C.ring; c <= C.ring + 1e-6; c += C.countrySpacing) { add('x', c, -C.ring, C.ring); add('y', c, -C.ring, C.ring); }
        // beach spurs: south, east and west (north is mountains)
        add('x', 0, -C.spurEnd, -C.ring);
        add('y', 0, C.ring, C.spurEnd);
        add('y', 0, -C.spurEnd, -C.ring);
        // merge overlapping intervals per line
        for (const axis of ['x', 'y']) {
            for (const [c, list] of lines[axis]) {
                list.sort((a, b) => a[0] - b[0]);
                const out = [];
                for (const iv of list) {
                    const last = out[out.length - 1];
                    if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
                    else out.push([iv[0], iv[1]]);
                }
                lines[axis].set(c, out);
            }
        }
        this.lines = lines;

        // nodes at every crossing and line end
        this.nodes = [];
        this.edges = [];
        const nodeKey = new Map();
        const node = (x, y) => {
            const k = Math.round(x) + ',' + Math.round(y);
            let n = nodeKey.get(k);
            if (!n) { n = { id: this.nodes.length, x, y, edges: [], half: 0, signal: false }; this.nodes.push(n); nodeKey.set(k, n); }
            return n;
        };
        const covers = (axis, c, t) => {
            const ivs = lines[axis].get(c);
            if (!ivs) return false;
            for (const [a, b] of ivs) if (t >= a - 1e-6 && t <= b + 1e-6) return true;
            return false;
        };
        for (const axis of ['x', 'y']) {
            const other = axis === 'x' ? 'y' : 'x';
            const crossCs = [...lines[other].keys()].sort((a, b) => a - b);
            for (const [c, ivs] of lines[axis]) {
                for (const [a0, a1] of ivs) {
                    const stops = [a0, a1];
                    for (const c2 of crossCs) if (c2 > a0 + 1e-6 && c2 < a1 - 1e-6 && covers(other, c2, c)) stops.push(c2);
                    stops.sort((a, b) => a - b);
                    for (let i = 0; i + 1 < stops.length; i++) {
                        const t0 = stops[i], t1 = stops[i + 1];
                        if (t1 - t0 < 1) continue;
                        const P = (t) => axis === 'x' ? [c, t] : [t, c];
                        const na = node(...P(t0)), nb = node(...P(t1));
                        const type = this._roadType(axis, c, (t0 + t1) / 2);
                        const R = CONFIG.roads[type];
                        const e = {
                            id: this.edges.length, a: na.id, b: nb.id, axis, c, t0, t1, len: t1 - t0,
                            type, half: R.half, lanes: R.lanes, laneW: R.laneW, speed: R.speed, sidewalk: R.sidewalk,
                            // unit direction a->b in map frame
                            ux: axis === 'x' ? 0 : 1, uy: axis === 'x' ? 1 : 0,
                        };
                        this.edges.push(e);
                        na.edges.push(e.id); nb.edges.push(e.id);
                    }
                }
            }
        }
        for (const n of this.nodes) {
            for (const id of n.edges) n.half = Math.max(n.half, this.edges[id].half);
            // traffic lights at busy junctions in town
            const zone = this.zoneAt(n.x, n.y);
            n.signal = n.edges.length >= 3 && (zone === ZONE.CITY || n.edges.some(id => this.edges[id].type === 'city'));
            n.phase = (hashSeed(n.id, this.seed) % 1000) / 1000;
        }
        // spatial index of edges (cell -> edge ids)
        this.edgeGrid = new Map();
        for (const e of this.edges) {
            const [x0, y0, x1, y1] = this.edgeRect(e, e.half + 4);
            for (let gx = Math.floor(x0 / EDGE_CELL); gx <= Math.floor(x1 / EDGE_CELL); gx++) {
                for (let gy = Math.floor(y0 / EDGE_CELL); gy <= Math.floor(y1 / EDGE_CELL); gy++) {
                    const k = gx * 100003 + gy;
                    if (!this.edgeGrid.has(k)) this.edgeGrid.set(k, []);
                    this.edgeGrid.get(k).push(e.id);
                }
            }
        }
    }

    _roadType(axis, c, t) {
        if (Math.abs(Math.abs(c) - C.ring) < 1 && Math.abs(t) <= C.ring) return 'highway';
        const m = Math.max(Math.abs(c), Math.abs(t));
        if (c === 0 && m <= C.ring) return 'city';            // the two cross-island avenues
        if (m <= C.cityHalf + 1e-6) return 'city';
        if (m <= C.suburbHalf + 1e-6) return 'suburb';
        return 'country';
    }

    // Axis-aligned rect covered by an edge (map frame), expanded by `pad` across.
    edgeRect(e, pad = 0) {
        return e.axis === 'x' ? [e.c - pad, e.t0, e.c + pad, e.t1] : [e.t0, e.c - pad, e.t1, e.c + pad];
    }

    // Point on an edge: along distance s from node a, lateral offset d (+ = right of a->b).
    edgePoint(e, s, d, out = {}) {
        const t = e.t0 + s;
        // right of direction (ux, uy) is (uy, -ux)
        if (e.axis === 'x') { out.x = e.c + d; out.y = t; } else { out.x = t; out.y = e.c - d; }
        return out;
    }

    edgesNear(x, y) { return this.edgeGrid.get(Math.floor(x / EDGE_CELL) * 100003 + Math.floor(y / EDGE_CELL)) || EMPTY; }

    // Road under a point (including junction squares) or null.
    // Returns { edge, s (along from a), d (signed lateral, + right of a->b) }.
    roadAt(x, y, pad = 0, out = _road) {
        for (const id of this.edgesNear(x, y)) {
            const e = this.edges[id];
            let t, d;
            if (e.axis === 'x') { t = y; d = x - e.c; } else { t = x; d = e.c - y; }
            if (Math.abs(d) > e.half + pad) continue;
            if (t < e.t0 - e.half - pad || t > e.t1 + e.half + pad) continue;
            out.edge = e; out.s = t - e.t0; out.d = d;
            return out;
        }
        return null;
    }

    // Nearest point on any road lane (used for spawning / respawning cars).
    nearestRoad(x, y, maxR = 300) {
        let best = null, bd = Infinity;
        const r = Math.ceil(maxR / EDGE_CELL);
        const gx0 = Math.floor(x / EDGE_CELL), gy0 = Math.floor(y / EDGE_CELL);
        const seen = new Set();
        for (let gx = gx0 - r; gx <= gx0 + r; gx++) for (let gy = gy0 - r; gy <= gy0 + r; gy++) {
            for (const id of this.edgeGrid.get(gx * 100003 + gy) || EMPTY) {
                if (seen.has(id)) continue; seen.add(id);
                const e = this.edges[id];
                const s = clamp((e.axis === 'x' ? y : x) - e.t0, 0, e.len);
                const p = this.edgePoint(e, s, 0);
                const dd = (p.x - x) ** 2 + (p.y - y) ** 2;
                if (dd < bd) { bd = dd; best = { edge: e, s, x: p.x, y: p.y, dist: Math.sqrt(dd) }; }
            }
        }
        return best;
    }

    // ----------------------------------------------------------------- blocks
    // A block is the plot between four roads (road edge to road edge).
    _buildBlocks() {
        this.blocks = [];
        this.blockGrid = new Map();      // chunk key -> blocks
        const make = (cx0, cy0, cx1, cy1, zone) => {
            const halfOf = (axis, c, mid) => CONFIG.roads[this._roadType(axis, c, mid)].half;
            const midX = (cx0 + cx1) / 2, midY = (cy0 + cy1) / 2;
            const b = {
                id: this.blocks.length, zone,
                ox0: cx0, oy0: cy0, ox1: cx1, oy1: cy1,
                x0: cx0 + halfOf('x', cx0, midY), x1: cx1 - halfOf('x', cx1, midY),
                y0: cy0 + halfOf('y', cy0, midX), y1: cy1 - halfOf('y', cy1, midX),
                sw: zone === ZONE.CITY ? CONFIG.roads.city.sidewalk : CONFIG.roads.suburb.sidewalk,
                seed: hashSeed(Math.round(cx0), Math.round(cy0), this.seed),
                special: null,
            };
            this.blocks.push(b);
            const k = this.chunkKey(Math.floor((cx0 + 1) / CHUNK), Math.floor((cy0 + 1) / CHUNK));
            if (!this.blockGrid.has(k)) this.blockGrid.set(k, []);
            this.blockGrid.get(k).push(b);
        };
        for (let x = -C.cityHalf; x < C.cityHalf - 1; x += C.cityBlock)
            for (let y = -C.cityHalf; y < C.cityHalf - 1; y += C.cityBlock) make(x, y, x + C.cityBlock, y + C.cityBlock, ZONE.CITY);
        for (let x = -C.suburbHalf; x < C.suburbHalf - 1; x += C.suburbBlock)
            for (let y = -C.suburbHalf; y < C.suburbHalf - 1; y += C.suburbBlock) {
                if (x >= -C.cityHalf && x < C.cityHalf && y >= -C.cityHalf && y < C.cityHalf) continue;
                make(x, y, x + C.suburbBlock, y + C.suburbBlock, ZONE.SUBURB);
            }
    }

    chunkKey(cx, cy) { return cx * 4096 + cy; }

    blockAt(x, y) {
        const list = this.blockGrid.get(this.chunkKey(Math.floor(x / CHUNK), Math.floor(y / CHUNK)));
        if (!list) return null;
        for (const b of list) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b;
        return null;
    }

    // Choose which blocks hold shops, hospitals and police stations.
    _placeSpecials() {
        const counts = (CONFIG.shops && CONFIG.shops.counts) || DEFAULT_SPECIALS;
        const rng = new Rng(this.seed ^ 0x51ec1a1);
        const cands = this.blocks.slice();
        for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rng.float() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
        // spread the city ones first so every type exists near the start
        const key = new Map(cands.map(b => [b, (b.zone === ZONE.CITY ? 0 : 1) + rng.float() * 1.2]));
        cands.sort((a, b) => key.get(a) - key.get(b));
        this.specials = [];
        const order = Object.entries(counts).flatMap(([type, n]) => Array.from({ length: n }, (_, i) => ({ type, i })));
        // interleave types so they are spread evenly
        order.sort((a, b) => a.i - b.i);
        for (const { type } of order) {
            const minD = type === 'convenience' || type === 'cafe' ? 450 : 900;
            const b = cands.find(bl => !bl.special && !(bl.zone === ZONE.CITY && Math.hypot(bl.x0, bl.y0) < 160) &&
                this.specials.every(s => s.type !== type || Math.hypot(s.block.x0 - bl.x0, s.block.y0 - bl.y0) > minD));
            if (!b) continue;
            b.special = { type, side: rng.int(0, 3) };
            this.specials.push({ type, block: b });
        }
    }

    // Deterministic contents of a block: buildings, props and doors.
    blockContent(b) {
        if (b.content) return b.content;
        const rng = new Rng(b.seed);
        const out = { buildings: [], props: [], doors: [], parking: [] };
        const sw = b.sw;
        // lamps + trees along the kerb
        const kerb = 0.7;
        const edges = [
            [b.x0 + kerb, b.y0 + kerb, b.x1 - kerb, b.y0 + kerb],
            [b.x0 + kerb, b.y1 - kerb, b.x1 - kerb, b.y1 - kerb],
            [b.x0 + kerb, b.y0 + kerb, b.x0 + kerb, b.y1 - kerb],
            [b.x1 - kerb, b.y0 + kerb, b.x1 - kerb, b.y1 - kerb],
        ];
        const lampStep = b.zone === ZONE.CITY ? 30 : 40;
        for (const [ax, ay, bx, by] of edges) {
            const len = Math.hypot(bx - ax, by - ay);
            for (let s = 10; s < len - 6; s += lampStep) {
                const t = s / len;
                const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
                // facing: towards the road (outwards from the block)
                const fx = x <= b.x0 + 1 ? -1 : x >= b.x1 - 1 ? 1 : 0, fy = y <= b.y0 + 1 ? -1 : y >= b.y1 - 1 ? 1 : 0;
                out.props.push({ type: 'lamp', x, y, r: 0.22, fx, fy });
                if (b.zone === ZONE.CITY && rng.chance(0.6) && s + lampStep / 2 < len - 6) {
                    const t2 = (s + lampStep / 2) / len;
                    out.props.push({ type: 'tree', x: ax + (bx - ax) * t2, y: ay + (by - ay) * t2, r: 0.35, s: rng.range(0.8, 1.15) });
                }
            }
        }
        if (b.zone === ZONE.CITY) this._cityBlock(b, rng, out);
        else this._suburbBlock(b, rng, out);
        b.content = out;
        return out;
    }

    // Special building (shop / hospital / police) on side `side` of the area.
    _special(b, rng, out, area) {
        const S = b.special;
        const dims = { hospital: [44, 30, 22], police: [32, 24, 12], dealership: [34, 24, 9], gun: [18, 14, 7], clothes: [22, 16, 8], convenience: [18, 14, 6], cafe: [16, 12, 6] }[S.type];
        const [w, d, h] = dims;
        const [ax0, ay0, ax1, ay1] = area;
        const mx = (ax0 + ax1) / 2, my = (ay0 + ay1) / 2;
        let x0, y0, x1, y1, door;
        // side: 0 south, 1 north, 2 west, 3 east (the street the door faces)
        if (S.side === 0) { x0 = mx - w / 2; x1 = mx + w / 2; y0 = ay0; y1 = ay0 + d; door = { x: mx, y: ay0 - 0.9, nx: 0, ny: -1 }; }
        else if (S.side === 1) { x0 = mx - w / 2; x1 = mx + w / 2; y1 = ay1; y0 = ay1 - d; door = { x: mx, y: ay1 + 0.9, nx: 0, ny: 1 }; }
        else if (S.side === 2) { y0 = my - w / 2; y1 = my + w / 2; x0 = ax0; x1 = ax0 + d; door = { x: ax0 - 0.9, y: my, nx: -1, ny: 0 }; }
        else { y0 = my - w / 2; y1 = my + w / 2; x1 = ax1; x0 = ax1 - d; door = { x: ax1 + 0.9, y: my, nx: 1, ny: 0 }; }
        const bld = { x0, y0, x1, y1, h, style: S.type === 'hospital' ? 'hospital' : S.type === 'police' ? 'police' : 'shop', special: S.type };
        out.buildings.push(bld);
        door.type = S.type; door.id = 'door-' + b.id; door.blockId = b.id;
        out.doors.push(door);
        S.door = door;
        // dealership: a forecourt of cars for sale in front of the showroom
        return bld;
    }

    _cityBlock(b, rng, out) {
        const sw = b.sw;
        const ax0 = b.x0 + sw, ay0 = b.y0 + sw, ax1 = b.x1 - sw, ay1 = b.y1 - sw;
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        const dist = Math.hypot(cx, cy);
        let specialBld = null;
        if (b.special) specialBld = this._special(b, rng, out, [ax0, ay0, ax1, ay1]);
        // park blocks: trees and a pond-less plaza
        if (!b.special && rng.chance(0.07) && dist > 200) {
            for (let i = 0; i < 26; i++) out.props.push({ type: 'tree', x: rng.range(ax0 + 3, ax1 - 3), y: rng.range(ay0 + 3, ay1 - 3), r: 0.4, s: rng.range(1, 1.6) });
            return;
        }
        const nx = rng.int(1, 3), ny = rng.int(1, 3);
        const gap = rng.range(3, 6);
        const lw = (ax1 - ax0 - gap * (nx - 1)) / nx, lh = (ay1 - ay0 - gap * (ny - 1)) / ny;
        const down = dist < C.downtownRadius;
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            const x0 = ax0 + i * (lw + gap), y0 = ay0 + j * (lh + gap);
            const x1 = x0 + lw, y1 = y0 + lh;
            if (specialBld && x0 < specialBld.x1 + 2 && x1 > specialBld.x0 - 2 && y0 < specialBld.y1 + 2 && y1 > specialBld.y0 - 2) continue;
            if (!down && rng.chance(0.08)) {   // surface car park
                out.parking.push({ x0, y0, x1, y1 });
                continue;
            }
            let h;
            if (down) h = lerp(C.towerHeight[1], C.towerHeight[0], dist / C.downtownRadius) * rng.range(0.55, 1.1);
            else h = rng.range(C.midriseHeight[0], C.midriseHeight[1]) * lerp(1, 0.6, clamp((dist - 500) / 800, 0, 1));
            const style = down ? rng.pick(['glass', 'glass', 'office']) : rng.pick(['office', 'stone', 'brick', 'brick', 'glass']);
            const inset = rng.range(0, 3);
            const bld = { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset, h, style };
            // a setback tier on tall towers
            if (h > 70 && rng.chance(0.6)) {
                const k = rng.range(0.15, 0.3);
                const w = bld.x1 - bld.x0, d = bld.y1 - bld.y0;
                bld.tier = { x0: bld.x0 + w * k, y0: bld.y0 + d * k, x1: bld.x1 - w * k, y1: bld.y1 - d * k, h: h * rng.range(0.15, 0.4) };
            }
            out.buildings.push(bld);
        }
    }

    _suburbBlock(b, rng, out) {
        const sw = b.sw;
        const ax0 = b.x0 + sw, ay0 = b.y0 + sw, ax1 = b.x1 - sw, ay1 = b.y1 - sw;
        let specialBld = null;
        if (b.special) specialBld = this._special(b, rng, out, [ax0 + 2, ay0 + 2, ax1 - 2, ay1 - 2]);
        const lot = 24, depth = 34;
        const sides = [
            { s: 0, len: ax1 - ax0 }, { s: 1, len: ax1 - ax0 }, { s: 2, len: ay1 - ay0 }, { s: 3, len: ay1 - ay0 },
        ];
        const variant = rng.int(0, 5);
        for (const { s, len } of sides) {
            const n = Math.floor((len - 2 * depth) / lot);
            const start = (len - n * lot) / 2;
            for (let k = 0; k < n; k++) {
                if (rng.chance(0.12)) continue;
                const a = start + k * lot + lot / 2;
                const hw = rng.range(5, 7), hd = rng.range(4.5, 6);
                const set = rng.range(6, 10);
                let x0, y0, x1, y1, fx = 0, fy = 0;
                if (s === 0) { x0 = ax0 + a - hw; x1 = ax0 + a + hw; y0 = ay0 + set; y1 = y0 + hd * 2; fy = -1; }
                else if (s === 1) { x0 = ax0 + a - hw; x1 = ax0 + a + hw; y1 = ay1 - set; y0 = y1 - hd * 2; fy = 1; }
                else if (s === 2) { y0 = ay0 + a - hw; y1 = ay0 + a + hw; x0 = ax0 + set; x1 = x0 + hd * 2; fx = -1; }
                else { y0 = ay0 + a - hw; y1 = ay0 + a + hw; x1 = ax1 - set; x0 = x1 - hd * 2; fx = 1; }
                if (specialBld && x0 < specialBld.x1 + 4 && x1 > specialBld.x0 - 4 && y0 < specialBld.y1 + 4 && y1 > specialBld.y0 - 4) continue;
                out.buildings.push({ x0, y0, x1, y1, h: rng.chance(0.3) ? 7.5 : 4.2, style: 'house', variant: (variant + k) % 6, ridgeX: s < 2, fx, fy });
                // a tree in the front yard
                if (rng.chance(0.6)) {
                    const tx = s < 2 ? (x0 + x1) / 2 + rng.range(-8, 8) : (s === 2 ? ax0 + 3 : ax1 - 3);
                    const ty = s < 2 ? (s === 0 ? ay0 + 3 : ay1 - 3) : (y0 + y1) / 2 + rng.range(-8, 8);
                    out.props.push({ type: 'tree', x: tx, y: ty, r: 0.35, s: rng.range(0.8, 1.3) });
                }
            }
        }
        // the middle of the block: back gardens / small park with trees
        const ix0 = ax0 + depth + 4, ix1 = ax1 - depth - 4, iy0 = ay0 + depth + 4, iy1 = ay1 - depth - 4;
        const nTrees = rng.int(8, 30);
        for (let i = 0; i < nTrees; i++) {
            const x = rng.range(ix0, ix1), y = rng.range(iy0, iy1);
            if (specialBld && x > specialBld.x0 - 3 && x < specialBld.x1 + 3 && y > specialBld.y0 - 3 && y < specialBld.y1 + 3) continue;
            out.props.push({ type: 'tree', x, y, r: 0.4, s: rng.range(0.9, 1.6) });
        }
    }

    // -------------------------------------------------------- chunk contents
    // Deterministic per-chunk data: blocks + countryside scatter + colliders.
    chunkData(cx, cy) {
        const key = this.chunkKey(cx, cy);
        let d = this.chunkCache.get(key);
        if (d) { d.used = performance.now(); return d; }
        d = { cx, cy, key, x0: cx * CHUNK, y0: cy * CHUNK, x1: (cx + 1) * CHUNK, y1: (cy + 1) * CHUNK, blocks: [], scatter: [], buildings: [], boxes: [], circles: [], doors: [], used: performance.now() };
        for (const b of this.blockGrid.get(key) || EMPTY) {
            d.blocks.push(b);
            const c = this.blockContent(b);
            for (const bl of c.buildings) { d.buildings.push(bl); d.boxes.push(bl); }
            for (const p of c.props) d.circles.push(p);
            for (const dr of c.doors) d.doors.push(dr);
        }
        if (!d.blocks.length) this._scatter(d);
        for (const p of d.scatter) if (p.r) d.circles.push(p);
        for (const bl of d.buildings) if (bl.style === 'farm' || bl.style === 'barn') d.boxes.push(bl);
        this.chunkCache.set(key, d);
        if (this.chunkCache.size > CONFIG.streaming.maxCachedData) {
            // drop the least recently used half
            const arr = [...this.chunkCache.values()].sort((a, b) => a.used - b.used);
            for (let i = 0; i < arr.length / 2; i++) this.chunkCache.delete(arr[i].key);
        }
        return d;
    }

    // Countryside / beach / mountain scatter for chunks without blocks.
    _scatter(d) {
        const rng = new Rng(hashSeed(d.cx, d.cy, this.seed, 77));
        const midX = (d.x0 + d.x1) / 2, midY = (d.y0 + d.y1) / 2;
        if (this.shoreDist(midX, midY) < -200) return;
        const forest = this.noise2.fbm(midX / 1400 + 9, midY / 1400 - 3, 2);
        const mountain = midY > C.mountainY + 100;
        let n = Math.round(clamp(10 + forest * 90, 4, 90) * (mountain ? 1.3 : 1));
        if (Math.max(Math.abs(midX), Math.abs(midY)) < C.suburbHalf + 100) n = Math.round(n * 0.4);
        for (let i = 0; i < n; i++) {
            const x = rng.range(d.x0 + 2, d.x1 - 2), y = rng.range(d.y0 + 2, d.y1 - 2);
            if (this.roadAt(x, y, 5)) continue;
            const h = this.heightAt(x, y);
            if (h < 1.5) continue;
            const pine = mountain || forest > 0.25 || rng.chance(0.35);
            if (mountain && h > C.mountainHeight * 0.75) { if (rng.chance(0.4)) d.scatter.push({ type: 'rock', x, y, r: 1.2, s: rng.range(1, 2.6) }); continue; }
            d.scatter.push({ type: pine ? 'pine' : 'tree', x, y, r: 0.35, s: rng.range(0.9, 1.7) });
        }
        // beach palms
        const shore = this.shoreDist(midX, midY);
        if (shore > -60 && shore < C.beachWidth + 60) {
            for (let i = 0; i < 6; i++) {
                const x = rng.range(d.x0, d.x1), y = rng.range(d.y0, d.y1);
                const h = this.heightAt(x, y);
                if (h > 0.4 && h < 3 && !this.roadAt(x, y, 4)) d.scatter.push({ type: 'palm', x, y, r: 0.3, s: rng.range(0.9, 1.3) });
            }
        }
        // occasional farm (house + barn)
        if (!mountain && rng.chance(0.18) && Math.max(Math.abs(midX), Math.abs(midY)) > C.suburbHalf + 200) {
            const x = rng.range(d.x0 + 40, d.x1 - 40), y = rng.range(d.y0 + 40, d.y1 - 40);
            if (!this.roadAt(x, y, 30) && this.heightAt(x, y) > 2) {
                d.buildings.push({ x0: x - 7, y0: y - 5, x1: x + 7, y1: y + 5, h: 6, style: 'farm', variant: rng.int(0, 5), ridgeX: true });
                d.buildings.push({ x0: x + 14, y0: y - 9, x1: x + 30, y1: y + 9, h: 9, style: 'barn', ridgeX: false });
                d.scatter = d.scatter.filter(p => Math.abs(p.x - x - 10) > 26 || Math.abs(p.y - y) > 18);
            }
        }
    }

    // Static colliders around a point: { boxes: [...AABB], circles: [...] }
    collidersNear(x, y, r, out = { boxes: [], circles: [] }) {
        out.boxes.length = 0; out.circles.length = 0;
        const cx0 = Math.floor((x - r) / CHUNK), cx1 = Math.floor((x + r) / CHUNK);
        const cy0 = Math.floor((y - r) / CHUNK), cy1 = Math.floor((y + r) / CHUNK);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
            const d = this.chunkData(cx, cy);
            for (const b of d.boxes) if (b.x1 > x - r && b.x0 < x + r && b.y1 > y - r && b.y0 < y + r) out.boxes.push(b);
            for (const c of d.circles) if (Math.abs(c.x - x) < r && Math.abs(c.y - y) < r) out.circles.push(c);
        }
        return out;
    }

    // All doors (shops etc.) of a given type, or all.
    doors(type = null) {
        const list = [];
        for (const s of this.specials) {
            this.blockContent(s.block);
            if (s.block.special.door && (!type || s.type === type)) list.push(s.block.special.door);
        }
        return list;
    }

    inBounds(x, y) { return Math.abs(x) < this.half && Math.abs(y) < this.half; }
}

const EMPTY = [];
const _road = {};
