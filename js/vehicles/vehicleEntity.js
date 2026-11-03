// A vehicle in the open world: tyre physics (vehicle.js) + terrain following +
// collisions with buildings / props + water + visual rig (wheels, suspension,
// lights). Used for the player's car, parked cars, traffic and police.
import * as THREE from 'three';
import { Vehicle, PHYS_DT } from '../vehicle.js';
import { obbOverlap } from '../collide.js';
import { CONFIG } from '../config.js';
import { clamp, damp } from '../core/rng.js';

const GRIP = { road: 1, pavement: 0.95, grass: 0.78, sand: 0.62, rock: 0.85, water: 0.25 };
const _surf = {}, _cols = { boxes: [], circles: [] };
let _uid = 1;

export class VehicleEntity {
    // world: { scene, map }, rig: car rig from assets / carModels, info: catalog entry
    constructor(world, rig, info = {}) {
        this.id = _uid++;
        this.world = world;
        this.rig = rig;
        this.info = info;
        this.veh = new Vehicle(rig.spec, rig);
        this.veh.assists.auto = true;
        rig.root.rotation.order = 'YXZ';
        world.scene.add(rig.root);
        this.maxHealth = info.health || 1000;
        this.health = this.maxHealth;
        this.alive = true;
        this.driver = null;          // 'player' or an NPC driver object
        this.acc = 0;
        this.zSmooth = 0; this.pitch = 0; this.roll = 0; this.pitchV = 0; this.rollV = 0;
        this.groundPitch = 0; this.groundRoll = 0;
        this.impacts = [];
        this.scrapes = [];
        this.inWater = 0;
        this.surface = 'road';
        this.lightsOn = false;
        this.horn = 0;
        this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
    }

    // --- damage: smoke below 35 %, fire at 0, explosion a few seconds later ---
    damage(amount, by = null) {
        if (!this.alive || amount <= 0) return;
        this.health -= amount;
        if (by) this.lastHitBy = by;
        if (this.health <= 0 && this.burnT === undefined) this.burnT = 4 + Math.random() * 2;
    }

    _updateDamage(dt) {
        const g = this.world.game, fx = g && g.effects;
        if (!fx) return;
        const x = this.veh.x, y = this.veh.y, z = this.veh.z + this.rig.dims.y * 0.7;
        if (!this.alive) {
            this.wreckT = (this.wreckT || 0) + dt;
            if (this.wreckT < 25) fx.fire(x, z, -y, dt, Math.max(0, 1 - this.wreckT / 25));
            return;
        }
        if (this.burnT !== undefined) {
            this.burnT -= dt;
            fx.fire(x + Math.cos(this.veh.th) * this.veh.P.halfLength * 0.6, z, -(y + Math.sin(this.veh.th) * this.veh.P.halfLength * 0.6), dt, 1);
            if (this.burnT <= 0) this.explode();
        } else if (this.health < this.maxHealth * 0.35 && Math.random() < dt * 8) {
            fx.smoke.emit({ x: x + Math.cos(this.veh.th) * this.veh.P.halfLength * 0.7, y: z, z: -(y + Math.sin(this.veh.th) * this.veh.P.halfLength * 0.7),
                vx: 0, vy: 1.5, vz: 0, life: 2, size: 0.8, grow: 3, alpha: 0.35, r: 0.25, g: 0.25, b: 0.25, fadeIn: 8 });
        }
    }

    explode() {
        if (!this.alive) return;
        this.alive = false;
        this.health = 0;
        this.burnT = undefined;
        for (const m of this.rig.mats.paint) { m.color.set(0x161514); if (m.clearcoat !== undefined) m.clearcoat = 0; m.roughness = 0.9; }
        this.setLights(false);
        for (const m of this.rig.mats.tail) m.emissiveIntensity = 0;
        // a little hop
        this.veh.vx *= 0.3; this.veh.vy *= 0.3; this.veh.r += (Math.random() - 0.5) * 2;
        this.hop = 1.2;
        if (this.world.game) this.world.game.explosion(this.veh.x, this.veh.y, this.veh.z + 0.8, this.lastHitBy);
    }

    get x() { return this.veh.x; }
    get y() { return this.veh.y; }
    get th() { return this.veh.th; }
    get speed() { return this.veh.speed; }

    // zHint: height of the surface to place on (deck vs road below)
    place(x, y, th, zHint = null) {
        const s = this.world.map.surfaceAt(x, y, _surf, zHint);
        this.vz = 0;
        this.veh.reset(x, y, th, s.h);
        this.zSmooth = s.h;
        this.pitch = this.roll = this.pitchV = this.rollV = 0;
        this.syncVisual(0);
    }

