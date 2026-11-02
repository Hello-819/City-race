// ============================================================================
// Game: owns every system of the open world and runs one simulation step.
//
//   map (layout)  -> streamer (chunk meshes, LOD, horizon, ocean)
//   player (on foot / in vehicle) + camera
//   vehicles (player's, parked, traffic, police)
//   hud, environment clock, audio, effects, save data
//
// main.js handles the title menu, pause and the render loop; this file is the
// gameplay. Later systems (weapons, NPCs, police, shops, traffic) plug in here.
// ============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GameMap } from '../world/map.js';
import { Streamer } from '../world/streamer.js';
import { setWorldNight, SPECIAL_NAMES } from '../world/materials.js';
import { Player } from '../player/player.js';
import { GameCamera } from '../player/camera.js';
import { VehicleEntity } from '../vehicles/vehicleEntity.js';
import { createCar, CARS } from '../assets.js';
import { Effects } from '../effects.js';
import { Hud } from '../ui/hud.js';
import { MAP_ICONS } from '../ui/mapView.js';
import { loadSave, writeSave, defaultSave } from './save.js';
import { vehicleVsVehicle } from '../collide.js';

const MC = CONFIG.map;

export class Game {
    constructor({ scene, camera, renderer, env, input, audio }) {
        this.scene = scene; this.camera = camera; this.renderer = renderer;
        this.env = env; this.input = input; this.audio = audio;
        this.map = new GameMap();
        this.world = { scene, map: this.map, game: this };
        this.save = loadSave() || defaultSave();
        this.hud = new Hud(this.map);
        this.streamer = new Streamer(scene, this.map);
        this.effects = new Effects(scene, false);
        this.cam = new GameCamera(camera);
        this.player = new Player(this.world, this.save.outfit || {});
        this.vehicles = [];
        this.timeScale = 1;
        this.mapOpen = false;
        this.money = this.save.money;
        env.setHour(this.save.hour);
        env.listeners.push((n) => setWorldNight(n));
        setWorldNight(env.night);
        this.specialBlips = this.map.doors().map(d => ({ x: d.x, y: d.y, type: d.type }));
    }

    // Place the player and build the world around them before the first frame.
    start() {
        const s = this.save.pos;
        const P = CONFIG.player.spawn;
        if (s && this.map.inBounds(s.x, s.y)) this.player.teleport(s.x, s.y, s.yaw);
        else this.player.teleport(P.x, P.y, Math.PI / 2);
        this.player.health = this.save.health ?? 100;
        this.player.armour = this.save.armour ?? 0;
        this.cam.yaw = this.player.yaw;
        // a couple of cars parked at the kerb next to the start
        this.spawnParked('concept', 6.2, -40, Math.PI / 2);
        this.spawnParked('ferrari', 6.2, -12, Math.PI / 2, '#f2b705');
        this.streamer.update(this.player.x, this.player.y, Infinity);
        this.hud.notify('Welcome to the island. <b>WASD</b> to move, mouse to look. Press <b>F</b> near a car to get in. <b>M</b> opens the map.', 8);
    }

    spawnParked(model, x, y, th, color = null) {
        const rig = createCar(model, { color: color || CARS[model].defaultColor });
        const v = new VehicleEntity(this.world, rig, { name: CARS[model].name, model, health: 1000 });
        v.place(x, y, th);
        this.vehicles.push(v);
        return v;
    }

    zoneName(x, y) {
        const map = this.map;
        if (map.surfaceAt(x, y).kind === 'water') return 'Open Water';
        const r = map.roadAt(x, y);
        if (r && r.edge.type === 'highway') return 'Ring Highway';
        if (y > MC.mountainY + 100) return 'Granite Ridge';
        if (map.shoreDist(x, y) < MC.beachWidth + 80) return y < 0 ? 'Coral Beach' : x > 0 ? 'East Shore' : 'West Shore';
        const z = map.zoneAt(x, y);
        if (z === 'city') return Math.hypot(x, y) < MC.downtownRadius ? 'Downtown' : 'Midtown';
        const ns = y > 0 ? 'North' : 'South', ew = x > 0 ? 'East' : 'West';
        if (z === 'suburb') return Math.abs(x) > Math.abs(y) ? ew + ' Vale' : ns + ' Heights';
        return 'Countryside';
    }

