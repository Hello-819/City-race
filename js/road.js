// Procedural, endless road centre-line generator.
//
// All road maths happens in a 2D "map" frame: (x, y) on the ground plane with a
// counter-clockwise heading `th`, and `z` for elevation. Three.js world space is
// (x, z, -y). The road always progresses in +y (heading stays within maxDev of
// PI/2), which guarantees it never loops back over itself.

import { Rng, clamp, lerp } from './core/rng.js';

export const DS = 2;          // metres between centre-line samples
const CELL = 40;              // spatial hash cell size (m)
const HALF_PI = Math.PI / 2;

const cellKey = (ix, iy) => ix * 100003 + iy;

export const ROAD_PROFILES = {
    city: {
        kind: 'city',
        lanesPerDir: 2,
        laneWidth: 3.5,
        roadHalf: 7.5,        // asphalt half width (lanes + gutter)
        curbHeight: 0.15,
        sidewalkOuter: 11.5,  // outer edge of sidewalk / building line
        wall: 11.3,           // collision boundary (|d|)
        maxDev: 1.15,
        startStraight: 260,
    },
    mountain: {
        kind: 'mountain',
        lanesPerDir: 1,
        laneWidth: 3.6,
        roadHalf: 4.9,
        shoulderOuter: 5.8,
        guardrail: 6.0,
        wall: 5.85,
        maxDev: 1.42,
        startStraight: 220,
    },
};

export class Road {
    constructor(profile, seed, terrain = null) {
        this.p = profile;
        this.rng = new Rng(seed);
        this.terrain = terrain;          // mountain: height function + water level
        this.samples = [];               // sliding window of samples
        this.base = 0;                   // global index of samples[0]
        this.hash = new Map();
        this.intersections = [];         // city cross streets  {s, width}
        this.checkpoints = [];           // {s, index}
        this.signs = [];                 // mountain chevron signs {s, side}
        this.checkpointSpacing = profile.kind === 'city' ? 2200 : 2000;
        this.nextCheckpoint = this.checkpointSpacing;

        // generator state
        this.gx = 0; this.gy = 0; this.gz = terrain ? Math.max(terrain.water + 6, terrain.height(0, 60)) : 0;
        this.gth = HALF_PI; this.gk = 0; this.grade = 0;
        this.plan = [];                  // queued {len, k0, k1, tag}
        this.planPos = 0;                // metres done in current plan item
        this.turnSign = this.rng.sign();
        this.totalSamples = 0;

        this.plan.push({ len: profile.startStraight, k0: 0, k1: 0, tag: 'start' });
        this._emit();                    // sample 0
    }

    get frontS() { return (this.totalSamples - 1) * DS; }
    get backS() { return this.base * DS; }

    sample(i) { return this.samples[i - this.base]; }
    hasIndex(i) { return i >= this.base && i < this.totalSamples; }
    clampIndex(i) { return Math.max(this.base, Math.min(this.totalSamples - 1, i)); }

