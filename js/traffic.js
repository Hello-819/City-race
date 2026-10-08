// AI traffic: lane-following cars using the Intelligent Driver Model, with
// lane changes, oncoming traffic, collisions and near-miss detection.
import * as THREE from 'three';
import { createCar, TRAFFIC_PAINTS, TRAFFIC_IDS } from './assets.js';
import { Rng, clamp, lerp } from './core/rng.js';
import { glowTexture } from './textures.js';
import { obbOverlap } from './collide.js';

export { obbOverlap };

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
        const id = this.rng.pick(TRAFFIC_IDS);
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

    // ctx: { playerS, playerD, playerAlong, player (Vehicle), obstacles: [{s, d, v}], simTime }
    update(dt, ctx) {
        this.events.length = 0;
        const road = this.road;
        const { playerS, playerD, playerAlong, player, obstacles, simTime } = ctx;
        for (const car of this.cars) {
            if (car.s < playerS - 200 || car.s > playerS + 1100 || car.s > road.frontS - 10 || car.s < road.backS + 10) {
                this._spawn(car, playerS, false);
                continue;
            }
            const dir = car.lane.dir;
            // leader in lane: other traffic, then dynamic obstacles (player, police, racers, pedestrians)
            let gap = Infinity, vLead = 0;
            for (const o of this.cars) {
                if (o === car || o.lane.dir !== dir || Math.abs(o.d - car.d) > 2.4) continue;
                const ds = (o.s - car.s) * dir;
                if (ds > 0 && ds < gap) { gap = ds; vLead = o.v; }
            }
            for (const o of obstacles) {
                if (Math.abs(o.d - car.d) > (o.ped ? 1.8 : 2.6)) continue;
                const ds = (o.s - car.s) * dir;
                if (ds > 0 && ds < gap) { gap = ds; vLead = Math.max(0, o.v * dir); }
            }
            gap -= 4.8;
            const a = 1.8, b = 3.2, T = 1.25, s0 = 4;
            const v = car.v;
            const k = Math.abs(road.frameAt(car.s).k);
            const v0 = car.crashed > 0 ? 0 : car.v0 * (k > 0 ? clamp(1.2 - k * 25, 0.55, 1) : 1);
            const sStar = s0 + v * T + v * (v - vLead) / (2 * Math.sqrt(a * b));
            let acc = a * (1 - Math.pow(v / Math.max(v0, 0.1), 4) - Math.pow(Math.max(sStar, 0) / Math.max(gap, 0.5), 2));
            acc = clamp(acc, -9, a);
            car.braking = acc < -1 ? 1 : 0;
            car.v = Math.max(0, v + acc * dt);
            car.s += car.v * dir * dt;
            if (car.crashed > 0) { car.crashed -= dt; if (car.crashed <= 0) car.dTarget = car.lane.d; }

            if (Math.abs(car.d - car.dTarget) < 0.05 && gap < 35 && vLead < car.v0 - 2 && this.rng.chance(dt * 0.8)) {
                for (const l of this.lanes.filter(l => l.dir === dir && l !== car.lane)) {
                    const blocked = obstacles.some(o => Math.abs(o.d - l.d) < 2.6 && Math.abs(o.s - car.s) < 25);
                    if (this._laneFree(l, car.s, 22, car) && !blocked) { car.lane = l; car.dTarget = l.d; break; }
                }
            }
            car.d += clamp(car.dTarget - car.d, -1.6 * dt, 1.6 * dt);
            const pds = (playerS - car.s) * dir;
            if (dir < 0 && Math.abs(playerD - car.d) < 2.6 && pds > 0 && pds < 60 && car.honked <= 0) { this.events.push({ type: 'honk' }); car.honked = 6; }
            car.honked -= dt;

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
                const relSpeed = Math.abs(playerAlong - car.v * dir);
                if (lateral < 1.25 && lateral > -0.3 && relSpeed > 7 && simTime - car.lastHit > 2) {
                    this.events.push({ type: 'nearmiss', closeness: clamp(1.25 - lateral, 0, 1.5), oncoming: dir < 0, relSpeed });
                }
            }
            car.prevRel = rel;
        }
        if (this.glows) this._updateGlows();
        return this.events;
    }

    // Collide a dynamic vehicle (player, police, racer) with traffic. Traffic is kinematic.
    // Returns [{car, speed, nx, ny}] for impacts this step.
    collide(veh, s, simTime) {
        const out = [];
        const road = this.road;
        for (const car of this.cars) {
            if (Math.abs(car.s - s) > 8 || !car.rig.root.visible) continue;
            const hit = obbOverlap(veh.x, veh.y, veh.th, veh.P.halfLength, veh.P.halfWidth, car.x, car.y, car.th, car.halfL, car.halfW);
            if (!hit) continue;
            const tvx = Math.cos(car.th) * car.v, tvy = Math.sin(car.th) * car.v;
            const vn = (veh.vx - tvx) * hit.nx + (veh.vy - tvy) * hit.ny;
            veh.x += hit.nx * hit.depth; veh.y += hit.ny * hit.depth;
            if (vn >= 0) continue;
            const mP = veh.P.mass, mT = 1500, e = 0.3;
            const j = -(1 + e) * vn / (1 / mP + 1 / mT);
            veh.vx += j / mP * hit.nx; veh.vy += j / mP * hit.ny;
            const dv = -(j / mT) * (hit.nx * Math.cos(car.th) + hit.ny * Math.sin(car.th));
            car.v = Math.max(0, car.v + dv);
            const f = road.frameAt(car.s);
            car.dTarget = car.d = car.d - (hit.nx * -f.sn + hit.ny * f.c) * Math.min(0.6, -vn * 0.05);
            const side = Math.cos(veh.th) * hit.ny - Math.sin(veh.th) * hit.nx;
            veh.r += side * Math.min(1.5, -vn * 0.06);
            // only real hits stall the AI car; gentle nudges just push it along
            if (-vn > 4) {
                car.crashed = 2.5;
                if (simTime - car.lastHit > 0.4) out.push({ car, speed: -vn, nx: hit.nx, ny: hit.ny });
                car.lastHit = simTime;
            }
        }
        return out;
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