    // ------------------------------------------------------------------ step
    update(rawDt) {
        const input = this.input, player = this.player;
        const dt = rawDt * this.timeScale;
        // --- map toggle ---
        if (input.actHit('map')) this.mapOpen = !this.mapOpen;
        if (this.mapOpen) {
            if (input.hit('Escape')) this.mapOpen = false;
            this.hud.drawFullMap(this._hudState());
            return;
        }
        this.cam.look(input, this.timeScale < 1 ? 0 : 1);

        // --- enter / exit vehicles ---
        if (input.actHit('enterExit') && !player.dead) {
            if (player.vehicle) {
                if (Math.abs(player.vehicle.veh.forwardSpeed) < CONFIG.player.exitMaxSpeed) {
                    player.vehicle.setHeadlightSpot(false);
                    player.exit();
                    this.cam.pitch = 0.18;
                }
            } else {
                const v = player.nearestVehicle(this.vehicles);
                if (v) { player.enter(v); this.cam.lookYaw = 0; }
            }
        }

        // --- player / vehicles ---
        const pv = player.vehicle;
        if (pv) {
            if (input.actHit('camera')) this.hud.notify(this.cam.cycle(pv.rig), 1.5);
            if (input.actHit('horn')) this.audio.horn();
            pv.controls = player.dead ? DEAD : { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake };
        }
        for (const v of this.vehicles) {
            if (v !== pv && !v.driver) v.controls = PARKED;
            if (Math.abs(v.x - player.x) > 400 || Math.abs(v.y - player.y) > 400) continue;
            const impacts = v.update(dt);
            if (v === pv) for (const h of impacts) { this.audio.impact(h.speed); this.cam.shake = Math.max(this.cam.shake, Math.min(0.8, h.speed / 30)); this._sparks(v, h); }
        }
        // vehicle vs vehicle
        for (let i = 0; i < this.vehicles.length; i++) for (let j = i + 1; j < this.vehicles.length; j++) {
            const a = this.vehicles[i], b = this.vehicles[j];
            const hit = vehicleVsVehicle(a.veh, b.veh);
            if (hit && hit.speed > 1 && (a === pv || b === pv)) { this.audio.impact(hit.speed); this.cam.shake = Math.max(this.cam.shake, hit.speed / 30); }
        }
        player.update(dt, input, this.cam.yaw, this.vehicles);

        // --- camera ---
        if (pv) this.cam.updateVehicle(rawDt, pv, input);
        else this.cam.updateFoot(rawDt, player, this.map, false);

        // --- world streaming, clock, lights ---
        const pos = player.position;
        this.streamer.update(pos.x, pos.y);
        const focus = pv ? pv.rig.root.position : player.person.root.position;
        this.env.update(input.act('fastTime') ? dt * 60 : dt, focus, this.camera);
        const night = this.env.night > 0.5;
        for (const v of this.vehicles) v.setLights(night && (v === pv || !!v.driver));
        if (pv) pv.setHeadlightSpot(night);
        if (pv) {
            pv.rig.root.updateMatrixWorld(true);
            this.effects.tyres(dt, pv.rig, pv.veh.skid, pv.veh.speed);
        }
        this.effects.update(dt);

        // --- audio ---
        if (pv) {
            const v = pv.veh;
            this.audio.update({ active: true, rpm: v.rpm, cylinders: v.P.cylinders || 4, throttle: v.throttle, redline: v.P.redline, limiter: v.limiter, skid: v.skid, speed: v.speed, inside: this.cam.rig.inside });
        } else this.audio.update(IDLE_AUDIO);

        // --- HUD ---
        this._prompts();
        this.hud.zone(this.zoneName(pos.x, pos.y));
        this.hud.update(rawDt, this._hudState());
    }

    _prompts() {
        const p = this.player;
        if (p.vehicle) { this.hud.prompt(''); return; }
        const v = p.nearestVehicle(this.vehicles);
        if (v) { this.hud.prompt(`<kbd>F</kbd> Enter ${v.info.name || 'vehicle'}`); return; }
        for (const b of this.specialBlips) {
            if (Math.abs(b.x - p.x) < 2.5 && Math.abs(b.y - p.y) < 2.5) { this.hud.prompt(SPECIAL_NAMES[b.type] + ' <small>(opens in a later update)</small>'); return; }
        }
        this.hud.prompt('');
    }

    _sparks(v, h) {
        if (h.speed < 3) return;
        const x = v.x - h.nx * 1.2, y = v.y - h.ny * 1.2;
        this.effects.impactSparks(x, v.veh.z + 0.5, -y, v.veh.vx, -v.veh.vy, h.speed);
    }

    _hudState() {
        const p = this.player;
        const heading = p.vehicle ? (this.cam.rig.current === 'chase' || this.cam.rig.current === 'far' ? this.cam.yaw : p.vehicle.th) : this.cam.yaw;
        return {
            player: p, vehicle: p.vehicle, clock: this.env.clockText, money: this.money,
            wanted: null, weapon: null, heading, blips: this.specialBlips, crosshair: null,
        };
    }

    // ------------------------------------------------------------------ save
    snapshot() {
        const p = this.player, pos = p.position;
        Object.assign(this.save, {
            money: this.money, hour: this.env.hour, health: p.health, armour: p.armour,
            pos: { x: pos.x, y: pos.y, yaw: p.yaw }, outfit: p.outfit,
        });
        return writeSave(this.save);
    }

    dispose() {
        this.streamer.dispose();
        this.effects.dispose();
        for (const v of this.vehicles) v.dispose();
        this.player.dispose();
    }
}

const PARKED = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
const DEAD = PARKED;
const IDLE_AUDIO = { active: false, rpm: 1000, cylinders: 8, throttle: 0, redline: 8000, skid: 0, speed: 0 };
export { THREE, MAP_ICONS };
