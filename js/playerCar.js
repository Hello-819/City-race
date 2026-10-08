// The player's car: physics + road constraints + visual rig (wheels, steering
// wheel, suspension motion, lights).
import * as THREE from 'three';
import { Vehicle, PHYS_DT } from './vehicle.js';
import { clamp, damp, lerp } from './core/rng.js';

export class PlayerCar {
    constructor(rig, scene, night) {
        this.rig = rig;
        this.veh = new Vehicle(rig.spec, rig);
        this.scene = scene;
        scene.add(rig.root);
        rig.root.rotation.order = 'YXZ';
        this.acc = 0;
        this.s = 0; this.d = 0; this.idx = 0;
        this.zSmooth = 0;
        this.pitch = 0; this.roll = 0; this.pitchV = 0; this.rollV = 0;
        this.groundPitch = 0; this.groundRoll = 0;
        this.impacts = [];
        this.offroad = false;
        this.night = night;
        this.loc = {};
        if (night) {
            const spot = new THREE.SpotLight(0xfff2dd, 420, 160, 0.5, 0.45, 1.15);
            spot.position.set(0, 0.75, -rig.dims.z / 2 + 0.2);
            spot.target.position.set(0, -0.6, -30);
            rig.root.add(spot, spot.target);
            this.spot = spot;
            for (const m of rig.mats.head) m.emissiveIntensity = 3;
        }
    }

    place(road, s, d) {
        const p = road.pointAt(s, d);
        this.veh.reset(p.px, p.py, p.th, p.pz);
        this.s = s; this.d = d; this.idx = Math.floor(s / 2);
        this.zSmooth = p.pz;
        this.pitch = this.roll = this.pitchV = this.rollV = 0;
        this._syncVisual(road, 0);
    }

    // returns list of wall impact speeds this frame
    update(dt, input, world, controlsEnabled) {
        const road = world.road;
        const v = this.veh;
        this.impacts.length = 0;
        const ctl = controlsEnabled ? {
            throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake,
        } : { throttle: 0, brake: 0, steer: 0, handbrake: 1 };

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
        this._syncVisual(road, dt);
        return this.impacts;
    }

    _constrain(road, world) {
        const v = this.veh, P = road.p;
        const loc = road.locate(v.x, v.y, this.idx, this.loc);
        if (!loc) return;
        this.idx = loc.idx; this.s = loc.s; this.d = loc.d;
        // walls (building line / guardrails), accounting for the car's yaw relative to the road
        const rel = v.th - loc.th;
        const extent = Math.abs(Math.sin(rel)) * v.P.halfLength + Math.abs(Math.cos(rel)) * v.P.halfWidth;
        let limit = P.wall - extent;
        // city cross streets have barriers at the same line, so the boundary is continuous
        const lx = -Math.sin(loc.th), ly = Math.cos(loc.th);
        if (loc.d > limit) {
            const hit = v.collide(-lx, -ly, loc.d - limit, 0.2, 0.3);
            if (hit > 0.5) this.impacts.push(hit);
            this.d = limit;
        } else if (loc.d < -limit) {
            const hit = v.collide(lx, ly, -limit - loc.d, 0.2, 0.3);
            if (hit > 0.5) this.impacts.push(hit);
            this.d = -limit;
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
                // normal from post to car (world)
                const wx = -(ex * cs - ey * sn) / dist, wy = -(ex * sn + ey * cs) / dist;
                nx = wx; ny = wy; depth = c.r - dist;
            } else {
                // centre inside the rectangle: push out along the shallowest axis
                const px = v.P.halfLength - Math.abs(lxp), py = v.P.halfWidth - Math.abs(lyp);
                if (px < py) { const sx = -Math.sign(lxp); nx = sx * cs; ny = sx * sn; depth = px + c.r; }
                else { const sy = -Math.sign(lyp); nx = -sy * sn; ny = sy * cs; depth = py + c.r; }
            }
            const hit = v.collide(nx, ny, depth, 0.15, 0.4);
            if (hit > 0.5) this.impacts.push(hit * 1.2);
        }
    }

    _syncVisual(road, dt) {
        const v = this.veh, rig = this.rig, P = road.p;
        const zTarget = road.heightAt(this.s, this.d);
        this.zSmooth = dt > 0 ? damp(this.zSmooth, zTarget, 25, dt) : zTarget;
        if (Math.abs(this.zSmooth - zTarget) > 1) this.zSmooth = zTarget;
        v.z = this.zSmooth;
        rig.root.position.set(v.x, this.zSmooth, -v.y);

        // ground orientation from the road surface under the wheels
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

        // suspension: spring-damper on body pitch / roll driven by accelerations
        if (dt > 0) {
            const kP = 90, cP = 11, kR = 80, cR = 10;
            const pitchT = clamp(-v.ax * 0.0065, -0.06, 0.06);   // squat / dive (nose up when accelerating)
            const rollT = clamp(v.ay * 0.0075, -0.07, 0.07);     // lean out of corners
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
        if (rig.steering) {
            const q = new THREE.Quaternion().setFromAxisAngle(rig.steering.axis, v.steer * 9);
            rig.steering.pivot.quaternion.copy(q);
        }
        const brake = v.brake > 0.05 || v.handbrake > 0;
        for (const m of rig.mats.tail) m.emissiveIntensity = (this.night ? 1.0 : 0.35) + (brake ? 3.0 : 0);
    }

    dispose() { this.scene.remove(this.rig.root); }
}
