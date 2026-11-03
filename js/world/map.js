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
        this.bounds = C.bounds;
        this.half = Math.max(-C.bounds.x0, C.bounds.x1);   // horizontal half-extent
        this.noise = new Simplex(seed);
        this.noise2 = new Simplex(seed + 101);
        this.noise3 = new Simplex(seed + 202);
        this.river = { bx0: 0, bx1: 0, by0: 0, by1: 0 };
        this.mountainRoad = { bx0: 0, bx1: 0, by0: 0, by1: 0 };
        this._buildRiver();
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
    // The island is a noisy superellipse centred north of the city.
    shoreDist(x, y) {
        const ax = Math.abs(x) / C.coastRadiusX, ay = Math.abs(y - C.coastCenterY) / C.coastRadiusY;
        const rn = Math.pow(ax ** 4 + ay ** 4, 0.25);
        const coast = 1 + this.noise2.fbm(x / 900, y / 900, 3) * C.coastNoise / C.coastRadiusX;
        return (coast - rn) * C.coastRadiusX;
    }

    // Natural terrain before rivers and road cuttings are carved into it.
    rawHeight(x, y) {
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

    // Terrain height (m): natural terrain with the river channel and the
    // mountain road's cuttings / embankments carved in.
    heightAt(x, y) {
        let h = this.rawHeight(x, y);
        const R = C.river;
        if (x < this.river.bx1 && x > this.river.bx0 && y > this.river.by0 && y < this.river.by1) {
            const pr = this.river.poly.project(x, y);
            if (pr && pr.dist < R.width / 2 + R.bank) {
                const wz = this.river.waterZ(pr.s);
                const t = pr.dist / (R.width / 2);
                const target = t < 1 ? wz - R.depth * (1 - t * t) : lerp(wz + 0.4, h, smoothstep(R.width / 2, R.width / 2 + R.bank, pr.dist));
                h = Math.min(h, target);
            }
        }
        const mr = this.mountainRoad;
        if (y > mr.by0 && y < mr.by1 && x > mr.bx0 && x < mr.bx1) {
            const pr = mr.edge.poly.project(x, y);
            const half = mr.edge.half;
            if (pr && pr.dist < half + 40) {
                const z = mr.edge.elev(pr.s) - 0.08;
                h = pr.dist < half + 2 ? z : lerp(z, h, smoothstep(half + 2, half + 40, pr.dist));
            }
        }
        return h;
    }

    // Water surface at a point: the river level inside the channel, else the sea.
    waterLevel(x, y) {
        const R = C.river;
        if (x < this.river.bx1 && x > this.river.bx0 && y > this.river.by0 && y < this.river.by1) {
            const pr = this.river.poly.project(x, y);
            if (pr && pr.dist < R.width / 2 + 4) return Math.max(C.seaLevel, this.river.waterZ(pr.s));
        }
        return C.seaLevel;
    }

    // Height of whatever you stand on, plus surface type.
    // zHint: the caller's current height, so on a bridge / flyover you stay on
    // the deck and underneath you stay on the road below.
    // out: { h, kind: 'road'|'pavement'|'grass'|'sand'|'rock'|'water', water: depth, edge }
    surfaceAt(x, y, out = {}, zHint = null) {
        const ground = this.heightAt(x, y);
        let h = ground, kind = 'grass';
        const r = this.roadAt(x, y, 0, _road2, zHint);
        out.edge = null;
        if (r && (zHint == null || r.h <= zHint + 1.3 || r.h <= ground + 0.3)) { h = r.h + 0.06; kind = 'road'; out.edge = r.edge; }
        else {
            const b = this.blockAt(x, y);
            if (b && this._onPavement(b, x, y)) { h += 0.15; kind = 'pavement'; }
            else if (h < 1.6 && this.shoreDist(x, y) < C.beachWidth + 40) kind = 'sand';
            else if (y > C.mountainY + 150 && h > 60) kind = 'rock';
        }
        out.h = h;
        out.kind = kind;
        out.water = kind === 'road' ? 0 : Math.max(0, this.waterLevel(x, y) - h);
        if (out.water > 0.3) out.kind = 'water';
        return out;
    }

    _onPavement(b, x, y) {
        if (b.zone === ZONE.CITY) return true;    // whole city block is paved plaza
        return x < b.x0 + b.sw || x > b.x1 - b.sw || y < b.y0 + b.sw || y > b.y1 - b.sw;
    }

    // ------------------------------------------------------------------ roads
    // Grid roads are axis-aligned "lines" (axis 'x' = constant x, runs N-S).
    // The ring highway, its corners and ramps and the mountain road are built
    // separately as curved polylines / elevated sections.
    _buildRoads() {
        const R = C.ring, F = C.flyover;
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
        const north = C.northRows[C.northRows.length - 1];
        for (const c of C.countryLines) { add('x', c, -C.countryReach, north); add('y', c, -C.countryReach, C.countryReach); }
        for (const r of C.northRows) add('y', r, C.countryLines[0], C.countryLines[C.countryLines.length - 1]);
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
        this.nodes = [];
        this.edges = [];
        const nodeKey = new Map();
        const node = (x, y) => {
            const k = Math.round(x) + ',' + Math.round(y);
            let n = nodeKey.get(k);
            if (!n) { n = { id: this.nodes.length, x, y, edges: [], half: 0, signal: false }; this.nodes.push(n); nodeKey.set(k, n); }
            return n;
        };
        this._node = node;
        const covers = (axis, c, t) => {
            const ivs = lines[axis].get(c);
            if (!ivs) return false;
            for (const [a, b] of ivs) if (t >= a - 1e-6 && t <= b + 1e-6) return true;
            return false;
        };
        // grid lines, split at every crossing (and where interchange ramps join)
        for (const axis of ['x', 'y']) {
            const other = axis === 'x' ? 'y' : 'x';
            const crossCs = [...lines[other].keys()].sort((a, b) => a - b);
            for (const [c, ivs] of lines[axis]) {
                for (const [a0, a1] of ivs) {
                    const stops = [a0, a1];
                    for (const c2 of crossCs) if (c2 > a0 + 1e-6 && c2 < a1 - 1e-6 && covers(other, c2, c)) stops.push(c2);
                    // ramp junctions beside the ring highway (the road passes under it)
                    if (C.countryLines.includes(c)) for (const t of [-R - F.rampIn, -R + F.rampIn, R - F.rampIn, R + F.rampIn]) if (t > a0 + 1 && t < a1 - 1) stops.push(t);
                    stops.sort((a, b) => a - b);
                    for (let i = 0; i + 1 < stops.length; i++) {
                        const t0 = stops[i], t1 = stops[i + 1];
                        if (t1 - t0 < 1) continue;
                        const P = (t) => axis === 'x' ? [c, t] : [t, c];
                        this._addEdge(node(...P(t0)), node(...P(t1)), this._roadType(axis, c, (t0 + t1) / 2), { axis, c, t0, t1 });
                    }
                }
            }
        }
        this._buildHighway(node);
        this._buildMountainRoad(node);
        for (const n of this.nodes) {
            for (const id of n.edges) n.half = Math.max(n.half, this.edges[id].half);
            const es = n.edges.map(id => this.edges[id]);
            const zone = this.zoneAt(n.x, n.y);
            const fast = es.some(e => e.type === 'highway' || e.type === 'ramp' || e.type === 'mountain');
            n.signal = !fast && n.edges.length >= 3 && (zone === ZONE.CITY || es.some(e => e.type === 'city'));
            n.phase = (hashSeed(n.id, this.seed) % 1000) / 1000;
            // priority for give-way at unsignalled junctions: bigger roads first
            n.rank = Math.max(...es.map(e => RANK[e.type] || 0));
        }
        // spatial index of edges (cell -> edge ids)
        this.edgeGrid = new Map();
        for (const e of this.edges) {
            const cells = new Set();
            const step = 15;
            for (let s = -e.half; s <= e.len + e.half; s += step) {
                const p = this.edgePoint(e, clamp(s, 0, e.len), 0, {});
                for (const dx of [-e.half - 4, e.half + 4]) for (const dy of [-e.half - 4, e.half + 4]) cells.add(Math.floor((p.x + dx) / EDGE_CELL) * 100003 + Math.floor((p.y + dy) / EDGE_CELL));
            }
            for (const k of cells) { if (!this.edgeGrid.has(k)) this.edgeGrid.set(k, []); this.edgeGrid.get(k).push(e.id); }
        }
    }

    _addEdge(na, nb, type, geom) {
        const Rt = CONFIG.roads[type];
        const e = {
            id: this.edges.length, a: na.id, b: nb.id, type, half: Rt.half, lanes: Rt.lanes, laneW: Rt.laneW, speed: Rt.speed, sidewalk: Rt.sidewalk,
            axis: null, c: 0, t0: 0, t1: 0, ux: 0, uy: 0, poly: null, elev: null, ...geom,
        };
        if (e.poly) e.len = e.poly.len;
        else {
            e.len = e.t1 - e.t0;
            e.ux = e.axis === 'x' ? 0 : 1; e.uy = e.axis === 'x' ? 1 : 0;
        }
        this.edges.push(e);
        na.edges.push(e.id); nb.edges.push(e.id);
        return e;
    }

    // Ring highway: straight sides with flyovers over every crossing road,
    // four curved ramps per interchange, and curved corners.
    _buildHighway(node) {
        const R = C.ring, rc = C.ringCornerRadius, F = C.flyover;
        this.interchanges = [];
        const sides = [   // [axis, c, direction of travel along the side]
            ['y', -R], ['x', R], ['y', R], ['x', -R],
        ];
        for (const [axis, c] of sides) {
            const pts = [-R + rc];
            for (const k of C.countryLines) pts.push(k - F.rampOut, k + F.rampOut);
            pts.push(R - rc);
            pts.sort((a, b) => a - b);
            const P = (t) => axis === 'x' ? [c, t] : [t, c];
            for (let i = 0; i + 1 < pts.length; i++) {
                const t0 = pts[i], t1 = pts[i + 1];
                const cross = C.countryLines.find(k => k > t0 && k < t1 && t1 - t0 <= 2 * F.rampOut + 1);
                const geom = { axis, c, t0, t1 };
                if (cross !== undefined) {
                    // flyover: rise to `clearance` above the road below, flat over it
                    const cx = axis === 'x' ? c : cross, cy = axis === 'x' ? cross : c;
                    const top = this.rawHeight(cx, cy) + F.clearance;
                    geom.elev = (s) => {
                        const t = t0 + s, [x, y] = P(t);
                        return lerp(this.rawHeight(x, y), top, 1 - smoothstep(22, F.rampLength, Math.abs(t - cross)));
                    };
                    geom.flyover = true;
                    this.interchanges.push({ x: cx, y: cy, axis });
                }
                this._addEdge(node(...P(t0)), node(...P(t1)), 'highway', geom);
            }
        }
        // corners: quarter circles
        for (const [sx, sy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
            const cx = sx * (R - rc), cy = sy * (R - rc);
            const pts = [];
            const a0 = Math.atan2(sy, 0), a1 = Math.atan2(0, sx);       // from the y-side end to the x-side end
            let da = a1 - a0; da = Math.atan2(Math.sin(da), Math.cos(da));
            for (let i = 0; i <= 16; i++) { const a = a0 + da * i / 16; pts.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc]); }
            pts[0] = [sx * (R - rc), sy * R]; pts[16] = [sx * R, sy * (R - rc)];
            this._addEdge(node(...pts[0]), node(...pts[16]), 'highway', { poly: new Poly(pts) });
        }
        // ramps: from the highway (before / after the flyover) down to the road below
        for (const ic of this.interchanges) {
            const ux = ic.axis === 'x' ? 0 : 1, uy = ic.axis === 'x' ? 1 : 0;      // highway direction
            const vx = uy, vy = ux;                                                 // crossing road direction
            for (const su of [-1, 1]) for (const sv of [-1, 1]) {
                const H = [ic.x - su * ux * F.rampOut, ic.y - su * uy * F.rampOut];
                const L = [ic.x + sv * vx * F.rampIn, ic.y + sv * vy * F.rampIn];
                const P1 = [H[0] + su * ux * 80 + sv * vx * 16, H[1] + su * uy * 80 + sv * vy * 16];
                const P2 = [L[0] - sv * vx * 35 - su * ux * 18, L[1] - sv * vy * 35 - su * uy * 18];
                const pts = [];
                for (let i = 0; i <= 20; i++) {
                    const t = i / 20, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, cc = 3 * (1 - t) * t * t, d = t ** 3;
                    pts.push([a * H[0] + b * P1[0] + cc * P2[0] + d * L[0], a * H[1] + b * P1[1] + cc * P2[1] + d * L[1]]);
                }
                if (!this._nodeExists(L[0], L[1])) continue;     // road below doesn't reach this far
                this._addEdge(node(...H), node(...L), 'ramp', { poly: new Poly(pts) });
            }
        }
    }

    _nodeExists(x, y) { return this.nodes.some(n => Math.abs(n.x - x) < 1 && Math.abs(n.y - y) < 1); }

    // A switchback road climbing into the northern mountains, with a smooth,
    // grade-limited profile (the terrain is cut / filled to match it).
    _buildMountainRoad(node) {
        const ctrl = C.mountainRoad;
        const pts = [];
        // Catmull-Rom through the control points
        for (let i = 0; i + 1 < ctrl.length; i++) {
            const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
            const n = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 8);
            for (let k = 0; k < n; k++) {
                const t = k / n, t2 = t * t, t3 = t2 * t;
                const f = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
                pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
            }
        }
        pts.push(ctrl[ctrl.length - 1]);
        const poly = new Poly(pts);
        // grade-limited profile
        const n = Math.ceil(poly.len / 6);
        const z = new Float32Array(n + 1);
        for (let i = 0; i <= n; i++) { const p = poly.at(poly.len * i / n); z[i] = this.rawHeight(p.x, p.y); }
        const g = C.maxGrade * poly.len / n;
        for (let i = 1; i <= n; i++) z[i] = clamp(z[i], z[i - 1] - g, z[i - 1] + g);
        for (let i = n - 1; i >= 0; i--) z[i] = clamp(z[i], z[i + 1] - g, z[i + 1] + g);
        for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n; i++) z[i] = (z[i - 1] + z[i] * 2 + z[i + 1]) / 4;
        z[0] = this.rawHeight(pts[0][0], pts[0][1]);
        const elev = (s) => { const f = clamp(s / poly.len * n, 0, n); const i = Math.min(n - 1, Math.floor(f)); return lerp(z[i], z[i + 1], f - i); };
        const e = this._addEdge(node(...pts[0]), node(...pts[pts.length - 1]), 'mountain', { poly, elev });
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        this.mountainRoad = { edge: e, bx0: Math.min(...xs) - 60, bx1: Math.max(...xs) + 60, by0: Math.min(...ys) - 60, by1: Math.max(...ys) + 60 };
    }

    _buildRiver() {
        const R = C.river;
        const poly = new Poly(R.points);
        // water level: follows the valley floor, never rising downstream
        const n = Math.ceil(poly.len / 20);
        const z = new Float32Array(n + 1);
        for (let i = 0; i <= n; i++) { const p = poly.at(poly.len * i / n); z[i] = this.rawHeight(p.x, p.y) - 2.5; }
        for (let i = 1; i <= n; i++) z[i] = Math.min(z[i], z[i - 1]);
        for (let pass = 0; pass < 4; pass++) for (let i = 1; i < n; i++) z[i] = Math.min(z[i], (z[i - 1] + z[i] * 2 + z[i + 1]) / 4);
        for (let i = 0; i <= n; i++) z[i] = Math.max(z[i], C.seaLevel);
        const waterZ = (s) => { const f = clamp(s / poly.len * n, 0, n); const i = Math.min(n - 1, Math.floor(f)); return lerp(z[i], z[i + 1], f - i); };
        const xs = R.points.map(p => p[0]), ys = R.points.map(p => p[1]);
        const pad = R.width + R.bank + 10;
        this.river = { poly, waterZ, bx0: Math.min(...xs) - pad, bx1: Math.max(...xs) + pad, by0: Math.min(...ys) - pad, by1: Math.max(...ys) + pad };
    }

    _roadType(axis, c, t) {
        const m = Math.max(Math.abs(c), Math.abs(t));
        if (c === 0 && m <= C.ring) return 'city';            // the two cross-island avenues
        if (m <= C.cityHalf + 1e-6) return 'city';
        if (m <= C.suburbHalf + 1e-6) return 'suburb';
        return 'country';
    }

    // Axis-aligned rect covered by an edge (map frame), expanded by `pad` across.
    edgeRect(e, pad = 0) {
        if (e.poly) return [e.poly.bx0 - pad, e.poly.by0 - pad, e.poly.bx1 + pad, e.poly.by1 + pad];
        return e.axis === 'x' ? [e.c - pad, e.t0, e.c + pad, e.t1] : [e.t0, e.c - pad, e.t1, e.c + pad];
    }

    // Point on an edge: along distance s from node a, lateral offset d (+ = right of a->b).
    edgePoint(e, s, d, out = {}) {
        if (e.poly) {
            const p = e.poly.at(s);
            out.x = p.x + p.ty * d; out.y = p.y - p.tx * d;
            return out;
        }
        const t = e.t0 + s;
        if (e.axis === 'x') { out.x = e.c + d; out.y = t; } else { out.x = t; out.y = e.c - d; }
        return out;
    }

    // Unit direction of travel a->b at distance s.
    tangent(e, s) {
        if (e.poly) { const p = e.poly.at(s); return { x: p.tx, y: p.ty }; }
        return { x: e.ux, y: e.uy };
    }

    // Road surface height at distance s along an edge (decks / profiles, else terrain).
    roadHeight(e, s, x = null, y = null) {
        if (e.elev) return e.elev(clamp(s, 0, e.len));
        if (x == null) { const p = this.edgePoint(e, s, 0, {}); x = p.x; y = p.y; }
        return this.rawHeight(x, y);
    }

    edgesNear(x, y) { return this.edgeGrid.get(Math.floor(x / EDGE_CELL) * 100003 + Math.floor(y / EDGE_CELL)) || EMPTY; }

    // Project a point onto an edge: { s, d } (d signed, + = right of a->b).
    _project(e, x, y) {
        if (e.poly) { const p = e.poly.project(x, y); return p ? { s: p.s, d: p.d } : null; }
        if (e.axis === 'x') return { s: y - e.t0, d: x - e.c };
        return { s: x - e.t0, d: e.c - y };
    }

    // Road under a point (including junction squares) or null.
    // With several (flyover over a road), zHint picks the one you are on.
    // Returns { edge, s, d, h }.
    roadAt(x, y, pad = 0, out = _road, zHint = null) {
        let best = null, bestScore = Infinity;
        for (const id of this.edgesNear(x, y)) {
            const e = this.edges[id];
            const pr = this._project(e, x, y);
            if (!pr || Math.abs(pr.d) > e.half + pad) continue;
            if (pr.s < -e.half - pad || pr.s > e.len + e.half + pad) continue;
            const h = this.roadHeight(e, pr.s, e.elev ? null : x, y);
            // prefer the highest surface not above us (+ a kerb's step); without a hint, the lowest
            const score = zHint == null ? h : (h <= zHint + 1.3 ? -h : 1000 + h);
            if (score < bestScore) { bestScore = score; best = e; out.s = pr.s; out.d = pr.d; out.h = h; }
            if (!e.elev && zHint == null) break;
        }
        if (!best) return null;
        out.edge = best;
        return out;
    }

    // Nearest point on any road (used for spawning / respawning cars).
    nearestRoad(x, y, maxR = 300, filter = null) {
        let best = null, bd = Infinity;
        const r = Math.ceil(maxR / EDGE_CELL);
        const gx0 = Math.floor(x / EDGE_CELL), gy0 = Math.floor(y / EDGE_CELL);
        const seen = new Set();
        for (let gx = gx0 - r; gx <= gx0 + r; gx++) for (let gy = gy0 - r; gy <= gy0 + r; gy++) {
            for (const id of this.edgeGrid.get(gx * 100003 + gy) || EMPTY) {
                if (seen.has(id)) continue; seen.add(id);
                const e = this.edges[id];
                if (filter && !filter(e)) continue;
                const pr = this._project(e, x, y);
                if (!pr) continue;
                const s = clamp(pr.s, 0, e.len);
                const p = this.edgePoint(e, s, 0);
                const dd = (p.x - x) ** 2 + (p.y - y) ** 2;
                if (dd < bd) { bd = dd; best = { edge: e, s, x: p.x, y: p.y, dist: Math.sqrt(dd) }; }
            }
        }
        return best;
    }

    // A* over the road graph: list of {edge, fwd} from the edge nearest
    // (x0, y0) to the one nearest (x1, y1). Used by police and the GPS.
    route(x0, y0, x1, y1) {
        const a = this.nearestRoad(x0, y0, 400), b = this.nearestRoad(x1, y1, 400);
        if (!a || !b) return null;
        const goal = new Set([b.edge.a, b.edge.b]);
        const N = this.nodes;
        const start = [a.edge.a, a.edge.b];
        const g = new Map(), from = new Map(), open = [];
        const hf = (id) => Math.hypot(N[id].x - b.x, N[id].y - b.y);
        for (const id of start) {
            const p = this.edgePoint(a.edge, a.s, 0);
            const c = Math.hypot(N[id].x - p.x, N[id].y - p.y);
            g.set(id, c); from.set(id, { edge: a.edge, prev: -1 });
            open.push([c + hf(id), id]);
        }
        let end = -1, guard = 0;
        while (open.length && guard++ < 20000) {
            let bi = 0;
            for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
            const [, id] = open.splice(bi, 1)[0];
            if (goal.has(id)) { end = id; break; }
            for (const eid of N[id].edges) {
                const e = this.edges[eid];
                const other = e.a === id ? e.b : e.a;
                const c = g.get(id) + e.len / (e.speed / 15);       // prefer fast roads a little
                if (c < (g.get(other) ?? Infinity)) { g.set(other, c); from.set(other, { edge: e, prev: id }); open.push([c + hf(other), other]); }
            }
        }
        if (end < 0) return null;
        const path = [];
        for (let id = end; from.get(id).prev >= 0; id = from.get(id).prev) {
            const { edge, prev } = from.get(id);
            path.unshift({ edge, fwd: edge.a === prev });
        }
        return { start: a, end: b, path };
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
        this._structures(d);
        this._parkSpots(d);
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
            if (h < 1.5 || this.waterLevel(x, y) > h - 0.3) continue;
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

    // Parking spots: half on the kerb along suburban streets, rows in city car
    // parks. Deterministic, so the same cars are there when you come back.
    _parkSpots(d) {
        d.park = [];
        const rng = new Rng(hashSeed(d.cx, d.cy, this.seed, 99));
        const near = (x, y) => d.circles.some(c => Math.abs(c.x - x) < 3.5 && Math.abs(c.y - y) < 3.5) ||
            d.doors.some(dr => Math.abs(dr.x - x) < 8 && Math.abs(dr.y - y) < 8);
        let id = 0;
        for (const b of d.blocks) {
            if (b.zone === ZONE.SUBURB) {
                const sides = [[b.x0, b.y0, b.x1, b.y0, 0, -1], [b.x0, b.y1, b.x1, b.y1, 0, 1], [b.x0, b.y0, b.x0, b.y1, -1, 0], [b.x1, b.y0, b.x1, b.y1, 1, 0]];
                for (const [ax, ay, bx, by, nx, ny] of sides) {
                    const len = Math.hypot(bx - ax, by - ay);
                    for (let s = 18; s < len - 18; s += 9) {
                        if (!rng.chance(0.28)) continue;
                        // centre 0.25 m inside the kerb line: half on the road edge, half on the pavement
                        const x = ax + (bx - ax) * s / len - nx * 0.25, y = ay + (by - ay) * s / len - ny * 0.25;
                        if (near(x, y)) continue;
                        const th = Math.atan2(by - ay, bx - ax) + (rng.chance(0.5) ? Math.PI : 0);
                        d.park.push({ id: d.key * 1000 + id++, x, y, th });
                    }
                }
            }
            for (const lot of this.blockContent(b).parking) {
                const along = lot.x1 - lot.x0 > lot.y1 - lot.y0;
                const L = along ? lot.x1 - lot.x0 : lot.y1 - lot.y0;
                for (const row of [0.22, 0.78]) for (let s = 2.5; s < L - 2; s += 3) {
                    if (!rng.chance(0.55)) continue;
                    const x = along ? lot.x0 + s : lot.x0 + (lot.x1 - lot.x0) * row, y = along ? lot.y0 + (lot.y1 - lot.y0) * row : lot.y0 + s;
                    d.park.push({ id: d.key * 1000 + id++, x, y, th: (along ? Math.PI / 2 : 0) + (row < 0.5 ? 0 : Math.PI), lot: true });
                }
            }
        }
    }

    // Edges with any part inside the chunk.
    edgesInRect(x0, y0, x1, y1) {
        const seen = new Set(), out = [];
        for (let gx = Math.floor(x0 / EDGE_CELL); gx <= Math.floor(x1 / EDGE_CELL); gx++)
            for (let gy = Math.floor(y0 / EDGE_CELL); gy <= Math.floor(y1 / EDGE_CELL); gy++)
                for (const id of this.edgeGrid.get(gx * 100003 + gy) || EMPTY) if (!seen.has(id)) { seen.add(id); out.push(this.edges[id]); }
        return out;
    }

    // Bridges and flyovers in a chunk: wherever a road deck is well above the
    // ground, add railings (colliders that only exist at deck height) and
    // pillars down to the ground (avoiding roads underneath).
    // d.structs: [{ e, s0, s1, deck0, deck1 }] for rendering.
    _structures(d) {
        d.structs = [];
        d.pillars = [];
        const step = 4;
        for (const e of this.edgesInRect(d.x0, d.y0, d.x1, d.y1)) {
            if (e.type === 'mountain') continue;          // hugs the hillside (terrain is cut to fit)
            let lastPillar = -1e9;
            for (let s = 0; s < e.len; s += step) {
                const s1 = Math.min(e.len, s + step), sm = (s + s1) / 2;
                const m = this.edgePoint(e, sm, 0, {});
                if (m.x < d.x0 || m.x >= d.x1 || m.y < d.y0 || m.y >= d.y1) continue;
                const deck = this.roadHeight(e, sm, m.x, m.y);
                const ground = Math.max(this.heightAt(m.x, m.y), this.waterLevel(m.x, m.y));   // land, or the river surface
                if (deck - ground < 1.2) continue;
                const z0 = this.roadHeight(e, s), z1 = this.roadHeight(e, s1);
                d.structs.push({ e, s0: s, s1, z0, z1 });
                // railings: thin AABBs per piece on both sides, only solid at deck height
                for (const side of [-1, 1]) {
                    const a = this.edgePoint(e, s, side * (e.half + 0.2), {}), b = this.edgePoint(e, s1, side * (e.half + 0.2), {});
                    const box = { x0: Math.min(a.x, b.x) - 0.15, x1: Math.max(a.x, b.x) + 0.15, y0: Math.min(a.y, b.y) - 0.15, y1: Math.max(a.y, b.y) + 0.15,
                        h: 1.1, zMin: Math.min(z0, z1) - 0.8, zMax: Math.max(z0, z1) + 1.1, rail: true };
                    box.top = box.zMax;
                    d.boxes.push(box);
                }
                if (deck - ground > 2.5 && sm - lastPillar > 26) {
                    // no pillar in the middle of a road (or river) below
                    const under = this.edgesNear(m.x, m.y).some(id => {
                        const o = this.edges[id];
                        if (o === e) return false;
                        const pr = this._project(o, m.x, m.y);
                        return pr && Math.abs(pr.d) < o.half + 2 && pr.s > -o.half && pr.s < o.len + o.half && this.roadHeight(o, pr.s) < deck - 2;
                    });
                    if (!under && this.waterLevel(m.x, m.y) < this.heightAt(m.x, m.y) + 0.5 || !under && deck - ground < 12) {
                        lastPillar = sm;
                        const p = { type: 'pillar', x: m.x, y: m.y, r: 0.9, zMax: deck - 0.6, z0: ground - 1, z1: deck - 0.6 };
                        d.pillars.push(p);
                        d.circles.push(p);
                    }
                }
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

    inBounds(x, y) { const B = this.bounds; return x > B.x0 && x < B.x1 && y > B.y0 && y < B.y1; }
}

const EMPTY = [];
const _road = {}, _road2 = {};
const RANK = { highway: 5, ramp: 4, city: 3, country: 2, mountain: 2, suburb: 1 };

// A polyline with arc-length lookup and point projection (curved roads, river).
export class Poly {
    constructor(pts) {
        this.x = pts.map(p => p[0]); this.y = pts.map(p => p[1]);
        this.cs = [0];
        for (let i = 1; i < pts.length; i++) this.cs.push(this.cs[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]));
        this.len = this.cs[this.cs.length - 1];
        this.bx0 = Math.min(...this.x); this.bx1 = Math.max(...this.x); this.by0 = Math.min(...this.y); this.by1 = Math.max(...this.y);
        // segment grid for fast projection
        this.cell = 60;
        this.grid = new Map();
        for (let i = 0; i + 1 < pts.length; i++) {
            const x0 = Math.min(this.x[i], this.x[i + 1]), x1 = Math.max(this.x[i], this.x[i + 1]);
            const y0 = Math.min(this.y[i], this.y[i + 1]), y1 = Math.max(this.y[i], this.y[i + 1]);
            for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
                for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
                    const k = gx * 100003 + gy;
                    if (!this.grid.has(k)) this.grid.set(k, []);
                    this.grid.get(k).push(i);
                }
        }
    }
    // point + unit tangent at arc length s
    at(s) {
        s = Math.max(0, Math.min(this.len, s));
        let lo = 0, hi = this.cs.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cs[m] <= s) lo = m; else hi = m; }
        const L = this.cs[hi] - this.cs[lo] || 1, t = (s - this.cs[lo]) / L;
        const tx = (this.x[hi] - this.x[lo]) / L, ty = (this.y[hi] - this.y[lo]) / L;
        return { x: this.x[lo] + (this.x[hi] - this.x[lo]) * t, y: this.y[lo] + (this.y[hi] - this.y[lo]) * t, tx, ty };
    }
    // closest point: { s, d (signed, + right of travel), dist } within ~2 cells
    project(px, py) {
        const gx0 = Math.floor(px / this.cell), gy0 = Math.floor(py / this.cell);
        let best = null, bd = Infinity;
        const seen = new Set();
        for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
            for (const i of this.grid.get(gx * 100003 + gy) || EMPTY) {
                if (seen.has(i)) continue; seen.add(i);
                const ax = this.x[i], ay = this.y[i], sx = this.x[i + 1] - ax, sy = this.y[i + 1] - ay;
                const L2 = sx * sx + sy * sy || 1;
                const t = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / L2));
                const qx = ax + sx * t, qy = ay + sy * t;
                const dd = (px - qx) ** 2 + (py - qy) ** 2;
                if (dd < bd) {
                    bd = dd;
                    const L = Math.sqrt(L2);
                    best = { s: this.cs[i] + t * L, d: ((px - ax) * sy - (py - ay) * sx) / L, dist: Math.sqrt(dd) };
                }
            }
        }
        return best;
    }
}
