// AI driver used by rival racers and police. Produces the same control inputs a
// human gives (throttle / brake / steer) so AI cars obey the same physics.
import { clamp } from './core/rng.js';

const G = 9.81;

export class AIDriver {
    constructor(car, road, { skill = 1, laneD = -1.75 } = {}) {
        this.car = car;
        this.road = road;
        this.skill = skill;       // grip usage 0.8 .. 1.0
        this.laneD = laneD;
        this.stuck = 0;
        this.reverse = 0;
        this.ctl = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    }

    // Highest safe speed for the road ahead within braking distance.
    cornerSpeed(s, v) {
        const road = this.road;
        const mu = this.car.veh.P.mu * 0.92 * this.skill;
        const brakeDecel = mu * G * 0.85;
        const horizon = Math.min(260, 25 + v * v / (2 * brakeDecel) + v * 0.6);
        let limit = 95;
        for (let ds = 0; ds < horizon && s + ds < road.frontS - 4; ds += 6) {
            const k = Math.abs(road.frameAt(s + ds).k);
            if (k < 1e-4) continue;
            const vc = Math.sqrt(mu * G / k);
            // speed we may have now so that we can brake down to vc in ds metres
            const allowed = Math.sqrt(vc * vc + 2 * brakeDecel * Math.max(0, ds - 8));
            limit = Math.min(limit, allowed);
        }
        return limit;
    }

    // Choose a lateral offset that avoids slow cars ahead.
    // obstacles: [{s, d, v}] (v along +s); lanes: candidate lateral offsets
    pickLane(obstacles, lanes, lookahead = 60) {
        const car = this.car;
        let best = this.laneD, bestFree = -1;
        const freeOf = (d) => {
            let free = lookahead;
            for (const o of obstacles) {
                const ds = o.s - car.s;
                if (ds < -3 || ds > lookahead) continue;
                if (Math.abs(o.d - d) < 2.4) free = Math.min(free, ds + (o.v > car.veh.forwardSpeed - 2 ? 30 : 0));
            }
            return free;
        };
        const cur = freeOf(this.laneD);
        if (cur >= lookahead) return this.laneD;
        for (const d of lanes) {
            const f = freeOf(d) - Math.abs(d - car.d) * 0.8;
            if (f > bestFree) { bestFree = f; best = d; }
        }
        if (bestFree > cur + 6) this.laneD = best;
        return this.laneD;
    }

    // target: {d, speed, chase: {x, y, vx, vy} | null, chaseWeight}
    drive(dt, target) {
        const car = this.car, v = car.veh, road = this.road;
        const speed = v.forwardSpeed;
        const ctl = this.ctl;
        // unstick: if pushing but not moving, back up for a moment
        if (this.reverse > 0) {
            this.reverse -= dt;
            ctl.throttle = 0; ctl.brake = 1; ctl.handbrake = 0;
            ctl.steer = clamp(car.d * 0.3, -1, 1) * -1;
            return ctl;
        }
        if (ctl.throttle > 0.5 && Math.abs(speed) < 1.2) { this.stuck += dt; if (this.stuck > 1.5) { this.reverse = 1.4; this.stuck = 0; } }
        else this.stuck = 0;

        const look = 9 + Math.abs(speed) * 0.75;
        const p = road.pointAt(Math.min(car.s + look, road.frontS - 2), target.d);
        let tx = p.px, ty = p.py;
        if (target.chase) {
            const c = target.chase;
            const dist = Math.hypot(c.x - v.x, c.y - v.y);
            const lead = clamp(dist / Math.max(8, speed), 0, 1.2);
            const px = c.x + c.vx * lead, py = c.y + c.vy * lead;
            const w = clamp(target.chaseWeight ?? (1 - (dist - 15) / 30), 0, 1);
            tx = tx + (px - tx) * w; ty = ty + (py - ty) * w;
        }
        let err = Math.atan2(ty - v.y, tx - v.x) - v.th;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        ctl.steer = clamp(-err * (2.2 + 0.02 * speed), -1, 1);

        const vmax = Math.min(target.speed, this.cornerSpeed(car.s, speed));
        const errV = vmax - speed;
        ctl.throttle = errV > 0 ? clamp(errV * 0.6, 0.15, 1) : 0;
        ctl.brake = errV < -1.5 ? clamp(-errV * 0.25, 0, 1) : 0;
        ctl.handbrake = 0;
        return ctl;
    }
}