    // --- generation ---------------------------------------------------------
    _planNext() {
        const p = this.p, r = this.rng;
        const dev = this.gth - HALF_PI;
        const chooseSign = () => {
            if (Math.abs(dev) > 0.25 && r.chance(0.8)) return -Math.sign(dev);
            return r.sign();
        };
        const addTurn = (delta, radius, transition) => {
            const k = 1 / radius * Math.sign(delta);
            // clamp so the final heading stays inside the allowed corridor
            const target = clamp(this.gth + delta, HALF_PI - p.maxDev, HALF_PI + p.maxDev);
            delta = target - this.gth;
            const total = Math.abs(delta) / Math.abs(k);     // = Larc + T
            if (total < 8) return;
            const T = Math.min(transition, total * 0.45);
            const arc = total - T;
            this.plan.push({ len: T, k0: 0, k1: k, tag: 'turn' });
            if (arc > 0) this.plan.push({ len: arc, k0: k, k1: k, tag: 'turn' });
            this.plan.push({ len: T, k0: k, k1: 0, tag: 'turn' });
        };

        if (p.kind === 'city') {
            const roll = r.float();
            if (roll < 0.55) {
                this.plan.push({ len: r.range(140, 420), k0: 0, k1: 0, tag: 'straight' });
            } else if (roll < 0.85) {
                // a proper city corner
                addTurn(chooseSign() * r.range(0.5, 1.15), r.range(55, 120), r.range(20, 35));
                this.plan.push({ len: r.range(60, 120), k0: 0, k1: 0, tag: 'straight' });
            } else {
                // long sweeping bend (boulevard)
                addTurn(chooseSign() * r.range(0.25, 0.6), r.range(220, 420), 60);
            }
        } else {
            const roll = r.float();
            if (roll < 0.18) {
                this.plan.push({ len: r.range(40, 160), k0: 0, k1: 0, tag: 'straight' });
            } else if (roll < 0.8) {
                // flowing S-bends: alternate direction
                this.turnSign = Math.abs(dev) > 0.5 ? -Math.sign(dev) : -this.turnSign;
                addTurn(this.turnSign * r.range(0.5, 1.6), r.range(45, 150), r.range(20, 40));
                if (r.chance(0.4)) this.plan.push({ len: r.range(10, 50), k0: 0, k1: 0, tag: 'straight' });
            } else {
                // tight hairpin-ish corner, needs heavy braking
                const s = chooseSign();
                addTurn(s * r.range(1.4, 2.6), r.range(24, 38), 18);
                this.plan.push({ len: r.range(30, 70), k0: 0, k1: 0, tag: 'straight' });
            }
        }
        if (this.plan.length === 0) this.plan.push({ len: 60, k0: 0, k1: 0, tag: 'straight' });
    }

    _emit() {
        const p = this.p;
        const s = this.totalSamples * DS;
        let bank = 0;
        if (p.kind === 'mountain') bank = clamp(this.gk * 7, -0.085, 0.085);
        else bank = clamp(this.gk * 2.5, -0.025, 0.025);
        const smp = {
            x: this.gx, y: this.gy, z: this.gz, th: this.gth, k: this.gk,
            bank, grade: this.grade, s, tag: this.curTag || 'start',
            c: Math.cos(this.gth), sn: Math.sin(this.gth),
            struct: null,
        };
        if (this.terrain) {
            const diff = this.terrain.height(this.gx, this.gy) - this.gz;
            smp.raw = s < p.startStraight + 60 ? 0 : diff > 13 ? 1 : diff < -9 ? -1 : 0;
        }
        this.samples.push(smp);
        const idx = this.totalSamples++;
        const key = cellKey(Math.floor(smp.x / CELL), Math.floor(smp.y / CELL));
        let list = this.hash.get(key);
        if (!list) { list = []; this.hash.set(key, list); }
        list.push(idx);
    }

    _step() {
        if (this.plan.length === 0) this._planNext();
        const item = this.plan[0];
        this.curTag = item.tag;
        const t0 = this.planPos / item.len;
        const t1 = Math.min(1, (this.planPos + DS) / item.len);
        const kMid = lerp(item.k0, item.k1, (t0 + t1) / 2);
        this.planPos += DS;
        if (this.planPos >= item.len) { this.plan.shift(); this.planPos = 0; }

        const p = this.p;
        let k = kMid;
        // hard safety: never leave the heading corridor
        const nextTh = this.gth + k * DS;
        if (nextTh > HALF_PI + p.maxDev || nextTh < HALF_PI - p.maxDev) {
            k = 0; this.plan = []; this.planPos = 0;
        }
        this.gk = k;
        const thMid = this.gth + k * DS / 2;
        this.gx += Math.cos(thMid) * DS;
        this.gy += Math.sin(thMid) * DS;
        this.gth += k * DS;

        if (this.terrain) {
            // aim the road at the terrain a little ahead, with a grade limit
            const look = 170;
            const tx = this.gx + Math.cos(this.gth) * look;
            const ty = this.gy + Math.sin(this.gth) * look;
            const target = Math.max(this.terrain.water + 5, this.terrain.height(tx, ty));
            const gTarget = clamp((target - this.gz) / look, -0.075, 0.075);
            const startFlat = this.totalSamples * DS < p.startStraight ? 0.15 : 1;
            this.grade += clamp(gTarget * startFlat - this.grade, -0.0012, 0.0012);
            this.gz += this.grade * DS;
        }

        const s = this.totalSamples * DS;
        // features
        if (p.kind === 'city' && item.tag === 'straight' && item.len > 120) {
            const last = this.intersections[this.intersections.length - 1];
            const into = this.planPos;
            if ((!last || s - last.s > 150) && into > 40 && item.len - into > 40 && this.rng.chance(0.08)) {
                this.intersections.push({ s, width: 13, th: this.gth });
            }
        }
        if (p.kind === 'mountain' && Math.abs(k) > 1 / 50 && item.tag === 'turn') {
            const last = this.signs[this.signs.length - 1];
            if (!last || s - last.s > 14) this.signs.push({ s, side: k > 0 ? -1 : 1 });
        }
        if (s >= this.nextCheckpoint) {
            const lastInt = this.intersections[this.intersections.length - 1];
            if (!lastInt || Math.abs(lastInt.s - s) > 40) {
                this.checkpoints.push({ s, index: this.checkpoints.length + 1 });
                this.nextCheckpoint += this.checkpointSpacing;
            }
        }
        this._emit();
    }

