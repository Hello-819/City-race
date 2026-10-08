// Replay: records every moving actor into a ring buffer (30 Hz, last 45 s) and
// plays it back with cinematic cameras.
import * as THREE from 'three';
import { clamp, damp } from './core/rng.js';

const RATE = 30, SECONDS = 45;

export class Recorder {
    constructor(channels) {
        this.channels = channels.filter(Boolean);
        this.size = this.channels.reduce((n, c) => n + c.captureSize, 0);
        this.max = RATE * SECONDS;
        this.frames = [];
        this.times = new Float32Array(this.max);
        this.count = 0; this.head = 0; this.next = 0;
        this.events = [];   // {t, type, pos}
    }

    record(t) {
        if (t < this.next) return;
        this.next = t + 1 / RATE;
        let buf = this.frames[this.head];
        if (!buf) buf = this.frames[this.head] = new Float32Array(this.size);
        let o = 0;
        for (const c of this.channels) o = c.capture(buf, o);
        this.times[this.head] = t;
        this.head = (this.head + 1) % this.max;
        this.count = Math.min(this.max, this.count + 1);
        const t0 = this.startTime;
        while (this.events.length && this.events[0].t < t0) this.events.shift();
    }

    event(t, type, pos) { this.events.push({ t, type, pos: pos.clone() }); }

    frameIndex(k) { return (this.head - this.count + k + this.max) % this.max; }
    get startTime() { return this.count ? this.times[this.frameIndex(0)] : 0; }
    get endTime() { return this.count ? this.times[this.frameIndex(this.count - 1)] : 0; }

    // apply recorded state at time t (interpolated)
    apply(t, dt) {
        if (this.count < 2) return;
        // binary search
        let lo = 0, hi = this.count - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.times[this.frameIndex(mid)] <= t) lo = mid; else hi = mid; }
        const ia = this.frameIndex(lo), ib = this.frameIndex(hi);
        const ta = this.times[ia], tb = this.times[ib];
        const k = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
        const a = this.frames[ia], b = this.frames[ib];
        let o = 0;
        for (const c of this.channels) o = c.apply(a, b, k, o, dt);
    }
}

// Channel for a Car (player): root, body, wheels, effects state
export function carChannel(car) {
    const rig = car.rig;
    const q = new THREE.Quaternion();
    return {
        captureSize: 7 + 4 + 4 + 2,
        capture(buf, o) {
            const r = rig.root;
            buf[o++] = r.position.x; buf[o++] = r.position.y; buf[o++] = r.position.z;
            buf[o++] = r.quaternion.x; buf[o++] = r.quaternion.y; buf[o++] = r.quaternion.z; buf[o++] = r.quaternion.w;
            const b = rig.body.quaternion;
            buf[o++] = b.x; buf[o++] = b.y; buf[o++] = b.z; buf[o++] = b.w;
            buf[o++] = car.veh.wheelSpin[0]; buf[o++] = car.veh.wheelSpin[1]; buf[o++] = car.veh.steer; buf[o++] = car.veh.skid;
            buf[o++] = 100; buf[o++] = car.veh.speed;
            return o;
        },
        apply(a, b, t, o) {
            const r = rig.root;
            r.position.set(a[o] + (b[o] - a[o]) * t, a[o + 1] + (b[o + 1] - a[o + 1]) * t, a[o + 2] + (b[o + 2] - a[o + 2]) * t);
            r.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]).slerp(q.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]), t);
            rig.body.quaternion.set(a[o + 7], a[o + 8], a[o + 9], a[o + 10]);
            const sf = a[o + 11] + (b[o + 11] - a[o + 11]) * t, sr = a[o + 12] + (b[o + 12] - a[o + 12]) * t;
            for (const w of rig.wheels) { w.spin.rotation.x = -(w.front ? sf : sr); if (w.front) w.steer.rotation.y = a[o + 13]; }
            car.replaySkid = a[o + 14]; car.replayHealth = a[o + 15]; car.replaySpeed = a[o + 16];
            return o + 17;
        },
    };
}

// Channel for traffic: root + wheel angle per car
export function trafficChannel(traffic) {
    return {
        captureSize: traffic.cars.length * 9,
        capture(buf, o) {
            for (const c of traffic.cars) {
                const r = c.rig.root;
                buf[o++] = r.position.x; buf[o++] = r.position.y; buf[o++] = r.position.z;
                buf[o++] = r.quaternion.x; buf[o++] = r.quaternion.y; buf[o++] = r.quaternion.z; buf[o++] = r.quaternion.w;
                buf[o++] = r.visible ? 1 : 0; buf[o++] = c.wheelAngle;
            }
            return o;
        },
        apply(a, b, t, o) {
            for (const c of traffic.cars) {
                const r = c.rig.root;
                const jump = Math.abs(b[o] - a[o]) + Math.abs(b[o + 2] - a[o + 2]) > 20;   // respawned
                const k = jump ? 0 : t;
                r.position.set(a[o] + (b[o] - a[o]) * k, a[o + 1] + (b[o + 1] - a[o + 1]) * k, a[o + 2] + (b[o + 2] - a[o + 2]) * k);
                r.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
                r.visible = a[o + 7] > 0.5;
                for (const w of c.rig.wheels) w.spin.rotation.x = a[o + 8];
                o += 9;
            }
            if (traffic.glows) traffic._updateGlows();
            return o;
        },
    };
}

