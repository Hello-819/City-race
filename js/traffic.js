// AI traffic: lane-following cars using the Intelligent Driver Model, with
// lane changes, oncoming traffic, collisions and near-miss detection.
import * as THREE from 'three';
import { createCar, TRAFFIC_PAINTS } from './assets.js';
import { Rng, clamp, lerp } from './core/rng.js';
import { glowTexture } from './textures.js';

// Oriented-rectangle overlap (separating axis). Returns {nx, ny, depth} pushing A out of B.
export function obbOverlap(ax, ay, ath, ahl, ahw, bx, by, bth, bhl, bhw) {
    const axes = [[Math.cos(ath), Math.sin(ath)], [-Math.sin(ath), Math.cos(ath)], [Math.cos(bth), Math.sin(bth)], [-Math.sin(bth), Math.cos(bth)]];
    const dx = ax - bx, dy = ay - by;
    let best = null;
    const proj = (th, hl, hw, nx, ny) => hl * Math.abs(Math.cos(th) * nx + Math.sin(th) * ny) + hw * Math.abs(-Math.sin(th) * nx + Math.cos(th) * ny);
    for (const [nx, ny] of axes) {
        const ra = proj(ath, ahl, ahw, nx, ny), rb = proj(bth, bhl, bhw, nx, ny);
        const dist = dx * nx + dy * ny;
        const overlap = ra + rb - Math.abs(dist);
        if (overlap <= 0) return null;
        if (!best || overlap < best.depth) best = { nx: nx * Math.sign(dist || 1), ny: ny * Math.sign(dist || 1), depth: overlap };
    }
    return best;
}

export class Traffic {
    constructor(scene, world, kind, night, seed, density = 1) {
        this.scene = scene;
        this.world = world;
        this.road = world.road;
        this.kind = kind;
        this.night = night;
        this.rng = new Rng(seed ^ 0x7a7a);
        const P = this.road.p;
        this.lanes = [];
        for (let l = 0; l < P.lanesPerDir; l++) {
            const c = (kind === 'city' ? 0 : 0) + P.laneWidth * (l + 0.5);
            this.lanes.push({ dir: 1, d: -c, idx: l });
            this.lanes.push({ dir: -1, d: c, idx: l });
        }
        this.cars = [];
        const count = Math.round((kind === 'city' ? 26 : 12) * density);
        const glow = glowTexture();
        for (let i = 0; i < count; i++) this.cars.push(this._makeCar());
        this.events = [];
        // all head/tail light glows in one point cloud (one draw call)
        if (night) {
            const n = this.cars.length * 4;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
            const colors = new Float32Array(n * 3);
            for (let i = 0; i < this.cars.length; i++) {
                for (let k = 0; k < 4; k++) {
                    const c = k < 2 ? [1, 0.93, 0.8] : [1, 0.12, 0.05];
                    colors.set(c, (i * 4 + k) * 3);
                }
            }
            g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            this.glows = new THREE.Points(g, new THREE.PointsMaterial({
                size: 1.5, map: glow, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true,
            }));
            this.glows.frustumCulled = false;
            scene.add(this.glows);
        }
    }

    _makeCar() {
        const id = this.rng.chance(0.5) ? 'ferrari' : 'concept';
        const rig = createCar(id, { lod: true, color: this.rng.pick(TRAFFIC_PAINTS) });
        for (const m of rig.mats.tail) m.emissiveIntensity = this.night ? 1.2 : 0.25;
        for (const m of rig.mats.head) m.emissiveIntensity = this.night ? 2.5 : 0;
        const { x, z } = rig.dims;
        const lights = [
            new THREE.Vector3(-(x / 2 - 0.38), 0.66, -z / 2 - 0.05), new THREE.Vector3(x / 2 - 0.38, 0.66, -z / 2 - 0.05),
            new THREE.Vector3(-(x / 2 - 0.3), 0.8, z / 2 + 0.05), new THREE.Vector3(x / 2 - 0.3, 0.8, z / 2 + 0.05),
        ];
        rig.root.rotation.order = 'YXZ';
        this.scene.add(rig.root);
        return {
            rig, s: -1e9, d: 0, dTarget: 0, lane: null, v: 0, v0: 0, crashed: 0, prevRel: 0,
            halfL: rig.dims.z / 2, halfW: rig.dims.x / 2 * 0.9, wheelAngle: 0, braking: 0, lastHit: 0,
            th: 0, x: 0, y: 0, honked: 0, lights,
        };
    }

