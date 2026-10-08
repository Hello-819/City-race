// A drivable car: physics + road constraints + visual rig (wheels, steering
// wheel, suspension motion, lights) + health / damage. Used for the player,
// AI racers and police.
import * as THREE from 'three';
import { Vehicle, PHYS_DT } from './vehicle.js';
import { clamp, damp } from './core/rng.js';
import { Deformer } from './damage.js';

export class Car {
    constructor(rig, scene, { night = false, player = false, deformable = false } = {}) {
        this.rig = rig;
        this.veh = new Vehicle(rig.spec, rig);
        this.scene = scene;
        this.player = player;
        scene.add(rig.root);
        rig.root.rotation.order = 'YXZ';
        this.acc = 0;
        this.s = 0; this.d = 0; this.idx = 0;
        this.zSmooth = 0;
        this.pitch = 0; this.roll = 0; this.pitchV = 0; this.rollV = 0;
        this.groundPitch = 0; this.groundRoll = 0;
        this.impacts = [];
        this.scrapes = [];
        this.night = night;
        this.loc = {};
        this.health = 100;
        this.exploded = false;
        this.frontHits = 0; this.rearHits = 0;
        this.lightsBroken = { head: false, tail: false };
        this.deformer = deformable ? new Deformer(rig) : null;
        const engineRear = rig.spec.engine === 'rear';
        this.enginePos = new THREE.Vector3(0, rig.dims.y * 0.75, (engineRear ? 0.32 : -0.3) * rig.dims.z);
        if (night && player) {
            const spot = new THREE.SpotLight(0xfff2dd, 420, 160, 0.5, 0.45, 1.15);
            spot.position.set(0, 0.75, -rig.dims.z / 2 + 0.2);
            spot.target.position.set(0, -0.6, -30);
            rig.root.add(spot, spot.target);
            this.spot = spot;
        }
        this.headI = night ? 3 : 0;
        for (const m of rig.mats.head) m.emissiveIntensity = this.headI;
    }

    place(road, s, d) {
        const p = road.pointAt(s, d);
        this.veh.reset(p.px, p.py, p.th, p.pz);
        this.s = s; this.d = d; this.idx = Math.floor(s / 2);
        this.zSmooth = p.pz;
        this.pitch = this.roll = this.pitchV = this.rollV = 0;
        this.syncVisual(road, 0);
    }

