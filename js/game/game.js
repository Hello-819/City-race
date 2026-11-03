// ============================================================================
// Game: owns every system of the open world and runs one simulation step.
//
//   map (layout)  -> streamer (chunk meshes, LOD, horizon, ocean)
//   player (on foot / in vehicle) + camera
//   weapons + weapon wheel + combat effects
//   vehicles (player's, parked, traffic, police) + their NPC drivers
//   pedestrians (civilians + police officers), police / wanted level
//   pickups, hud, environment clock, audio, effects, save data
//
// main.js handles the title menu, pause and the render loop; this file is the
// gameplay glue. Each system lives in its own module.
// ============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { GameMap } from '../world/map.js';
import { Streamer } from '../world/streamer.js';
import { propMatrix } from '../world/chunkBuilder.js';
import { setWorldNight, SPECIAL_NAMES } from '../world/materials.js';
import { Player } from '../player/player.js';
import { GameCamera } from '../player/camera.js';
import { VehicleEntity } from '../vehicles/vehicleEntity.js';
import { createVehicleRig } from '../vehicles/carModels.js';
import { Effects } from '../effects.js';
import { Hud } from '../ui/hud.js';
import { WeaponWheel } from '../ui/weaponWheel.js';
import { WeaponSystem } from '../weapons/weapons.js';
import { CombatFx } from '../weapons/combat.js';
import { Peds } from '../npc/peds.js';
import { Police } from '../npc/police.js';
import { Pickups } from './pickups.js';
import { Jobs } from './jobs.js';
import { Traffic } from '../vehicles/traffic.js';
import { Interiors } from '../shops/interiors.js';
import { ShopUI } from '../shops/shopUI.js';
import { loadSave, writeSave, defaultSave } from './save.js';
import { vehicleVsVehicle } from '../collide.js';