    _laneFree(lane, s, gap, except) {
        for (const c of this.cars) {
            if (c === except || c.lane !== lane) continue;
            if (Math.abs(c.s - s) < gap) return false;
        }
        return true;
    }

    _spawn(car, playerS, initial) {
        const rng = this.rng;
        for (let tries = 0; tries < 20; tries++) {
            const lane = rng.pick(this.lanes);
            const s = initial ? playerS + rng.range(35, 900) : playerS + rng.range(420, 900);
            if (s > this.road.frontS - 50) continue;
            if (!this._laneFree(lane, s, 28, car)) continue;
            car.lane = lane; car.s = s; car.d = lane.d; car.dTarget = lane.d;
            const base = this.kind === 'city' ? rng.range(11, 19) : rng.range(13, 22);
            car.v0 = base + (lane.idx === 0 && this.kind === 'city' ? 0 : 3);
            car.v = car.v0 * rng.range(0.8, 1);
            car.crashed = 0;
            car.prevRel = Math.sign(car.s - playerS);
            car.rig.setColor(rng.pick(TRAFFIC_PAINTS));
            car.rig.root.visible = true;
            return;
        }
        car.s = -1e9; car.rig.root.visible = false;
    }

    reset(playerS) {
        for (const c of this.cars) this._spawn(c, playerS, true);
    }