    // controls: {throttle, brake, steer, handbrake}. Returns impacts this frame.
    update(dt, controls = this.controls) {
        const v = this.veh, map = this.world.map;
        this.impacts.length = 0;
        this.scrapes.length = 0;
        const surf = map.surfaceAt(v.x, v.y, _surf, this.zSmooth + 0.5);
        this.surface = surf.kind;
        // deep water floods the engine
        this.inWater = surf.water;
        let ctl = controls;
        if (!this.alive || surf.water > 0.9) ctl = DEAD;
        const grip = GRIP[surf.kind] ?? 1;
        // static colliders around the car, fetched once per frame
        map.collidersNear(v.x, v.y, 8 + v.speed * dt * 2, _cols);
        this.acc += dt;
        let steps = 0;
        while (this.acc >= PHYS_DT && steps < 10) {
            this.acc -= PHYS_DT; steps++;
            v.step(PHYS_DT, ctl, grip);
            if (surf.water > 0.4) { const k = Math.exp(-PHYS_DT * (0.6 + surf.water)); v.vx *= k; v.vy *= k; v.r *= k; }
            this._collide();
        }
        if (steps === 10) this.acc = 0;
        // the map edge is open sea; a gentle current pushes back anyone who goes too far
        const B = map.bounds;
        if (v.x < B.x0 + 60) v.vx += 6 * dt; else if (v.x > B.x1 - 60) v.vx -= 6 * dt;
        if (v.y < B.y0 + 60) v.vy += 6 * dt; else if (v.y > B.y1 - 60) v.vy -= 6 * dt;
        this.syncVisual(dt);
        this._updateDamage(dt);
        return this.impacts;
    }