    // controls: {throttle, brake, steer, handbrake}; returns wall/prop impacts this frame
    update(dt, controls, world) {
        const road = world.road;
        const v = this.veh;
        this.impacts.length = 0;
        this.scrapes.length = 0;
        const ctl = this.exploded ? { throttle: 0, brake: 0.6, steer: 0, handbrake: 1 } : controls;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= PHYS_DT && steps < 12) {
            this.acc -= PHYS_DT; steps++;
            const P = road.p;
            const grip = Math.abs(this.d) > P.roadHalf ? (P.kind === 'city' ? 0.92 : 0.72) : 1;
            v.step(PHYS_DT, ctl, grip);
            this._constrain(road, world);
        }
        if (steps === 12) this.acc = 0;
        this.syncVisual(road, dt);
        return this.impacts;
    }

    _constrain(road, world) {
        const v = this.veh, P = road.p;
        const loc = road.locate(v.x, v.y, this.idx, this.loc);
        if (!loc) return;
        this.idx = loc.idx; this.s = loc.s; this.d = loc.d;
        const rel = v.th - loc.th;
        const extent = Math.abs(Math.sin(rel)) * v.P.halfLength + Math.abs(Math.cos(rel)) * v.P.halfWidth;
        const limit = (road.wallAt ? road.wallAt(loc.s) : P.wall) - extent;
        const lx = -Math.sin(loc.th), ly = Math.cos(loc.th);
        for (const side of [1, -1]) {
            if (loc.d * side <= limit) continue;
            const nx = -lx * side, ny = -ly * side;
            const tangential = Math.abs(v.vx * -ny + v.vy * nx);
            const hit = v.collide(nx, ny, loc.d * side - limit, 0.2, 0.3);
            if (hit > 0.5) this.impacts.push({ speed: hit, nx, ny, kind: 'wall' });
            if (tangential > 4) this.scrapes.push({ x: v.x - nx * v.P.halfWidth, y: v.y - ny * v.P.halfWidth, side });
            this.d = limit * side;
        }
        // static props (lamp posts, trees, signals)
        const cs = Math.cos(v.th), sn = Math.sin(v.th);
        for (const c of world.colliders(this.s)) {
            const dx = c.x - v.x, dy = c.y - v.y;
            if (dx * dx + dy * dy > 36) continue;
            const lxp = dx * cs + dy * sn, lyp = -dx * sn + dy * cs;
            const qx = clamp(lxp, -v.P.halfLength, v.P.halfLength), qy = clamp(lyp, -v.P.halfWidth, v.P.halfWidth);
            const ex = lxp - qx, ey = lyp - qy;
            const dist = Math.hypot(ex, ey);
            let nx, ny, depth;
            if (dist > 1e-4) {
                if (dist >= c.r) continue;
                nx = -(ex * cs - ey * sn) / dist; ny = -(ex * sn + ey * cs) / dist; depth = c.r - dist;
            } else {
                const px = v.P.halfLength - Math.abs(lxp), py = v.P.halfWidth - Math.abs(lyp);
                if (px < py) { const sx = -Math.sign(lxp); nx = sx * cs; ny = sx * sn; depth = px + c.r; }
                else { const sy = -Math.sign(lyp); nx = -sy * sn; ny = sy * cs; depth = py + c.r; }
            }
            const hit = v.collide(nx, ny, depth, 0.15, 0.4);
            if (hit > 0.5) this.impacts.push({ speed: hit * 1.2, nx, ny, kind: 'prop', prop: c });
        }
    }

    // Apply damage from an impact with world normal (nx, ny) pointing from the obstacle into the car.
    applyImpact(speed, nx, ny, mult = 1) {
        if (this.exploded) return 0;
        const dmg = Math.pow(Math.max(0, speed - 3), 1.2) * 1.25 * mult;
        if (dmg <= 0) return 0;
        this.health = Math.max(0, this.health - dmg);
        const v = this.veh, rig = this.rig;
        // contact point in body space (model faces -Z, right = +X)
        const f = nx * Math.cos(v.th) + ny * Math.sin(v.th);
        const l = nx * -Math.sin(v.th) + ny * Math.cos(v.th);
        const ux = l, uz = f;                     // direction from centre towards the obstacle (= -n) in model space
        const hw = rig.dims.x / 2, hl = rig.dims.z / 2;
        const t = Math.min(hw / Math.max(Math.abs(ux), 1e-3), hl / Math.max(Math.abs(uz), 1e-3));
        const point = new THREE.Vector3(ux * t * 0.98, rig.dims.y * 0.42, uz * t * 0.98);
        if (this.deformer && dmg > 2) {
            const inward = new THREE.Vector3(-ux, -0.15, -uz).normalize();
            this.deformer.dent(point, inward, Math.min(0.22, 0.03 + dmg * 0.006), 0.55 + Math.min(0.6, dmg * 0.02));
        }
        if (point.z < -hl * 0.6) this.frontHits += dmg > 8 ? 1 : 0;
        if (point.z > hl * 0.6) this.rearHits += dmg > 8 ? 1 : 0;
        if (this.frontHits >= 2 && !this.lightsBroken.head) {
            this.lightsBroken.head = true;
            for (const m of rig.mats.head) m.emissiveIntensity = 0;
            if (this.spot) this.spot.intensity *= 0.25;
        }
        if (this.rearHits >= 2) this.lightsBroken.tail = true;
        return dmg;
    }

    explode() {
        this.exploded = true;
        this.health = 0;
        // charred shell
        this.rig.root.traverse((o) => {
            if (!o.isMesh || o === this.rig.shadow) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                if (!m.color || m.userData.charred) continue;
                m.color.setRGB(0.02, 0.018, 0.016); if ('roughness' in m) m.roughness = 1; if ('metalness' in m) m.metalness = 0.05;
                if ('clearcoat' in m) m.clearcoat = 0; if ('envMapIntensity' in m) m.envMapIntensity = 0.15;
                if (m.transparent) m.opacity = 0.05;
                if (m.emissive) m.emissiveIntensity = 0;
                m.userData.charred = true;
            }
        });
        if (this.spot) this.spot.intensity = 0;
    }

    syncVisual(road, dt) {
        const v = this.veh, rig = this.rig;
        const zTarget = road.heightAt(this.s, this.d);
        this.zSmooth = dt > 0 ? damp(this.zSmooth, zTarget, 25, dt) : zTarget;
        if (Math.abs(this.zSmooth - zTarget) > 1) this.zSmooth = zTarget;
        v.z = this.zSmooth;
        rig.root.position.set(v.x, this.zSmooth, -v.y);

        const L = v.P.L, W = rig.track || 1.6;
        const f = road.frameAt(this.s);
        const rel = v.th - f.th;
        const cr = Math.cos(rel), sr = Math.sin(rel);
        const hF = road.heightAt(this.s + cr * L / 2, this.d + sr * L / 2);
        const hB = road.heightAt(this.s - cr * L / 2, this.d - sr * L / 2);
        const hL = road.heightAt(this.s - sr * W / 2, this.d + cr * W / 2);
        const hR = road.heightAt(this.s + sr * W / 2, this.d - cr * W / 2);
        const gp = Math.atan2(hF - hB, L), gr = Math.atan2(hL - hR, W);
        this.groundPitch = dt > 0 ? damp(this.groundPitch, gp, 18, dt) : gp;
        this.groundRoll = dt > 0 ? damp(this.groundRoll, gr, 18, dt) : gr;

        if (dt > 0) {
            const kP = 90, cP = 11, kR = 80, cR = 10;
            const pitchT = clamp(-v.ax * 0.0065, -0.06, 0.06);
            const rollT = clamp(v.ay * 0.0075, -0.07, 0.07);
            this.pitchV += ((pitchT - this.pitch) * kP - this.pitchV * cP) * dt;
            this.rollV += ((rollT - this.roll) * kR - this.rollV * cR) * dt;
            this.pitch += this.pitchV * dt; this.roll += this.rollV * dt;
        }
        rig.root.rotation.set(this.groundPitch, v.th - Math.PI / 2, -this.groundRoll);
        rig.body.rotation.set(-this.pitch, 0, -this.roll);
        rig.body.position.y = -Math.abs(this.roll) * 0.2;

        for (const w of rig.wheels) {
            w.spin.rotation.x = -(w.front ? v.wheelSpin[0] : v.wheelSpin[1]);
            if (w.front) w.steer.rotation.y = v.steer;
        }
        if (rig.steering) rig.steering.pivot.quaternion.setFromAxisAngle(rig.steering.axis, v.steer * 9);
        if (!this.exploded) {
            const brake = v.brake > 0.05 || v.handbrake > 0;
            const tail = this.lightsBroken.tail ? 0.05 : (this.night ? 1.0 : 0.35) + (brake ? 3.0 : 0);
            for (const m of rig.mats.tail) m.emissiveIntensity = tail;
        }
    }

    dispose() { this.scene.remove(this.rig.root); }
}

// backwards compatible name
export { Car as PlayerCar };
