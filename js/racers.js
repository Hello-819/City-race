// Rival AI racers: same cars and physics as the player, racing line with traffic
// avoidance, light rubber-banding so races stay close.
import * as THREE from 'three';
import { createCar, PAINTS } from './assets.js';
import { Car } from './playerCar.js';
import { AIDriver } from './ai.js';
import { vehicleVsVehicle } from './collide.js';
import { Rng, clamp } from './core/rng.js';

const NAMES = ['Viper', 'Nova', 'Blaze', 'Ghost', 'Rook', 'Kaito', 'Sable'];

export class Racers {
    constructor(scene, world, count, night, seed) {
        this.scene = scene;
        this.world = world;
        this.road = world.road;
        this.rng = new Rng(seed ^ 0xacce);
        this.units = [];
        for (let i = 0; i < count; i++) {
            const id = this.rng.chance(0.5) ? 'ferrari' : 'concept';
            const rig = createCar(id, { lod: true, color: PAINTS[(i * 3 + 2) % PAINTS.length] });
            const car = new Car(rig, scene, { night });
            car.veh.assists = { tcs: true, esc: true, abs: true, auto: true };
            const skill = 0.9 + this.rng.range(0, 0.1) - i * 0.01;
            this.units.push({ car, ai: new AIDriver(car, this.road, { skill }), name: NAMES[i % NAMES.length], skill, finished: false, finishTime: 0, startDelay: this.rng.range(0, 0.25) });
        }
    }

    // grid slots for the player + racers
    static grid(kind, n) {
        const lanes = kind === 'city' ? [-5.25, -1.75] : [-1.8, 1.8];
        const slots = [];
        for (let i = 0; i <= n; i++) slots.push({ s: 30 - Math.floor(i / 2) * 9, d: lanes[i % 2] });
        return slots;
    }

    place(slots) {
        this.units.forEach((u, i) => { u.car.place(this.road, slots[i + 1].s, slots[i + 1].d); u.ai.laneD = slots[i + 1].d; u.finished = false; });
    }

    update(dt, ctx) {
        const { player, traffic, world, controls, simTime, finishS, police } = ctx;
        const road = this.road;
        const lanes = road.p.kind === 'city' ? [-5.25, -1.75, 1.75] : [-1.8, 1.8];
        const events = [];
        const obstacles = traffic.cars.map(c => ({ s: c.s, d: c.d, v: c.v * c.lane.dir }));
        obstacles.push({ s: player.s, d: player.d, v: player.veh.forwardSpeed });
        for (const u of this.units) obstacles.push({ s: u.car.s, d: u.car.d, v: u.car.veh.forwardSpeed, self: u });
        for (const u of this.units) {
            const car = u.car;
            let ctl;
            if (!controls || u.finished || simTime < u.startDelay) {
                ctl = u.finished ? u.ai.drive(dt, { d: u.ai.laneD, speed: 10, chase: null }) : { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
            } else {
                const gap = car.s - player.s;
                // rubber band: ease off when far ahead, push when far behind
                const band = gap > 120 ? 0.86 : gap < -150 ? 1.06 : 1;
                u.ai.skill = clamp(u.skill * band, 0.75, 1.04);
                const laneD = u.ai.pickLane(obstacles.filter(o => o.self !== u), lanes, 70);
                ctl = u.ai.drive(dt, { d: laneD, speed: 92 * band, chase: null });
            }
            const imp = car.update(dt, ctl, world);
            for (const h of traffic.collide(car.veh, car.s, simTime)) events.push({ type: 'racerCrash', u, speed: h.speed });
            const hit = vehicleVsVehicle(player.veh, car.veh);
            if (hit && hit.speed > 1) events.push({ type: 'racerContact', speed: hit.speed, nx: hit.hit.nx, ny: hit.hit.ny });
            for (const o of this.units) if (o !== u) vehicleVsVehicle(car.veh, o.car.veh);
            if (police) for (const p of police.units) if (p.active) vehicleVsVehicle(car.veh, p.car.veh);
            if (finishS && !u.finished && car.s >= finishS) { u.finished = true; u.finishTime = simTime; events.push({ type: 'racerFinished', u }); }
            // fell far behind or got stuck off the road: put back on track near the pack
            if (player.s - car.s > 700) { car.place(road, player.s - 250, lanes[0]); }
        }
        return events;
    }

    // position of the player among racers (1-based)
    position(playerS, playerFinished, playerTime) {
        let pos = 1;
        for (const u of this.units) {
            if (u.finished && (!playerFinished || u.finishTime < playerTime)) pos++;
            else if (!u.finished && !playerFinished && u.car.s > playerS) pos++;
        }
        return pos;
    }

    get captureSize() { return this.units.length * 10; }
    capture(buf, o) {
        for (const u of this.units) {
            const r = u.car.rig.root;
            buf[o++] = r.position.x; buf[o++] = r.position.y; buf[o++] = r.position.z;
            buf[o++] = r.quaternion.x; buf[o++] = r.quaternion.y; buf[o++] = r.quaternion.z; buf[o++] = r.quaternion.w;
            buf[o++] = 1; buf[o++] = u.car.veh.wheelSpin[0]; buf[o++] = u.car.veh.steer;
        }
        return o;
    }
    apply(a, b, t, o) {
        for (const u of this.units) {
            const r = u.car.rig.root;
            r.position.set(a[o] + (b[o] - a[o]) * t, a[o + 1] + (b[o + 1] - a[o + 1]) * t, a[o + 2] + (b[o + 2] - a[o + 2]) * t);
            r.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
            for (const w of u.car.rig.wheels) { w.spin.rotation.x = -a[o + 8]; if (w.front) w.steer.rotation.y = a[o + 9]; }
            o += 10;
        }
        return o;
    }

    dispose() { for (const u of this.units) u.car.dispose(); this.units = []; }
}