const CAMS = ['trackside', 'orbit', 'heli', 'wheel', 'chase'];

export class ReplayDirector {
    constructor(recorder, camera, road, playerCar) {
        this.rec = recorder;
        this.camera = camera;
        this.road = road;
        this.car = playerCar;
        this.t = recorder.startTime;
        this.speed = 1;
        this.playing = true;
        this.camIndex = 0;
        this.auto = true;
        this.shotT = 0;
        this.spot = null;
        this.firedEvents = new Set();
        this.camPos = new THREE.Vector3();
        this.look = new THREE.Vector3();
        this.orbit = 0;
    }

    get camName() { return CAMS[this.camIndex]; }
    nextCam() { this.camIndex = (this.camIndex + 1) % CAMS.length; this.auto = false; this.spot = null; this.shotT = 0; }
    restart() { this.t = this.rec.startTime; this.firedEvents.clear(); this.spot = null; }
    get progress() { const a = this.rec.startTime, b = this.rec.endTime; return b > a ? (this.t - a) / (b - a) : 0; }
    seek(p) { this.t = this.rec.startTime + (this.rec.endTime - this.rec.startTime) * clamp(p, 0, 1); this.spot = null; }

    update(dt, effects) {
        const rec = this.rec;
        if (this.playing) this.t += dt * this.speed;
        if (this.t >= rec.endTime) { this.t = rec.endTime; this.playing = false; }
        rec.apply(this.t, dt * this.speed);
        for (const e of rec.events) {
            const key = e.t + e.type;
            if (e.t <= this.t && !this.firedEvents.has(key)) { this.firedEvents.add(key);  }
        }
        const car = this.car, rig = car.rig;
        rig.root.updateMatrixWorld(true);
        if (this.playing) {
            effects.tyres(dt * this.speed, rig, car.replaySkid || 0, car.replaySpeed || 0);
        }
        effects.update(dt * this.speed);

        // automatic camera direction
        this.shotT += dt;
        if (this.auto && this.shotT > 4.5 && this.camName !== 'trackside') { this.camIndex = (this.camIndex + 1) % CAMS.length; this.shotT = 0; this.spot = null; }
        const p = rig.root.position;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.root.quaternion);
        const cam = this.camera;
        cam.near = 0.1;
        switch (this.camName) {
            case 'trackside': {
                const loc = this.road.nearest(p.x, -p.z, {});
                const speed = car.replaySpeed || 0;
                if (!this.spot && loc) {
                    const ahead = 45 + speed * 1.6;
                    const side = Math.random() < 0.5 ? 1 : -1;
                    const sp = this.road.pointAt(loc.s + ahead, side * (this.road.p.wall + 1.5));
                    this.spot = new THREE.Vector3(sp.px, sp.pz + 1.2 + Math.random() * 2.5, -sp.py);
                    this.spotS = loc.s + ahead;
                    this.shotT = 0;
                }
                cam.position.copy(this.spot);
                cam.lookAt(p.x, p.y + 0.7, p.z);
                const zoom = clamp(cam.position.distanceTo(p) / 6, 1, 6);
                cam.fov = clamp(60 / zoom, 12, 60);
                if ((loc && loc.s > this.spotS + 25) || this.shotT > 8) {
                    this.spot = null;
                    if (this.auto && Math.random() < 0.45) { this.camIndex = 1 + Math.floor(Math.random() * 4); this.shotT = 0; }
                }
                break;
            }
            case 'orbit': {
                this.orbit += dt * 0.5;
                const r = 7;
                cam.position.set(p.x + Math.cos(this.orbit) * r, p.y + 2.2, p.z + Math.sin(this.orbit) * r);
                cam.lookAt(p.x, p.y + 0.6, p.z);
                cam.fov = 50;
                break;
            }
            case 'heli': {
                const target = new THREE.Vector3(p.x - fwd.x * 22, p.y + 28, p.z - fwd.z * 22);
                if (this.shotT < 0.05) this.camPos.copy(target);
                this.camPos.lerp(target, 1 - Math.exp(-2 * dt));
                cam.position.copy(this.camPos);
                cam.lookAt(p.x + fwd.x * 10, p.y, p.z + fwd.z * 10);
                cam.fov = 45;
                break;
            }
            case 'wheel': {
                const side = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.root.quaternion);
                cam.position.set(p.x + side.x * 1.6 + fwd.x * 1.2, p.y + 0.35, p.z + side.z * 1.6 + fwd.z * 1.2);
                cam.lookAt(p.x - fwd.x * 6, p.y + 0.3, p.z - fwd.z * 6);
                cam.fov = 70;
                break;
            }
            default: {
                cam.position.set(p.x - fwd.x * 6.5, p.y + 2.1, p.z - fwd.z * 6.5);
                cam.lookAt(p.x + fwd.x * 4, p.y + 0.9, p.z + fwd.z * 4);
                cam.fov = 62;
            }
        }
        cam.updateProjectionMatrix();
    }
}