    generateTo(s) {
        while (this.frontS < s) this._step();
        if (this.terrain) this._classify();
    }

    // Mountain: turn long runs of deep cut into tunnels and big drops into bridges.
    // Runs are only finalised once they are closed, well behind the generation front.
    _classify() {
        if (this.classifiedTo === undefined) this.classifiedTo = 0;
        const end = this.totalSamples - 160;
        let i = Math.max(this.classifiedTo, this.base);
        while (i < end) {
            const raw = this.sample(i).raw;
            let j = i;
            while (j < end && this.sample(j).raw === raw) j++;
            if (j >= end && raw !== 0) break;           // run still open
            const len = j - i;
            if (raw === 1 && len >= 30) for (let k = Math.max(this.base, i - 3); k < Math.min(this.totalSamples, j + 3); k++) this.sample(k).struct = 'tunnel';
            if (raw === -1 && len >= 12) for (let k = i; k < j; k++) if (!this.sample(k).struct) this.sample(k).struct = 'bridge';
            i = j;
        }
        this.classifiedTo = i;
    }

    structAt(s) { const i = clamp(Math.round(s / DS), this.base, this.totalSamples - 1); return this.sample(i).struct; }

    // Drop samples (and hash entries) far behind the player.
    pruneBefore(s) {
        const target = Math.floor(s / DS);
        if (target - this.base < 400) return;
        for (let i = this.base; i < target; i++) {
            const smp = this.sample(i);
            const key = cellKey(Math.floor(smp.x / CELL), Math.floor(smp.y / CELL));
            const list = this.hash.get(key);
            if (list) {
                const at = list.indexOf(i);
                if (at >= 0) list.splice(at, 1);
                if (list.length === 0) this.hash.delete(key);
            }
        }
        this.samples.splice(0, target - this.base);
        this.base = target;
        const cut = (arr) => { while (arr.length && arr[0].s < s - 200) arr.shift(); };
        cut(this.intersections); cut(this.signs);
    }

    // --- queries ------------------------------------------------------------
    // Interpolated frame at arc length s.
    frameAt(s, out = {}) {
        let i = Math.floor(s / DS);
        i = clamp(i, this.base, this.totalSamples - 2);
        const a = this.sample(i), b = this.sample(i + 1);
        const t = clamp((s - a.s) / DS, 0, 1);
        out.x = lerp(a.x, b.x, t);
        out.y = lerp(a.y, b.y, t);
        out.z = lerp(a.z, b.z, t);
        out.th = lerp(a.th, b.th, t);
        out.k = lerp(a.k, b.k, t);
        out.bank = lerp(a.bank, b.bank, t);
        out.grade = lerp(a.grade, b.grade, t);
        out.c = Math.cos(out.th); out.sn = Math.sin(out.th);
        out.s = s;
        return out;
    }

