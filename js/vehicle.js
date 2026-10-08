// Vehicle dynamics: bicycle model with load transfer, Pacejka-style tyre
// saturation, combined slip (friction circle), engine torque curve, gearbox,
// aero drag/downforce, brakes and handbrake. Runs at a fixed 120 Hz.
//
// Coordinates are the 2D map frame (x, y), heading th (CCW, rad), z = height.
import { clamp, lerp } from './core/rng.js';

const G = 9.81;
const RHO = 1.225;
export const PHYS_DT = 1 / 120;

// Simplified magic formula. `cs` is cornering stiffness per unit load (1/rad),
// `shape` controls how much grip falls off past the peak slip angle.
function tyre(alpha, cs, fz, fmax, shape) {
    if (fmax <= 0) return 0;
    const B = cs * fz / (shape * fmax);
    return -fmax * Math.sin(shape * Math.atan(B * alpha));
}

function curve(table, rpm) {
    if (rpm <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (rpm <= table[i][0]) {
            const [r0, t0] = table[i - 1], [r1, t1] = table[i];
            return lerp(t0, t1, (rpm - r0) / (r1 - r0));
        }
    }
    return table[table.length - 1][1];
}

export class Vehicle {
    constructor(spec, rig) {
        this.spec = spec;
        const P = this.P = { ...spec.physics };
        // geometry from the actual model
        if (rig) {
            const L = rig.wheelbase;
            const ratio = P.a / (P.a + P.b);
            P.a = L * ratio; P.b = L * (1 - ratio);
            P.radius = rig.wheels[0].radius;
            P.halfWidth = rig.dims.x / 2 * 0.92;
            P.halfLength = rig.dims.z / 2;
        } else {
            P.radius = 0.34; P.halfWidth = 0.95; P.halfLength = 2.25;
        }
        P.L = P.a + P.b;
        this.assists = { tcs: true, esc: true, abs: true, auto: true };
        this.reset(0, 0, Math.PI / 2, 0);
    }

    reset(x, y, th, z) {
        this.x = x; this.y = y; this.z = z; this.th = th;
        this.vx = 0; this.vy = 0; this.r = 0;
        this.steer = 0;           // actual front wheel angle (rad, +left)
        this.gear = 1;
        this.rpm = this.P.idle;
        this.shiftTimer = 0;
        this.clutch = 1;
        this.ax = 0; this.ay = 0;
        this.wheelSpin = [0, 0];  // front, rear angular position
        this.wheelOmega = 0;
        this.slipFront = 0; this.slipRear = 0;
        this.wheelspin = 0;       // 0..1 rear wheelspin amount
        this.skid = 0;            // 0..1 tyre noise
        this.throttle = 0; this.brake = 0; this.handbrake = 0;
        this.reverseHold = 0;
        this.limiter = false;
        this.revCut = 0;
    }

    get speed() { return Math.hypot(this.vx, this.vy); }
    get forwardSpeed() { return this.vx * Math.cos(this.th) + this.vy * Math.sin(this.th); }

    shift(dir) {
        if (this.shiftTimer > 0) return;
        const n = this.P.gears.length;
        if (dir > 0) {
            if (this.gear === -1) this.gear = 1;
            else if (this.gear < n) this.gear++;
            else return;
        } else {
            if (this.gear > 1) this.gear--;
            else if (this.gear === 1 && this.forwardSpeed < 2) this.gear = -1;
            else return;
        }
        this.shiftTimer = 0.12;
    }

    gearRatio() {
        if (this.gear === -1) return -this.P.reverse;
        return this.P.gears[this.gear - 1];
    }