const MC = CONFIG.map;
const PC = CONFIG.police;

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
        this.fx = new CombatFx(scene);
        this.cam = new GameCamera(camera);
        this.player = new Player(this.world, this.save.outfit || {});
        this.vehicles = [];
        this.drivers = [];
        this.pickups = new Pickups(this);
        this.peds = new Peds(this);
        this.police = new Police(this);
        this.weapons = new WeaponSystem(this, this.save.weapons);
        this.wheel = new WeaponWheel();
        this.activeScene = scene;          // switches to a room scene inside shops
        this.activeMap = this.map;
        this.interiors = new Interiors(this);
        this.shopUI = new ShopUI(this);
        this.jobs = new Jobs(this);
        this.personalCar = null;
        this.traffic = new Traffic(this);
        this.extraBlips = () => [...this.jobs.blips(), ...this.traffic.blips()];
        this.doorPrompt = (b) => this.interiors.prompt(b);
        this.timeScale = 1;
        this.time = 0;
        this.mapOpen = false;
        this.wantsCursor = false;      // true while a shop UI needs the mouse
        this.money = this.save.money;
        this.deathT = 0;
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
        this.player.health = this.save.health || 100;
        this.player.armour = this.save.armour ?? 0;
        this.cam.yaw = this.player.yaw;
        // a couple of cars parked at the kerb next to the start
        // (on the pavement edge so they don't block traffic)
        this.spawnParked('hatch', 9.0, -40, Math.PI / 2, '#2f5d8a');
        this.spawnParked('sports', 9.0, -16, Math.PI / 2);
        this.streamer.update(this.player.x, this.player.y, Infinity);
        this.hud.notify('Welcome to the island. <b>WASD</b> move, mouse look, <b>F</b> enter cars, <b>right mouse</b> aim, <b>left mouse</b> shoot, hold <b>Q</b> for the weapon wheel, <b>M</b> map.', 9);
    }

    // ------------------------------------------------------------ vehicles
    spawnParked(model, x, y, th, color = null) {
        const v = new VehicleEntity(this.world, createVehicleRig(model, color), { ...CONFIG.vehicles[model], model });
        v.place(x, y, th);
        this.addVehicle(v);
        return v;
    }

    addVehicle(v, driver = null) {
        this.vehicles.push(v);
        if (driver) this.drivers.push(driver);
    }

    removeVehicle(v) {
        const i = this.vehicles.indexOf(v);
        if (i >= 0) this.vehicles.splice(i, 1);
        this.drivers = this.drivers.filter(d => d.v !== v);
        v.dispose();
    }

    npcHonk(v) {
        const p = this.player.position;
        if (Math.hypot(v.x - p.x, v.y - p.y) < 60) this.audio.horn();
    }

    // ------------------------------------------------------------- props
    // A bullet hit a tree / pole / pillar / rock.
    hitProp(c, hit) {
        const wood = c.type === 'tree' || c.type === 'pine' || c.type === 'palm';
        if (wood) this.effects.wood(hit.x, hit.z, -hit.y);
        else if (c.type === 'rock' || c.type === 'pillar') this.effects.dust(hit.x, hit.z, -hit.y);
        else this.effects.impactSparks(hit.x, hit.z, -hit.y, 0, 0, 3);
    }

    // A vehicle snapped a lamp post / tree: it falls in the direction of travel.
    knockProp(c, vx, vy) {
        if (c.fallen) return;
        c.fallen = true;
        c.fallDir = Math.atan2(vx, -vy);       // three.js yaw of the travel direction
        for (const [im, i, fn] of c._inst || []) {
            im.setMatrixAt(i, propMatrix(c, fn));
            im.instanceMatrix.needsUpdate = true;
        }
        const h = this.map.heightAt(c.x, c.y);
        this.effects.impactSparks(c.x, h + 0.6, -c.y, vx * 0.3, -vy * 0.3, 6);
        if (c.type !== 'lamp') this.effects.wood(c.x, h + 1, -c.y);
        this.audio.impact(8);
    }

    // ------------------------------------------------------------- map / GPS
    // The full map frees the mouse so you can click to set a waypoint.
    setMapOpen(open) {
        this.mapOpen = open;
        this.wantsCursor = open;
        if (open) this.input.exitLock(); else this.input.requestLock();
    }

    // Click on the full map: set (or clear) the waypoint.
    mapClick(px, py) {
        const w = this.hud.mapView.screenToWorld(px, py);
        if (!w) return;
        if (this.waypoint && Math.hypot(this.waypoint.x - w.x, this.waypoint.y - w.y) < 120) this.waypoint = null;
        else this.waypoint = { x: w.x, y: w.y };
        this.gpsT = 0;
    }

    // GPS: road route to the job / mission target, else the map waypoint.
    gpsTarget() {
        if (this.missions && this.missions.target) return this.missions.target;
        if (this.jobs.job) return this.jobs.job;
        return this.waypoint;
    }

    _updateGps(dt) {
        this.gpsT = (this.gpsT || 0) - dt;
        if (this.gpsT > 0) return;
        this.gpsT = 1.5;
        const t = this.gpsTarget(), p = this.player.position;
        if (!t || Math.hypot(t.x - p.x, t.y - p.y) < 25) { this.route = null; return; }
        const r = this.map.route(p.x, p.y, t.x, t.y);
        if (!r) { this.route = null; return; }
        const pts = [{ x: p.x, y: p.y }];
        for (const { edge, fwd } of r.path) {
            const n = Math.max(1, Math.ceil(edge.len / 15));
            for (let i = 0; i <= n; i++) pts.push(this.map.edgePoint(edge, fwd ? edge.len * i / n : edge.len * (1 - i / n), 0, {}));
        }
        pts.push({ x: t.x, y: t.y });
        this.route = pts;
    }

    // -------------------------------------------------------- purchases
    setOutfit(o) {
        const spec = o.kind === 'man' ? { kind: 'man', top: o.top, bottom: o.bottom } : { kind: o.kind, tint: o.tint, noTint: o.noTint };
        this.player.setOutfit(spec);
        this.save.outfitId = o.id;
        this.save.outfit = this.player.outfit;
    }

    // Park an owned vehicle on the road outside the nearest dealership.
    deliverOwnedCar(i) {
        const c = this.save.ownedCars[i];
        if (!c) return;
        this.storePersonalCar();
        const door = this.interiors.current ? this.interiors.current.door : this.map.doors('dealership')[0];
        const r = this.map.nearestRoad(door.x + door.nx * 8, door.y + door.ny * 8, 60);
        const e = r.edge;
        const off = e.half + 1.3;                                           // on the pavement edge
        const side = Math.sign(this.map._project(e, door.x, door.y).d) || 1;    // the shop's side of the road
        const s = Math.min(e.len - 12, r.s + 8);
        const p = this.map.edgePoint(e, s, off * side, {});
        const t = this.map.tangent(e, s);
        const v = this.spawnParked(c.model, p.x, p.y, Math.atan2(t.y, t.x), c.color);
        v.owned = true;
        this.personalCar = v;
    }

    storePersonalCar() {
        const v = this.personalCar;
        if (v && this.vehicles.includes(v) && this.player.vehicle !== v) this.removeVehicle(v);
        this.personalCar = null;
    }

    // ---------------------------------------------------------------- crime
    crime(type, x, y) {
        if (type === 'shooting' || type === 'assault' || type === 'pedKilled' || type === 'copKilled' || type === 'carJack') this.peds.alarm(x, y);
        if (type === 'shooting' || type === 'vehicleDestroyed') this.traffic.alarm(x, y);
        this.police.crime(type, x, y);
    }

    onWanted(stars, before) {
        if (before === 0) this.hud.notify('The police are after you! Get out of sight to lose your <b>wanted level</b>.', 4);
    }

    // impulse (optional): three.js world vector for the ragdoll if this kills us
    hurtPlayer(amount, impulse = null) {
        const p = this.player;
        if (p.dead) return;
        if (impulse) this.lastHurtImpulse = impulse;
        p.damage(amount);
        this.cam.shake = Math.max(this.cam.shake, 0.25);
        document.getElementById('hud').classList.remove('hurt'); void document.getElementById('hud').offsetWidth;
        document.getElementById('hud').classList.add('hurt');
        if (p.dead) this._die();
    }

    explosion(x, y, z, by) {
        this.effects.explosion(x, z, -y);
        this.audio.boom();
        const pp = this.player.position;
        const d = Math.hypot(pp.x - x, pp.y - y);
        this.cam.shake = Math.max(this.cam.shake, Math.max(0, 1.2 - d / 40));
        if (d < 9) this.hurtPlayer(this.player.vehicle && this.player.vehicle.alive === false ? 500 : (9 - d) * 22, new THREE.Vector3((pp.x - x) / (d || 1) * 7, 7, -(pp.y - y) / (d || 1) * 7));
        for (const p of this.peds.active) {
            const dp = Math.hypot(p.x - x, p.y - y);
            if (dp < 8) {
                const k = (8 - dp) * 0.7 / (dp || 1);
                this.peds.damage(p, (8 - dp) * 40, by === 'player' ? 'player' : 'explosion', null, new THREE.Vector3((p.x - x) * k, 3 + (8 - dp) * 0.5, -(p.y - y) * k));
            }
            else if (dp < 40 && !p.dead) this.peds.alarm(x, y, 0.1);
        }
        for (const v of this.vehicles) {
            const dv = Math.hypot(v.x - x, v.y - y);
            if (dv > 0.5 && dv < 9) { v.damage((9 - dv) * 90, by); v.veh.vx += (v.x - x) / dv * 4; v.veh.vy += (v.y - y) / dv * 4; }
        }
        if (by === 'player') this.crime('vehicleDestroyed', x, y);
        this.peds.alarm(x, y, 60);
        this.traffic.alarm(x, y);
    }

    // ----------------------------------------------------- death / arrest
    _die() {
        this.deathT = 0.0001;
        this.deathKind = 'wasted';
        const p = this.player;
        if (p.vehicle) { const v = p.vehicle; p.exit(); v.controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 }; }
        const imp = this.lastHurtImpulse || new THREE.Vector3(-Math.cos(p.yaw) * 2, 1, Math.sin(p.yaw) * 2);
        p.startRagdoll(imp);
        this.lastHurtImpulse = null;
        this.hud.big('WASTED', '');
        this.audio.boom();
        this.save.stats.deaths++;
    }

    busted() {
        if (this.deathT > 0) return;
        this.deathT = 0.0001;
        this.deathKind = 'busted';
        this.player.dead = true;
        this.hud.big('BUSTED', '', 'busted');
    }

    _updateDeath(dt) {
        this.deathT += dt;
        const p = this.player;
        // collapse: ragdoll if we have one, otherwise a simple topple
        if (this.deathKind === 'wasted' && !p.ragdoll) {
            const f = Math.min(1, this.deathT * 2.5);
            p.person.root.rotation.set(0, p.yaw + Math.PI / 2, 0, 'YXZ');
            p.person.root.rotateX(-f * Math.PI / 2);
        }
        this.timeScale = Math.max(0.25, 1 - this.deathT);
        if (this.deathT > 3.2 && !this.fading) { this.fading = true; this.hud.fade(1, 700); }
        if (this.deathT > 4.2) this._respawn();
    }

    _respawn() {
        const busted = this.deathKind === 'busted';
        const pos = this.player.position;
        const doors = this.map.doors(busted ? 'police' : 'hospital');
        let best = doors[0], bd = Infinity;
        for (const d of doors) { const dd = Math.hypot(d.x - pos.x, d.y - pos.y); if (dd < bd) { bd = dd; best = d; } }
        const fee = busted ? PC.bustFee : PC.hospitalFee;
        const paid = Math.min(this.money, fee);
        this.money -= paid;
        const p = this.player;
        p.dead = false; p.health = p.maxHealth; p.armour = 0;
        p.ragdoll = null;
        p.person.root.rotation.set(0, 0, 0);
        p.teleport(best.x + best.nx * 3, best.y + best.ny * 3, Math.atan2(best.ny, best.nx));
        this.cam.yaw = p.yaw; this.cam.pitch = 0.15;
        this.police.clear();
        this.timeScale = 1;
        this.deathT = 0; this.fading = false;
        this.hud.big('');
        this.hud.fade(0, 900);
        this.hud.notify(busted ? `You were arrested. Bail cost <b>$${paid}</b>.` : `You were treated at the hospital. Medical bill: <b>$${paid}</b>.`, 5);
        this.streamer.update(p.x, p.y, Infinity);
    }

    // ------------------------------------------------------------ pickups
    collect(it) {
        if (it.type === 'cash') { this.money += it.amount; this.audio.cash(); }
        else if (it.type === 'ammo') {
            const w = this.weapons.current === 'unarmed' ? this.weapons.list().find(id => id !== 'unarmed') : this.weapons.current;
            if (w) this.weapons.addAmmo(w, it.amount);
            this.audio.pickup();
        } else if (it.type === 'health') { this.player.heal(it.amount || 50); this.audio.pickup(); }
        else if (it.type === 'armour') { this.player.armour = Math.min(100, this.player.armour + (it.amount || 50)); this.audio.pickup(); }
    }

    // ------------------------------------------------------------------ step
    update(rawDt) {
        const input = this.input, player = this.player;
        // --- map toggle ---
        if (input.actHit('map') && !this.wheel.open && !this.shopUI.open) this.setMapOpen(!this.mapOpen);
        if (this.mapOpen) {
            if (input.hit('Escape', 'KeyP')) this.setMapOpen(false);
            this._updateGps(rawDt);
            this.hud.drawFullMap(this._hudState());
            return;
        }
        this._updateGps(rawDt);
        // --- inside a shop: only the room, the player and the shop UI run ---
        if (this.interiors.inside) { this._updateInterior(rawDt); return; }
        // --- doors ---
        if (input.actHit('interact') && !player.dead && !player.vehicle) {
            const door = this.interiors.nearDoor();
            if (door) this.interiors.enter(door);
        }
        // --- weapon wheel (hold) ---
        const canWheel = !player.dead && !this.wantsCursor;
        if (input.actHit('weaponWheel') && canWheel) this.wheel.show(this.weapons);
        if (this.wheel.open) {
            this.wheel.move(input.mouseDX, input.mouseDY);
            if (input.wheel) this.wheel.step(input.wheel > 0 ? 1 : -1);
            if (!input.act('weaponWheel') || !canWheel) { const sel = this.wheel.close(); if (sel) this.weapons.equip(sel); }
        }
        this.timeScale = this.deathT > 0 ? this.timeScale : this.wheel.open ? CONFIG.weapons.wheelTimeScale : 1;
        const dt = rawDt * this.timeScale;
        this.time += dt;
        if (!this.wheel.open) this.cam.look(input, this.weapons.aiming && this.weapons.def.zoom ? 0.35 : 1);

        // --- enter / exit vehicles ---
        if (input.actHit('enterExit') && !player.dead && !this.wantsCursor) this._enterExit();

        // --- player-driven vehicle controls ---
        const pv = player.vehicle;
        if (pv) {
            if (input.actHit('camera')) this.hud.notify(this.cam.cycle(pv.rig), 1.5);
            if (input.actHit('horn')) this.audio.horn();
            pv.controls = player.dead ? PARKED : { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake };
        }
        // --- traffic + NPC drivers ---
        this.traffic.update(dt);
        for (const d of this.drivers) if (d.v.driver === d) d.update(dt, this.time);
        // --- vehicles ---
        const pos0 = player.position;
        for (const v of this.vehicles) {
            if (v !== pv && !(v.driver && v.driver !== 'player')) v.controls = PARKED;
            if (Math.abs(v.x - pos0.x) > 450 || Math.abs(v.y - pos0.y) > 450) continue;
            if (v.sleeping && v.health > 0 && v.burnT === undefined) continue;     // parked: no physics until disturbed
            const impacts = v.update(dt);
            for (const h of impacts) {
                if (h.speed > 6) v.damage((h.speed - 6) * 22, v === pv ? 'player' : null);
                if (v === pv) {
                    this.audio.impact(h.speed); this.cam.shake = Math.max(this.cam.shake, Math.min(0.8, h.speed / 30)); this._sparks(v, h);
                    if (h.speed > 18) this.hurtPlayer((h.speed - 18) * 2);
                }
            }
        }
        // vehicle vs vehicle (only those near the player)
        const near = this.vehicles.filter(v => Math.abs(v.x - pos0.x) < 300 && Math.abs(v.y - pos0.y) < 300);
        for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
            const a = near[i], b = near[j];
            const hit = vehicleVsVehicle(a.veh, b.veh);
            if (!hit) continue;
            a.sleeping = false; b.sleeping = false;          // a bump wakes parked cars
            if (hit.speed < 1) continue;
            if (hit.speed > 4) { a.damage((hit.speed - 4) * 18, b === pv ? 'player' : null); b.damage((hit.speed - 4) * 18, a === pv ? 'player' : null); }
            if (a === pv || b === pv) {
                this.audio.impact(hit.speed); this.cam.shake = Math.max(this.cam.shake, hit.speed / 30);
                const other = a === pv ? b : a;
                if (other.info.livery === 'police' && hit.speed > 5) this.crime('assault', other.x, other.y);
            }
        }
        if (pv && !pv.alive && !player.dead) { /* explosion damage handles it */ }
        if (pv && pv.inWater > 1.3) { player.exit(); this.hud.notify('Your vehicle sank. Swim back to shore!', 3); }

        // --- player on foot ---
        player.update(dt, input, this.cam.yaw, this.vehicles);
        let cross = { style: null, spread: 0 };
        if (!player.vehicle) cross = this.weapons.update(dt, input, !player.dead && !this.wheel.open && !this.wantsCursor && !player.swimming);
        else {
            // drive-by shooting (pistol / SMG) while aiming with the right mouse button
            cross = this.weapons.update(dt, input, !player.dead && !this.wheel.open && !this.wantsCursor);
            if (this.weapons.aiming) this.cam.idle = 0;     // keep the camera where you aim
        }

        // --- NPCs, police, pickups ---
        this.peds.update(dt);
        this.police.update(dt);
        this.pickups.update(dt);
        this.jobs.update(dt);
        if (this.deathT > 0) this._updateDeath(rawDt);

        // --- camera ---
        if (player.vehicle) this.cam.updateVehicle(rawDt, player.vehicle, input);
        else this.cam.updateFoot(rawDt, player, this.map, this.weapons.aiming ? { zoom: this.weapons.def.zoom } : false);

        // --- world streaming, clock, lights, effects ---
        const pos = player.position;
        this.streamer.update(pos.x, pos.y);
        const focus = player.vehicle ? player.vehicle.rig.root.position : player.person.root.position;
        this.env.update(input.act('fastTime') ? dt * 60 : dt, focus, this.camera);
        const night = this.env.night > 0.5;
        for (const v of this.vehicles) v.setLights(v.alive && night && (v === player.vehicle || !!v.driver));
        if (player.vehicle) {
            player.vehicle.setHeadlightSpot(night);
            player.vehicle.rig.root.updateMatrixWorld(true);
            this.effects.tyres(dt, player.vehicle.rig, player.vehicle.veh.skid, player.vehicle.veh.speed);
        }
        this.effects.update(dt);
        this.fx.update(dt);

        // --- audio ---
        if (player.vehicle) {
            const v = player.vehicle.veh;
            this.audio.update({ active: player.vehicle.alive, rpm: v.rpm, cylinders: v.P.cylinders || 4, throttle: v.throttle, redline: v.P.redline, limiter: v.limiter, skid: v.skid, speed: v.speed, inside: this.cam.rig.inside });
        } else this.audio.update(IDLE_AUDIO);
        this.audio.siren(this.police.stars > 0 ? Math.max(0, 1 - this.police.nearest / 220) : 0);

        // --- HUD ---
        this._prompts();
        this.hud.zone(this.zoneName(pos.x, pos.y));
        this.hud.update(rawDt, this._hudState(cross));
    }

    _updateInterior(rawDt) {
        const input = this.input, player = this.player;
        if (this.shopUI.open && input.hit('Escape')) this.shopUI.close();
        if (!this.shopUI.open) this.cam.look(input);
        player.update(rawDt, this.shopUI.open ? FROZEN_INPUT : input, this.cam.yaw, NO_VEHICLES);
        this.weapons.update(rawDt, input, false);
        this.interiors.update();
        this.cam.updateFoot(rawDt, player, this.activeMap, false);
        this.env.update(rawDt, player.person.root.position, this.camera);
        this.audio.update(IDLE_AUDIO);
        this.audio.siren(0);
        if (this.shopUI.open) document.getElementById('shop-money').textContent = '$' + Math.round(this.money).toLocaleString();
        this.hud.update(rawDt, this._hudState({ style: null }));
    }

    _enterExit() {
        const player = this.player;
        if (player.vehicle) {
            if (Math.abs(player.vehicle.veh.forwardSpeed) < CONFIG.player.exitMaxSpeed || player.vehicle.inWater > 0.5) {
                player.vehicle.setHeadlightSpot(false);
                player.exit();
                this.cam.pitch = 0.18;
            }
            return;
        }
        const v = player.nearestVehicle(this.vehicles);
        if (!v) return;
        // carjacking: throw the NPC driver out
        const d = v.driver;
        if (d && d !== 'player') {
            const dp = v.doorPoint(1);
            const ped = this.peds.spawnFleeing(dp.x, dp.y, player.x, player.y);
            d.v.driver = null;
            this.drivers = this.drivers.filter(x => x !== d);
            this.crime(v.info.livery === 'police' ? 'policeCarJack' : 'carJack', v.x, v.y);
            void ped;
        }
        player.enter(v);
        this.cam.lookYaw = 0;
    }

    _prompts() {
        const p = this.player;
        if (p.vehicle || p.dead) { this.hud.prompt(''); return; }
        const v = p.nearestVehicle(this.vehicles);
        const jp = this.jobs.prompt();
        if (jp) { this.hud.prompt(jp); return; }
        if (v) { this.hud.prompt(`<kbd>F</kbd> ${v.driver && v.driver !== 'player' ? 'Steal' : 'Enter'} ${v.info.name || 'vehicle'}`); return; }
        for (const b of this.specialBlips) {
            if (Math.abs(b.x - p.x) < 2.5 && Math.abs(b.y - p.y) < 2.5) { this.hud.prompt(this.doorPrompt ? this.doorPrompt(b) : SPECIAL_NAMES[b.type]); return; }
        }
        this.hud.prompt('');
    }

    _sparks(v, h) {
        if (h.speed < 3) return;
        const x = v.x - h.nx * 1.2, y = v.y - h.ny * 1.2;
        this.effects.impactSparks(x, v.veh.z + 0.5, -y, v.veh.vx, -v.veh.vy, h.speed);
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

    _hudState(cross = { style: null }) {
        const p = this.player;
        const heading = p.vehicle ? (this.cam.rig.current === 'chase' || this.cam.rig.current === 'far' ? this.cam.yaw : p.vehicle.th) : this.cam.yaw;
        const blips = [...this.specialBlips];
        for (const u of this.police.units) if (u.car.alive && !u.leaving) blips.push({ x: u.car.x, y: u.car.y, dot: true, color: Math.floor(this.time * 4) % 2 ? '#ff3b30' : '#3b6bff', size: 4 });
        for (const c of this.peds.copsActive) blips.push({ x: c.x, y: c.y, dot: true, color: '#3b6bff', size: 3 });
        for (const pd of this.peds.active) if (!pd.cop && !pd.dead && pd.state === 'fight') blips.push({ x: pd.x, y: pd.y, dot: true, color: '#ff3b30', size: 3 });
        if (this.extraBlips) blips.push(...this.extraBlips());
        if (this.waypoint) blips.push({ x: this.waypoint.x, y: this.waypoint.y, icon: '⚑', color: '#c77dff', edge: true });
        // crosshair turns red over enemies
        let style = cross.style;
        if (style && this.weapons.aiming) {
            const r = this.cam.aimRay();
            for (const pd of this.peds.active) {
                if (pd.dead || !(pd.cop || pd.state === 'fight')) continue;
                const dx = pd.x - r.ox, dy = pd.y - r.oy, dz = pd.z + 1.2 - r.oz;
                const t = dx * r.dx + dy * r.dy + dz * r.dz;
                if (t > 0 && Math.hypot(dx - r.dx * t, dy - r.dy * t, dz - r.dz * t) < 0.6) { style += ' enemy'; break; }
            }
        }
        return {
            player: p, vehicle: p.vehicle, clock: this.env.clockText, money: this.money,
            wanted: { stars: this.police.stars, flash: this.police.searching }, weapon: this.weapons.hud(), route: this.route,
            heading, blips, crosshair: style, spread: cross.spread,
        };
    }

    // ------------------------------------------------------------------ save
    snapshot() {
        const p = this.player, pos = p.position;
        Object.assign(this.save, {
            money: this.money, hour: this.env.hour, health: p.dead ? 100 : p.health, armour: p.armour,
            pos: { x: pos.x, y: pos.y, yaw: p.yaw }, outfit: p.outfit, weapons: this.weapons.serialize(),
        });
        return writeSave(this.save);
    }

    dispose() {
        this.streamer.dispose();
        this.effects.dispose();
        this.fx.dispose();
        this.pickups.dispose();
        this.jobs.dispose();
        this.traffic.dispose();
        this.peds.dispose();
        this.weapons.dispose();
        for (const v of this.vehicles) v.dispose();
        this.player.dispose();
    }
}

const FROZEN_INPUT = { moveX: 0, moveY: 0, act: () => false, actHit: () => false };
const NO_VEHICLES = [];
const PARKED = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
const IDLE_AUDIO = { active: false, rpm: 1000, cylinders: 8, throttle: 0, redline: 8000, skid: 0, speed: 0 };
export { THREE };
