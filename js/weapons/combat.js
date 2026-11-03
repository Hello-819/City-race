// Combat helpers shared by the player's weapons, armed civilians and police:
//   traceShot()  hitscan ray vs buildings, terrain, people and vehicles
//   lineOfSight() cheap building-only visibility test
//   CombatFx     pooled bullet tracers, muzzle flashes and blood puffs
// Everything is in the map frame (x east, y north, z up).
import * as THREE from 'three';
import { glowTexture } from '../textures.js';

const _cols = { boxes: [], circles: [] };

function boxTop(map, b) {
    if (b.top === undefined) b.top = map.heightAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) + b.h + (b.tier ? b.tier.h : 0);
    return b.top;
}

// Ray vs axis-aligned box (3D slab). Returns entry distance or Infinity.
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, tmax) {
    let t0 = 0, t1 = tmax;
    const axes = [[ox, dx, x0, x1], [oy, dy, y0, y1], [oz, dz, z0, z1]];
    for (const [o, d, a, b] of axes) {
        if (Math.abs(d) < 1e-9) { if (o < a || o > b) return Infinity; continue; }
        let ta = (a - o) / d, tb = (b - o) / d;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return Infinity;
    }
    return t0;
}

// Distance along the ray to the first building / terrain hit.
export function worldHit(map, ox, oy, oz, dx, dy, dz, range) {
    let best = range;
    // buildings: test boxes in 40 m slices along the ray
    for (let s = 0; s < best; s += 40) {
        const mx = ox + dx * (s + 20), my = oy + dy * (s + 20);
        map.collidersNear(mx, my, 30, _cols);
        for (const b of _cols.boxes) {
            const t = rayBox(ox, oy, oz, dx, dy, dz, b.x0, b.y0, b.zMin ?? -50, b.x1, b.y1, boxTop(map, b), best);
            if (t < best) best = t;
        }
        if (best < s + 40) break;
    }
    // terrain: march in 1.5 m steps
    let prevAbove = true;
    for (let t = 0.5; t < best; t += 1.5) {
        const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
        const above = z > map.heightAt(x, y);
        if (!above && prevAbove) { best = Math.max(0, t - 0.75); break; }
        prevAbove = above;
    }
    return best;
}

export function lineOfSight(map, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.5) return true;
    return worldHit(map, ax, ay, az, dx / L, dy / L, dz / L, L) >= L - 0.4;
}

// Ray vs a standing person (vertical cylinder). Returns {t, head} or null.
function rayPerson(ox, oy, oz, dx, dy, dz, px, py, pz, tmax, r = 0.38, h = 1.8) {
    const hl = Math.hypot(dx, dy);
    if (hl < 1e-6) return null;
    const ux = dx / hl, uy = dy / hl;
    const fx = px - ox, fy = py - oy;
    const along = fx * ux + fy * uy;              // horizontal distance to closest approach
    if (along < 0) return null;
    const perp2 = fx * fx + fy * fy - along * along;
    if (perp2 > r * r) return null;
    const th = along - Math.sqrt(r * r - perp2);  // horizontal entry distance
    const t = th / hl;                            // ray parameter
    if (t > tmax) return null;
    const z = oz + dz * t;
    if (z < pz || z > pz + h) return null;
    return { t, head: z > pz + h - 0.28 };
}

// Ray vs vehicle (oriented box from the ground to roof height).
function rayVehicle(ox, oy, oz, dx, dy, dz, ve, tmax) {
    const v = ve.veh, c = Math.cos(v.th), s = Math.sin(v.th);
    const rx = ox - v.x, ry = oy - v.y;
    const lx = rx * c + ry * s, ly = -rx * s + ry * c;
    const ldx = dx * c + dy * s, ldy = -dx * s + dy * c;
    const h = ve.rig.dims.y;
    return rayBox(lx, ly, oz, ldx, ldy, dz, -v.P.halfLength, -v.P.halfWidth, v.z + 0.15, v.P.halfLength, v.P.halfWidth, v.z + h, tmax);
}

