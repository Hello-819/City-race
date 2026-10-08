// Wanted level and police pursuit. Police drive real physics cars with an AI
// driver; they chase, ram and box you in. Stop next to them and you're busted;
// stay out of their sight long enough and the heat drops.
import * as THREE from 'three';
import { createCar } from './assets.js';
import { Car } from './playerCar.js';
import { AIDriver } from './ai.js';
import { vehicleVsVehicle } from './collide.js';
import { Rng, clamp } from './core/rng.js';
import { glowTexture } from './textures.js';

const MAX_UNITS = 5;

function policeDecal() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.fillStyle = '#f2f2f2'; x.fillRect(0, 34, 512, 60);
    x.fillStyle = '#1b3fa8'; x.fillRect(0, 40, 512, 48);
    x.fillStyle = '#fff'; x.font = 'bold 44px "Segoe UI", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('POLICE', 256, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

export class Police {
    constructor(scene, world, night, seed) {
        this.scene = scene;
        this.world = world;
        this.road = world.road;
        this.night = night;
        this.rng = new Rng(seed ^ 0x51ce);
        this.heat = 0;
        this.bust = 0;          // 0..1 busted meter
        this.evade = 0;         // 0..1 cooldown meter
        this.units = [];
        this.time = 0;
        this.events = [];
        const decal = policeDecal();
        this.decalMat = new THREE.MeshStandardMaterial({ map: decal, transparent: true, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
        this.red = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff1010, emissiveIntensity: 0 });
        this.blue = new THREE.MeshStandardMaterial({ color: 0x000830, emissive: 0x1040ff, emissiveIntensity: 0 });
        for (let i = 0; i < MAX_UNITS; i++) this.units.push(this._makeUnit(i));
        // flashing glows for all light bars in one draw call
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_UNITS * 2 * 3), 3));
        const col = new Float32Array(MAX_UNITS * 2 * 3);
        for (let i = 0; i < MAX_UNITS; i++) { col.set([1, 0.1, 0.1], i * 6); col.set([0.2, 0.35, 1], i * 6 + 3); }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.glows = new THREE.Points(g, new THREE.PointsMaterial({ size: night ? 3.2 : 1.6, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.glows.frustumCulled = false;
        scene.add(this.glows);
    }

    get stars() { return Math.min(5, Math.floor(this.heat)); }
    get active() { return this.units.filter(u => u.active); }

    _makeUnit(i) {
        const id = i % 2 ? 'concept' : 'ferrari';
        const rig = createCar(id, { lod: true, color: '#0d1117' });
        const car = new Car(rig, this.scene, { night: this.night });
        car.veh.assists = { tcs: true, esc: true, abs: true, auto: true };
        const { x, y, z } = rig.dims;
        // light bar
        const bar = new THREE.Group();
        const base = new THREE.Mesh(new THREE.BoxGeometry(x * 0.55, 0.09, 0.28), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 }));
        const r = new THREE.Mesh(new THREE.BoxGeometry(x * 0.26, 0.1, 0.24), this.red);
        const b = new THREE.Mesh(new THREE.BoxGeometry(x * 0.26, 0.1, 0.24), this.blue);
        r.position.set(-x * 0.14, 0.08, 0); b.position.set(x * 0.14, 0.08, 0);
        bar.add(base, r, b);
        bar.position.set(0, y * 0.98, z * 0.05);
        rig.body.add(bar);
        // door decals
        for (const side of [-1, 1]) {
            const d = new THREE.Mesh(new THREE.PlaneGeometry(z * 0.42, z * 0.105), this.decalMat);
            d.position.set(side * (x / 2 - 0.12), y * 0.45, 0.05);
            d.rotation.y = side * Math.PI / 2;
            rig.body.add(d);
        }
        rig.root.visible = false;
        const ai = new AIDriver(car, this.road, { skill: 0.97 });
        return { car, ai, active: false, wrecked: false, bar, lights: [new THREE.Vector3(-x * 0.14, y + 0.12, z * 0.05), new THREE.Vector3(x * 0.14, y + 0.12, z * 0.05)], wreckT: 0, roadblock: false, idle: 0 };
    }

    addHeat(amount) {
        const before = this.stars;
        this.heat = Math.min(5.99, this.heat + amount);
        this.evade = 0;
        return this.stars > before;
    }

    _spawn(u, player, ahead = false, roadblock = false) {
        const road = this.road;
        let s = ahead ? player.s + this.rng.range(260, 340) : player.s - this.rng.range(110, 160);
        s = clamp(s, road.backS + 20, road.frontS - 30);
        const lanes = road.p.kind === 'city' ? [-5.25, -1.75, 1.75] : [-1.8, 1.8];
        const d = roadblock ? 0 : this.rng.pick(lanes);
        u.car.place(road, s, d);
        if (roadblock) {
            // park across the lane, angled
            u.car.veh.th += Math.PI / 2 * (this.rng.chance(0.5) ? 1 : -1) + this.rng.range(-0.3, 0.3);
        } else {
            const f = road.frameAt(s);
            u.car.veh.vx = f.c * (player.veh.forwardSpeed * 0.9); u.car.veh.vy = f.sn * (player.veh.forwardSpeed * 0.9);
        }
        u.car.health = 100; u.car.exploded = false; u.wrecked = false; u.wreckT = 0;
        u.active = true; u.roadblock = roadblock; u.idle = 0;
        u.car.rig.root.visible = true;
    }

    _deactivate(u) { u.active = false; u.car.rig.root.visible = false; }

    reset() {
        this.heat = 0; this.bust = 0; this.evade = 0;
        for (const u of this.units) this._deactivate(u);
    }

    // ctx: {player (Car), traffic, world, effects, simTime, racers}
    update(dt, ctx) {
        this.events.length = 0;
        this.time += dt;
        const { player, traffic, world, effects, simTime } = ctx;
        const road = this.road;
        const stars = this.stars;
        const wanted = stars >= 1;

        // spawn / despawn
        const want = wanted ? Math.min(MAX_UNITS - (stars >= 3 ? 2 : 0), stars + 1) : 0;
        const chasing = this.units.filter(u => u.active && !u.wrecked && !u.roadblock);
        if (wanted && chasing.length < want) {
            const free = this.units.find(u => !u.active);
            if (free) this._spawn(free, player, false);
        }
        if (stars >= 3 && !this.units.some(u => u.active && u.roadblock)) {
            const free = this.units.filter(u => !u.active).slice(0, 2);
            if (free.length === 2 && this.rng.chance(dt * 0.3)) {
                this._spawn(free[0], player, true, true);
                const s0 = free[0].car.s;
                this._spawn(free[1], player, true, true);
                free[1].car.place(road, s0 + 1.5, road.p.kind === 'city' ? -4.5 : -2.5);
                free[1].car.veh.th = road.frameAt(s0).th + Math.PI / 2 + 0.3;
                free[0].car.place(road, s0, road.p.kind === 'city' ? 3.5 : 1.8);
                free[0].car.veh.th = road.frameAt(s0).th - Math.PI / 2 - 0.3;
                this.events.push({ type: 'roadblock' });
            }
        }

        let nearest = Infinity;
        const flash = Math.sin(this.time * 18) > 0;
        this.red.emissiveIntensity = flash ? 5 : 0.3;
        this.blue.emissiveIntensity = flash ? 0.3 : 5;
        const obstacles = traffic.cars.map(c => ({ s: c.s, d: c.d, v: c.v * c.lane.dir }));
        for (const u of this.units) {
            if (!u.active) continue;
            const car = u.car, v = car.veh;
            const gap = player.s - car.s;
            const dist = Math.hypot(player.veh.x - v.x, player.veh.y - v.y);
            if (!u.wrecked) nearest = Math.min(nearest, dist);
            // leave the chase when the heat is gone or too far behind
            if ((!wanted && dist > 120) || gap > 450 || gap < -600) { this._deactivate(u); continue; }

            let ctl;
            if (u.wrecked || car.exploded) {
                ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
                u.wreckT += dt;
                effects.damage(dt, car.rig, 5, car.enginePos);
                if (u.wreckT > 30 && dist > 150) this._deactivate(u);
            } else if (u.roadblock && dist > 35 && gap < 0) {
                ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
            } else if (!wanted) {
                u.roadblock = false;
                ctl = u.ai.drive(dt, { d: -1.75, speed: 12, chase: null });
            } else {
                u.roadblock = false;
                const lanes = road.p.kind === 'city' ? [-5.25, -1.75, 1.75, 5.25] : [-1.8, 1.8];
                const close = dist < 45;
                const laneD = close ? player.d : u.ai.pickLane(obstacles, lanes);
                const pv = player.veh;
                const speed = Math.abs(pv.forwardSpeed) + (gap > 40 ? 25 : gap > 0 ? 10 : -4);
                ctl = u.ai.drive(dt, { d: laneD, speed: clamp(speed, 10, 92), chase: close ? { x: pv.x, y: pv.y, vx: pv.vx, vy: pv.vy } : null });
            }
            const imp = car.update(dt, ctl, world);
            for (const i of imp) car.applyImpact(i.speed, i.nx, i.ny, 0.35);
            for (const h of traffic.collide(v, car.s, simTime)) car.applyImpact(h.speed, h.nx, h.ny, 0.4);
            // ramming the player
            const hit = vehicleVsVehicle(player.veh, v);
            if (hit && hit.speed > 1) {
                this.events.push({ type: 'copContact', speed: hit.speed, nx: hit.hit.nx, ny: hit.hit.ny, unit: u });
                car.applyImpact(hit.speed, -hit.hit.nx, -hit.hit.ny, 0.6);
            }
            // police vs police
            for (const o of this.units) if (o !== u && o.active) vehicleVsVehicle(v, o.car.veh);
            if (!u.wrecked && car.health <= 0) {
                u.wrecked = true;
                car.explode();
                effects.explode(car.rig.root.position, 0.8);
                this.events.push({ type: 'copWrecked', pos: car.rig.root.position.clone() });
            }
        }

        // busted / evade meters
        const speed = Math.abs(player.veh.forwardSpeed);
        if (wanted && nearest < 9 && speed < 2.5 && !player.exploded) this.bust = Math.min(1, this.bust + dt / 3);
        else this.bust = Math.max(0, this.bust - dt / 2);
        if (this.bust >= 1) this.events.push({ type: 'busted' });

        if (wanted) {
            if (nearest > 190 || !this.units.some(u => u.active && !u.wrecked)) this.evade = Math.min(1, this.evade + dt / 9);
            else this.evade = Math.max(0, this.evade - dt / 3);
            if (this.evade >= 1) {
                this.heat = Math.max(0, this.stars - 1);
                this.evade = 0;
                this.events.push({ type: this.stars === 0 ? 'evaded' : 'starLost' });
            }
        }
        this.nearest = nearest;
        this._updateGlows(flash);
        return this.events;
    }

    _updateGlows(flash) {
        const pos = this.glows.geometry.attributes.position;
        const v = new THREE.Vector3();
        this.units.forEach((u, i) => {
            const root = u.car.rig.root;
            for (let k = 0; k < 2; k++) {
                const on = u.active && !u.wrecked && (k === 0 ? flash : !flash);
                if (!on) { pos.setXYZ(i * 2 + k, 0, -1e4, 0); continue; }
                root.updateMatrixWorld();
                v.copy(u.lights[k]).applyMatrix4(u.car.rig.body.matrixWorld);
                pos.setXYZ(i * 2 + k, v.x, v.y, v.z);
            }
        });
        pos.needsUpdate = true;
    }

    // capture / apply for replays: root transform + wheel spin per unit
    get captureSize() { return this.units.length * 9; }
    capture(buf, o) {
        for (const u of this.units) {
            const r = u.car.rig.root;
            buf[o++] = r.position.x; buf[o++] = r.position.y; buf[o++] = r.position.z;
            buf[o++] = r.quaternion.x; buf[o++] = r.quaternion.y; buf[o++] = r.quaternion.z; buf[o++] = r.quaternion.w;
            buf[o++] = r.visible ? 1 : 0; buf[o++] = u.car.veh.wheelSpin[0];
        }
        return o;
    }
    apply(a, b, t, o) {
        for (const u of this.units) {
            const r = u.car.rig.root;
            r.position.set(a[o] + (b[o] - a[o]) * t, a[o + 1] + (b[o + 1] - a[o + 1]) * t, a[o + 2] + (b[o + 2] - a[o + 2]) * t);
            r.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
            r.visible = a[o + 7] > 0.5;
            for (const w of u.car.rig.wheels) w.spin.rotation.x = -a[o + 8];
            o += 9;
        }
        this._updateGlows(Math.sin(performance.now() / 1000 * 18) > 0);
        return o;
    }

    dispose() {
        for (const u of this.units) u.car.dispose();
        this.scene.remove(this.glows);
    }
}