    _collide() {
        const v = this.veh, P = v.P;
        for (const b of _cols.boxes) {
            if (b.zMax !== undefined && (v.z > b.zMax - 0.3 || v.z + 1.5 < b.zMin)) continue;   // railing above / below us
            const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
            const hit = obbOverlap(v.x, v.y, v.th, P.halfLength, P.halfWidth, cx, cy, 0, (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2);
            if (!hit) continue;
            const tangential = Math.abs(v.vx * -hit.ny + v.vy * hit.nx);
            const s = v.collide(hit.nx, hit.ny, hit.depth, 0.2, 0.3);
            if (s > 0.5) this.impacts.push({ speed: s, nx: hit.nx, ny: hit.ny, kind: 'wall' });
            if (tangential > 4) this.scrapes.push({ x: v.x - hit.nx * P.halfWidth, y: v.y - hit.ny * P.halfWidth });
        }
        const cs = Math.cos(v.th), sn = Math.sin(v.th);
        for (const c of _cols.circles) {
            const dx = c.x - v.x, dy = c.y - v.y;
            if (dx * dx + dy * dy > 36) continue;
            if (c.zMax !== undefined && v.z > c.zMax - 0.3) continue;      // driving over a pillar
            if (c.fallen) continue;
            const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
            const qx = clamp(lx, -P.halfLength, P.halfLength), qy = clamp(ly, -P.halfWidth, P.halfWidth);
            const ex = lx - qx, ey = ly - qy;
            const dist = Math.hypot(ex, ey);
            let nx, ny, depth;
            if (dist > 1e-4) {
                if (dist >= c.r) continue;
                nx = -(ex * cs - ey * sn) / dist; ny = -(ex * sn + ey * cs) / dist; depth = c.r - dist;
            } else {
                const px = P.halfLength - Math.abs(lx), py = P.halfWidth - Math.abs(ly);
                if (px < py) { const sx = -Math.sign(lx); nx = sx * cs; ny = sx * sn; depth = px + c.r; }
                else { const sy = -Math.sign(ly); nx = -sy * sn; ny = sy * cs; depth = py + c.r; }
            }
            const s = v.collide(nx, ny, depth, 0.15, 0.4);
            if (s > 0.5) this.impacts.push({ speed: s * 1.2, nx, ny, kind: 'prop', prop: c });
        }
    }

    // Wheels follow the terrain; body pitches / rolls on springs.
    syncVisual(dt) {
        const v = this.veh, rig = this.rig, map = this.world.map;
        const c = Math.cos(v.th), s = Math.sin(v.th);
        const L = v.P.L, W = rig.track || 1.6;
        const hint = this.zSmooth + 0.6;
        const hAt = (fx, fy) => map.surfaceAt(v.x + fx, v.y + fy, _surf, hint).h;
        const hF = hAt(c * L / 2, s * L / 2), hB = hAt(-c * L / 2, -s * L / 2);
        const hL = hAt(-s * W / 2, c * W / 2), hR = hAt(s * W / 2, -c * W / 2);
        let zT = (hF + hB + hL + hR) / 4;
        if (this.inWater > 0.9) zT = Math.max(zT, CONFIG.map.seaLevel - 1.1);
        // gravity: drive off a ledge / bridge and you fall; otherwise follow the road
        this.vz = this.vz || 0;
        if (dt > 0 && zT < this.zSmooth - 0.35) {
            this.vz -= 9.81 * dt;
            this.zSmooth = Math.max(zT, this.zSmooth + this.vz * dt);
            this.airborne = true;
        } else {
            if (this.airborne && this.vz < -7) { this.damage((-this.vz - 7) * 60, this.driver === 'player' ? 'player' : null); this.landed = -this.vz; }
            this.airborne = false;
            this.vz = 0;
            this.zSmooth = dt > 0 ? damp(this.zSmooth, zT, 25, dt) : zT;
            if (zT - this.zSmooth > 1.5) this.zSmooth = zT;
        }
        v.z = this.zSmooth;
        if (this.hop) { this.hopV = (this.hopV ?? 6) - 18 * dt; this.hop = Math.max(0, this.hop + this.hopV * dt); if (this.hop === 0) this.hopV = undefined; }
        rig.root.position.set(v.x, this.zSmooth + (this.hop || 0), -v.y);
        const gp = Math.atan2(hF - hB, L), gr = Math.atan2(hL - hR, W);
        this.groundPitch = dt > 0 ? damp(this.groundPitch, gp, 18, dt) : gp;
        this.groundRoll = dt > 0 ? damp(this.groundRoll, gr, 18, dt) : gr;
        if (dt > 0) {
            const pitchT = clamp(-v.ax * 0.0065, -0.06, 0.06), rollT = clamp(v.ay * 0.0075, -0.07, 0.07);
            this.pitchV += ((pitchT - this.pitch) * 90 - this.pitchV * 11) * dt;
            this.rollV += ((rollT - this.roll) * 80 - this.rollV * 10) * dt;
            this.pitch += this.pitchV * dt; this.roll += this.rollV * dt;
        }
        rig.root.rotation.set(this.groundPitch, v.th - Math.PI / 2, -this.groundRoll);
        rig.body.rotation.set(-this.pitch, 0, -this.roll);
        for (const w of rig.wheels) {
            w.spin.rotation.x = -(w.front ? v.wheelSpin[0] : v.wheelSpin[1]);
            if (w.front) w.steer.rotation.y = v.steer;
        }
        if (rig.steering) rig.steering.pivot.quaternion.setFromAxisAngle(rig.steering.axis, v.steer * 9);
        if (rig.driverFigure) {
            // someone at the wheel (hidden in the player's own cockpit view)
            const g = this.world.game;
            rig.driverFigure.visible = !!this.driver && this.alive && !(this.driver === 'player' && g && g.cam.rig.current === 'cockpit');
        }
        const brake = v.brake > 0.05 || v.handbrake > 0;
        const tail = (this.lightsOn ? 1.0 : 0.25) + (brake && this.driver ? 3.0 : 0);
        for (const m of rig.mats.tail) m.emissiveIntensity = tail;
    }

    setLights(on) {
        if (this.lightsOn === on) return;
        this.lightsOn = on;
        for (const m of this.rig.mats.head) m.emissiveIntensity = on ? 3 : 0;
    }

    // A real spotlight only for the car the player drives (costly).
    setHeadlightSpot(on) {
        if (on && !this.spot) {
            const spot = new THREE.SpotLight(0xfff2dd, 420, 140, 0.55, 0.45, 1.2);
            spot.position.set(0, 0.75, -this.rig.dims.z / 2 + 0.2);
            spot.target.position.set(0, -0.6, -30);
            this.rig.root.add(spot, spot.target);
            this.spot = spot;
        }
        if (this.spot) this.spot.visible = on;
    }

    // point on the driver's side for getting in / out
    doorPoint(side = 1) {
        const v = this.veh, d = v.P.halfWidth + 0.9;
        return { x: v.x - Math.sin(v.th) * d * side, y: v.y + Math.cos(v.th) * d * side };
    }

    dispose() {
        this.world.scene.remove(this.rig.root);
        if (this.spot) this.spot.dispose();
    }
}

const DEAD = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