    // input: {throttle 0..1, brake 0..1, steer -1..1 (+right), handbrake 0..1}
    step(dt, input, surfaceGrip = 1) {
        const P = this.P;
        const c = Math.cos(this.th), s = Math.sin(this.th);
        let vLong = this.vx * c + this.vy * s;
        let vLat = -this.vx * s + this.vy * c;
        const speed = Math.hypot(vLong, vLat);

        // --- automatic gearbox & reverse logic ---
        let throttle = input.throttle, brake = input.brake;
        if (this.assists.auto) {
            if (this.gear === -1) {
                // in reverse: brake pedal drives backwards, throttle brakes
                if (input.throttle > 0.1 && vLong > -0.5) { this.gear = 1; }
                else { const t = throttle; throttle = brake; brake = t; }
            } else if (input.brake > 0.1 && vLong < 0.6 && input.throttle < 0.1) {
                this.reverseHold += dt;
                if (this.reverseHold > 0.25) { this.gear = -1; throttle = brake; brake = 0; }
            } else this.reverseHold = 0;
        } else if (this.gear === -1) {
            // manual reverse: throttle drives backwards
        }
        this.throttle = throttle; this.brake = brake; this.handbrake = input.handbrake;

        // --- steering: speed sensitive lock, smooth rack ---
        // speed-sensitive lock, capped near what the tyres can actually use
        const gripLock = P.L * 1.5 * G / Math.max(speed * speed, 1) + 0.1;
        const lock = Math.min(P.maxSteer / (1 + (speed * speed) / (30 * 30)), gripLock);
        const target = -input.steer * lock;
        const rate = 2.6 * (input.steer === 0 ? 1.4 : 1);
        this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
        const delta = this.steer;

        // --- loads ---
        const aero = 0.5 * RHO * P.clA * speed * speed;
        const W = P.mass * G;
        const transfer = P.mass * this.ax * P.cgHeight / P.L;
        let fzF = W * P.b / P.L - transfer + aero * 0.45;
        let fzR = W * P.a / P.L + transfer + aero * 0.55;
        fzF = Math.max(fzF, 200); fzR = Math.max(fzR, 200);

        // --- drivetrain ---
        const ratio = this.gearRatio() * P.final;
        const wheelRpm = (vLong / P.radius) * 60 / (2 * Math.PI);
        let rpm = Math.abs(wheelRpm * ratio);
        // clutch slip at launch
        const launch = P.idle + 2200 * throttle;
        if (rpm < launch) { rpm = lerp(rpm, launch, this.gear === -1 ? 0.8 : 0.85); }
        this.shiftTimer = Math.max(0, this.shiftTimer - dt);
        let torque = curve(P.torque, rpm) * throttle;
        if (rpm >= P.redline) { this.revCut = 0.06; }
        if (this.revCut > 0) { this.revCut -= dt; torque = 0; this.limiter = true; } else this.limiter = false;
        if (this.shiftTimer > 0) torque *= 0.15;
        // engine braking when lifting
        torque -= (1 - throttle) * (35 + 0.012 * rpm) * Math.sign(vLong || 1) * Math.sign(ratio) * (Math.abs(vLong) > 0.5 ? 1 : 0);
        let fDrive = torque * ratio * P.efficiency / P.radius;
        this.rpm = lerp(this.rpm, clamp(rpm, P.idle * 0.9, P.redline + 150), 0.35);

        if (this.assists.auto && this.gear > 0 && this.shiftTimer <= 0) {
            const n = P.gears.length;
            if (this.rpm > P.redline * 0.965 && this.gear < n && throttle > 0.2) { this.gear++; this.shiftTimer = 0.14; }
            else if (this.gear > 1) {
                const down = P.gears[this.gear - 2] * P.final * Math.abs(wheelRpm);
                const thresh = P.redline * (throttle > 0.6 ? 0.62 : 0.42);
                if (this.rpm < thresh && down < P.redline * 0.88) { this.gear--; this.shiftTimer = 0.1; }
            }
        }

        // --- brakes ---
        const brakeTotal = brake * P.brake * W;
        const sgn = Math.abs(vLong) > 0.05 ? Math.sign(vLong) : 0;
        let fBrakeF = -sgn * brakeTotal * 0.62;
        let fBrakeR = -sgn * brakeTotal * 0.38;
        if (input.handbrake > 0) fBrakeR += -sgn * input.handbrake * 0.8 * fzR * P.mu;

        // --- tyre slip angles ---
        const vDen = Math.max(Math.abs(vLong), 2.5);
        const dirSign = vLong >= -0.2 ? 1 : -1;
        const alphaF = Math.atan2(vLat + P.a * this.r, vDen) - delta * dirSign;
        const alphaR = Math.atan2(vLat - P.b * this.r, vDen);
        const mu = P.mu * surfaceGrip;
        let gripR = mu * fzR;
        const gripF = mu * P.frontGrip * fzF;   // fronts let go first -> safe understeer at the limit
        if (input.handbrake > 0) gripR *= 1 - 0.55 * input.handbrake;

        // longitudinal on rear (drive + brake), traction limited
        let fxR = fDrive + fBrakeR;
        // TCS also leaves lateral grip in reserve when the rear is already sliding
        const tcLimit = gripR * (this.assists.tcs ? clamp(0.95 - 4 * Math.abs(alphaR), 0.3, 0.95) : 1.0);
        this.wheelspin = 0;
        if (Math.abs(fxR) > tcLimit) {
            this.wheelspin = clamp((Math.abs(fxR) - tcLimit) / tcLimit, 0, 1);
            fxR = Math.sign(fxR) * (this.assists.tcs ? tcLimit : gripR * 0.85);
        }
        let fxF = fBrakeF;
        if (Math.abs(fxF) > gripF * 0.98) fxF = Math.sign(fxF) * gripF * (this.assists.abs ? 0.98 : 0.8);

        // friction circle: lateral capacity left after longitudinal use
        const latR = Math.sqrt(Math.max(0, gripR * gripR - fxR * fxR)) * (this.wheelspin > 0 && !this.assists.tcs ? 0.75 : 1);
        const latF = Math.sqrt(Math.max(0, gripF * gripF - fxF * fxF));
        let fyF = tyre(alphaF, P.csF, fzF, latF, 1.5);
        let fyR = tyre(alphaR, P.csR, fzR, latR, input.handbrake > 0 ? 1.6 : 1.3);

        // --- aero drag + rolling ---
        const drag = 0.5 * RHO * P.cdA * vLong * Math.abs(vLong);
        const roll = 4.0 * vLong + (Math.abs(vLong) > 0.1 ? Math.sign(vLong) * 0.012 * W : 0);

        const cd = Math.cos(delta), sd = Math.sin(delta);
        const fx = fxR + fxF * cd - fyF * sd - drag - roll;
        const fy = fyR + fyF * cd + fxF * sd;
        let torqueZ = P.a * (fyF * cd + fxF * sd) - P.b * fyR;

        // stability control: damp excessive yaw / rear slide
        if (this.assists.esc && speed > 6 && !(input.handbrake > 0)) {
            // target yaw rate: driver request, limited by available grip
            const rMax = mu * G / Math.max(speed, 1) * 1.05;
            const yawRef = clamp(vLong * Math.tan(delta) / P.L, -rMax, rMax);
            const err = this.r - yawRef;
            if (Math.sign(err) === Math.sign(this.r) || Math.abs(alphaR) > 0.12) {
                torqueZ -= err * P.inertia * 4.0;
            }
        }

        // --- integrate (body frame) ---
        let dvLong = fx / P.mass + this.r * vLat;
        let dvLat = fy / P.mass - this.r * vLong;
        // prevent brakes / rolling from reversing direction
        const newLong = vLong + dvLong * dt;
        if (throttle < 0.05 && Math.sign(newLong) !== Math.sign(vLong) && Math.abs(vLong) < 1.5) {
            dvLong = -vLong / dt;
        }
        vLong += dvLong * dt;
        vLat += dvLat * dt;
        this.r += (torqueZ / P.inertia) * dt;

        // low-speed blending to kinematic model (tyre model is ill-defined near 0)
        const k = clamp((speed - 1.0) / 5, 0, 1);
        const rKin = vLong * Math.tan(delta) / P.L;
        this.r = lerp(rKin, this.r, k);
        vLat = lerp(vLat * 0.85, vLat, k);
        if (speed < 0.15 && throttle < 0.05) { vLong = 0; vLat = 0; this.r = 0; }

        // accelerometer-style accelerations (what the body feels) drive load transfer
        this.ax = lerp(this.ax, fx / P.mass, 0.2);
        this.ay = lerp(this.ay, fy / P.mass, 0.2);
        this.slipFront = alphaF; this.slipRear = alphaR;
        const latSlide = Math.abs(vLat) > 1.5 ? clamp((Math.abs(alphaR) - 0.08) * 4, 0, 1) : 0;
        const brakeLock = brake > 0.85 && speed > 8 && !this.assists.abs ? 0.6 : 0;
        this.skid = Math.max(latSlide, this.wheelspin * clamp(speed / 5, 0.3, 1), brakeLock, input.handbrake > 0 && speed > 5 ? 0.7 : 0);

        this.th += this.r * dt;
        const c2 = Math.cos(this.th), s2 = Math.sin(this.th);
        this.vx = vLong * c2 - vLat * s2;
        this.vy = vLong * s2 + vLat * c2;
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // wheel rotation for visuals
        const spinBoost = this.wheelspin * 25 * Math.sign(fDrive || 1);
        this.wheelOmega = vLong / P.radius;
        this.wheelSpin[0] += this.wheelOmega * dt;
        this.wheelSpin[1] += (this.wheelOmega + spinBoost) * dt;
    }

    // Collision response against a wall with outward normal (nx, ny) (pointing back into the road).
    collide(nx, ny, depth, restitution = 0.25, friction = 0.25) {
        this.x += nx * depth; this.y += ny * depth;
        const vn = this.vx * nx + this.vy * ny;
        if (vn < 0) {
            this.vx -= (1 + restitution) * vn * nx;
            this.vy -= (1 + restitution) * vn * ny;
            // tangential scrape
            const tx = -ny, ty = nx;
            const vt = this.vx * tx + this.vy * ty;
            const loss = Math.min(Math.abs(vt), -vn * friction);
            this.vx -= Math.sign(vt) * loss * tx;
            this.vy -= Math.sign(vt) * loss * ty;
            this.r *= 0.6;
            return -vn;
        }
        return 0;
    }
}