// Full hitscan. shooter: object to ignore. Returns the closest hit:
// { kind: 'ped'|'player'|'vehicle'|'world'|'none', target, t, x, y, z, head }
export function traceShot(game, ox, oy, oz, dx, dy, dz, range, shooter = null) {
    let best = { kind: 'none', t: range, target: null, head: false };
    const tw = worldHit(game.map, ox, oy, oz, dx, dy, dz, range);
    if (tw < range) best = { kind: 'world', t: tw, target: null, head: false };
    for (const p of game.peds.active) {
        if (p === shooter || p.dead) continue;
        if (Math.abs(p.x - ox) > range + 2 || Math.abs(p.y - oy) > range + 2) continue;
        const h = rayPerson(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, best.t);
        if (h) best = { kind: 'ped', t: h.t, target: p, head: h.head };
    }
    const pl = game.player;
    if (shooter !== pl && !pl.dead) {
        if (pl.vehicle) { /* hits the car instead */ } else {
            const h = rayPerson(ox, oy, oz, dx, dy, dz, pl.x, pl.y, pl.z, best.t);
            if (h) best = { kind: 'player', t: h.t, target: pl, head: h.head };
        }
    }
    for (const ve of game.vehicles) {
        if (!ve.alive && ve.wreckT > 20) continue;
        if (shooter && shooter.vehicle === ve) continue;
        if (Math.abs(ve.x - ox) > range + 6 || Math.abs(ve.y - oy) > range + 6) continue;
        const t = rayVehicle(ox, oy, oz, dx, dy, dz, ve, best.t);
        if (t < best.t) best = { kind: 'vehicle', t, target: ve, head: false };
    }
    best.x = ox + dx * best.t; best.y = oy + dy * best.t; best.z = oz + dz * best.t;
    return best;
}

// ---------------------------------------------------------------------------
// Pooled visual effects (one draw call each).
const TRACERS = 64, FLASHES = 12;

export class CombatFx {
    constructor(scene) {
        this.scene = scene;
        // tracers: line segments with per-vertex alpha
        const g = new THREE.BufferGeometry();
        this.tPos = new Float32Array(TRACERS * 6);
        this.tCol = new Float32Array(TRACERS * 8);
        g.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(this.tCol, 4));
        this.tracers = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.tracers.frustumCulled = false;
        this.tLife = new Float32Array(TRACERS);
        this.tNext = 0;
        scene.add(this.tracers);
        // muzzle flashes: pooled sprites + one shared point light
        this.flashes = [];
        const mat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        for (let i = 0; i < FLASHES; i++) {
            const s = new THREE.Sprite(mat.clone());
            s.visible = false; s.scale.setScalar(0.9);
            scene.add(s);
            this.flashes.push({ s, life: 0 });
        }
        this.fNext = 0;
        this.light = new THREE.PointLight(0xffc070, 0, 14, 2);
        scene.add(this.light);
        this.lightLife = 0;
    }

    tracer(ax, ay, az, bx, by, bz, color = [1, 0.85, 0.5]) {
        const i = this.tNext; this.tNext = (i + 1) % TRACERS;
        this.tPos.set([ax, az, -ay, bx, bz, -by], i * 6);
        this.tCol.set([color[0], color[1], color[2], 0.15, color[0], color[1], color[2], 0.9], i * 8);
        this.tLife[i] = 0.07;
    }

    flash(x, y, z, big = false) {
        const f = this.flashes[this.fNext]; this.fNext = (this.fNext + 1) % FLASHES;
        f.s.position.set(x, z, -y);
        f.s.scale.setScalar(big ? 1.4 : 0.8);
        f.s.material.rotation = Math.random() * 6;
        f.s.visible = true; f.life = 0.05;
        this.light.position.set(x, z + 0.1, -y);
        this.light.intensity = big ? 40 : 25;
        this.lightLife = 0.05;
    }

    update(dt) {
        for (let i = 0; i < TRACERS; i++) {
            if (this.tLife[i] <= 0) continue;
            this.tLife[i] -= dt;
            if (this.tLife[i] <= 0) { this.tCol[i * 8 + 3] = 0; this.tCol[i * 8 + 7] = 0; }
        }
        this.tracers.geometry.attributes.position.needsUpdate = true;
        this.tracers.geometry.attributes.color.needsUpdate = true;
        for (const f of this.flashes) if (f.life > 0) { f.life -= dt; if (f.life <= 0) f.s.visible = false; }
        if (this.lightLife > 0) { this.lightLife -= dt; if (this.lightLife <= 0) this.light.intensity = 0; }
    }

    dispose() {
        this.scene.remove(this.tracers, this.light);
        for (const f of this.flashes) this.scene.remove(f.s);
    }
}