    // Point at arc length s, lateral offset d (positive = left of travel).
    pointAt(s, d, out = {}) {
        this.frameAt(s, out);
        out.px = out.x - out.sn * d;
        out.py = out.y + out.c * d;
        out.pz = out.z - d * out.bank;
        return out;
    }

    // Surface height at road coordinates (includes sidewalk curb in the city).
    heightAt(s, d) {
        const f = this.frameAt(s, _tmpFrame);
        let h = f.z - d * f.bank;
        if (this.p.kind === 'city' && Math.abs(d) > this.p.roadHalf && !this.inIntersection(s, 0)) h += this.p.curbHeight;
        return h;
    }

    inIntersection(s, margin = 0) {
        for (const it of this.intersections) {
            if (Math.abs(s - it.s) < it.width / 2 + margin) return it;
        }
        return null;
    }

    // Project (x, y) onto a segment pair around global index i.
    _project(i, x, y, out) {
        i = clamp(i, this.base, this.totalSamples - 1);
        let best = null;
        for (let j = Math.max(this.base, i - 1); j <= Math.min(this.totalSamples - 2, i); j++) {
            const a = this.sample(j), b = this.sample(j + 1);
            const ex = b.x - a.x, ey = b.y - a.y;
            const len2 = ex * ex + ey * ey;
            let t = ((x - a.x) * ex + (y - a.y) * ey) / len2;
            t = clamp(t, 0, 1);
            const px = a.x + ex * t, py = a.y + ey * t;
            const dx = x - px, dy = y - py;
            const dist2 = dx * dx + dy * dy;
            if (!best || dist2 < best.dist2) best = { j, t, dist2, ex, ey };
        }
        if (!best) return null;
        const a = this.sample(best.j), b = this.sample(best.j + 1);
        const len = Math.sqrt(best.ex * best.ex + best.ey * best.ey);
        // signed lateral (left positive): cross(tangent, p - a)
        const d = (best.ex * (y - a.y) - best.ey * (x - a.x)) / len;
        out.s = a.s + best.t * DS;
        out.d = d;
        out.idx = best.j;
        out.dist = Math.sqrt(best.dist2);
        out.th = lerp(a.th, b.th, best.t);
        out.z = lerp(a.z, b.z, best.t) - d * lerp(a.bank, b.bank, best.t);
        return out;
    }

    // Track a moving object: hill-climb from a hint index.
    locate(x, y, hint, out = {}) {
        let i = clamp(hint ?? this.base, this.base, this.totalSamples - 1);
        const dist2 = (j) => { const p = this.sample(j); const dx = p.x - x, dy = p.y - y; return dx * dx + dy * dy; };
        let d0 = dist2(i);
        for (let iter = 0; iter < 4000; iter++) {
            let moved = false;
            if (i + 1 < this.totalSamples) { const d1 = dist2(i + 1); if (d1 < d0) { i++; d0 = d1; moved = true; } }
            if (!moved && i - 1 >= this.base) { const d1 = dist2(i - 1); if (d1 < d0) { i--; d0 = d1; moved = true; } }
            if (!moved) break;
        }
        return this._project(i, x, y, out);
    }

    // Nearest road point via the spatial hash (any part of the road). Returns null if > ~CELL away.
    nearest(x, y, out = {}) {
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        let bestI = -1, bestD = Infinity;
        for (let ix = cx - 1; ix <= cx + 1; ix++) {
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                const list = this.hash.get(cellKey(ix, iy));
                if (!list) continue;
                for (let n = 0; n < list.length; n++) {
                    const p = this.samples[list[n] - this.base];
                    const dx = p.x - x, dy = p.y - y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < bestD) { bestD = d2; bestI = list[n]; }
                }
            }
        }
        if (bestI < 0) return null;
        return this._project(bestI, x, y, out);
    }

    // Minimum distance from (x, y) to any road centre point (capped).
    clearance(x, y) {
        const n = this.nearest(x, y, _tmpNear);
        return n ? n.dist : Infinity;
    }
}

const _tmpFrame = {};
const _tmpNear = {};