    update(dt, player, playerS, playerD, playerSpeedAlong, simTime) {
        this.events.length = 0;
        const road = this.road;
        for (const car of this.cars) {
            if (car.s < playerS - 200 || car.s > playerS + 1100 || car.s > road.frontS - 10 || car.s < road.backS + 10) {
                this._spawn(car, playerS, false);
                continue;
            }
            const dir = car.lane.dir;
            // leader in lane (cars + player)
            let gap = Infinity, vLead = 0;
            for (const o of this.cars) {
                if (o === car || o.lane.dir !== dir || Math.abs(o.d - car.d) > 2.4) continue;
                const ds = (o.s - car.s) * dir;
                if (ds > 0 && ds < gap) { gap = ds; vLead = o.v; }
            }
            const pds = (playerS - car.s) * dir;
            const playerInLane = Math.abs(playerD - car.d) < 2.6;
            if (playerInLane && pds > 0 && pds < gap) { gap = pds; vLead = Math.max(0, playerSpeedAlong * dir); }
            gap -= 4.8;
            // IDM
            const a = 1.8, b = 3.2, T = 1.25, s0 = 4;
            const v = car.v;
            const v0 = car.crashed > 0 ? 0 : car.v0 * (road.frameAt(car.s).k !== 0 ? clamp(1.2 - Math.abs(road.frameAt(car.s).k) * 25, 0.55, 1) : 1);
            const sStar = s0 + v * T + v * (v - vLead) / (2 * Math.sqrt(a * b));
            let acc = a * (1 - Math.pow(v / Math.max(v0, 0.1), 4) - Math.pow(Math.max(sStar, 0) / Math.max(gap, 0.5), 2));
            acc = clamp(acc, -9, a);
            car.braking = acc < -1 ? 1 : 0;
            car.v = Math.max(0, v + acc * dt);
            car.s += car.v * dir * dt;
            if (car.crashed > 0) { car.crashed -= dt; if (car.crashed <= 0) car.dTarget = car.lane.d; }

            // lane change when stuck behind someone slower
            if (Math.abs(car.d - car.dTarget) < 0.05 && gap < 35 && vLead < car.v0 - 2 && this.rng.chance(dt * 0.8)) {
                const options = this.lanes.filter(l => l.dir === dir && l !== car.lane);
                for (const l of options) {
                    const playerNear = Math.abs(playerD - l.d) < 2.6 && Math.abs(playerS - car.s) < 25;
                    if (this._laneFree(l, car.s, 22, car) && !playerNear) { car.lane = l; car.dTarget = l.d; break; }
                }
            }
            car.d += clamp(car.dTarget - car.d, -1.6 * dt, 1.6 * dt);
            // honk at a player in the oncoming lane
            if (dir < 0 && playerInLane && pds > 0 && pds < 60 && car.honked <= 0) { this.events.push({ type: 'honk' }); car.honked = 6; }
            car.honked -= dt;

            // pose
            const p = road.pointAt(car.s, car.d);
            const laneYaw = (car.dTarget - car.d) !== 0 ? Math.atan2((car.dTarget - car.d) > 0 ? 1.6 : -1.6, Math.max(car.v, 3)) * dir * 0.5 : 0;
            const th = p.th + (dir < 0 ? Math.PI : 0) + laneYaw;
            car.th = th; car.x = p.px; car.y = p.py;
            const root = car.rig.root;
            root.position.set(p.px, p.pz, -p.py);
            root.rotation.set(Math.atan(p.grade * dir), th - Math.PI / 2, p.bank * dir);
            car.wheelAngle -= car.v / car.rig.wheels[0].radius * dt;
            for (const w of car.rig.wheels) w.spin.rotation.x = car.wheelAngle;
            const tailI = (this.night ? 1.2 : 0.25) + car.braking * 2.5;
            for (const m of car.rig.mats.tail) m.emissiveIntensity = tailI;

            // near miss: car passes alongside the player
            const rel = Math.sign(car.s - playerS);
            if (rel !== car.prevRel && car.prevRel !== 0) {
                const lateral = Math.abs(car.d - playerD) - car.halfW - player.P.halfWidth;
                const relSpeed = Math.abs(playerSpeedAlong - car.v * dir);
                if (lateral < 1.25 && lateral > -0.3 && relSpeed > 7 && simTime - car.lastHit > 2) {
                    this.events.push({ type: 'nearmiss', closeness: clamp(1.25 - lateral, 0, 1.5), oncoming: dir < 0, relSpeed });
                }
            }
            car.prevRel = rel;

            // collision with the player
            if (Math.abs(car.s - playerS) < 8) {
                const hit = obbOverlap(player.x, player.y, player.th, player.P.halfLength, player.P.halfWidth, car.x, car.y, car.th, car.halfL, car.halfW);
                if (hit) {
                    const tvx = Math.cos(car.th) * car.v, tvy = Math.sin(car.th) * car.v;
                    const rvx = player.vx - tvx, rvy = player.vy - tvy;
                    const vn = rvx * hit.nx + rvy * hit.ny;
                    player.x += hit.nx * hit.depth; player.y += hit.ny * hit.depth;
                    if (vn < 0) {
                        const mP = player.P.mass, mT = 1500, e = 0.3;
                        const j = -(1 + e) * vn / (1 / mP + 1 / mT);
                        player.vx += j / mP * hit.nx; player.vy += j / mP * hit.ny;
                        // traffic car speed along its heading changes
                        const dv = -(j / mT) * (hit.nx * Math.cos(car.th) + hit.ny * Math.sin(car.th));
                        car.v = Math.max(0, car.v + dv);
                        car.dTarget = car.d = car.d - (hit.nx * -Math.sin(road.frameAt(car.s).th) + hit.ny * Math.cos(road.frameAt(car.s).th)) * Math.min(0.6, -vn * 0.05);
                        const fwdX = Math.cos(player.th), fwdY = Math.sin(player.th);
                        const side = fwdX * hit.ny - fwdY * hit.nx;
                        player.r += side * Math.min(1.5, -vn * 0.06);
                        // only real hits stall the AI car; gentle nudges just push it along
                        if (-vn > 4) {
                            car.crashed = 2.5;
                            if (simTime - car.lastHit > 0.4) this.events.push({ type: 'crash', strength: -vn });
                            car.lastHit = simTime;
                        }
                    }
                }
            }
        }
        if (this.glows) this._updateGlows();
        return this.events;
    }

    _updateGlows() {
        const pos = this.glows.geometry.attributes.position;
        const v = new THREE.Vector3();
        this.cars.forEach((car, i) => {
            const root = car.rig.root;
            root.updateMatrix();
            for (let k = 0; k < 4; k++) {
                if (!root.visible) { pos.setXYZ(i * 4 + k, 0, -1e4, 0); continue; }
                v.copy(car.lights[k]).applyMatrix4(root.matrix);
                pos.setXYZ(i * 4 + k, v.x, v.y, v.z);
            }
        });
        pos.needsUpdate = true;
    }

    dispose() {
        if (this.glows) { this.scene.remove(this.glows); this.glows.geometry.dispose(); }
        for (const c of this.cars) this.scene.remove(c.rig.root);
        this.cars = [];
    }
}
