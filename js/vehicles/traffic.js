// ============================================================================
// Ambient traffic.
//
//  - Keeps up to CONFIG.traffic.maxCars NPC cars (scaled by zone density) on
//    the roads around the player; far ones are recycled into a per-model
//    OBJECT POOL so meshes / materials are reused instead of rebuilt.
//  - Picks models by weight; rare models (supercar 1/200, sports 1/50, ...)
//    are rolled first on every spawn. Rare cars get a coloured glow ring and a
//    floating label, a radar blip and a HUD message.
//  - Draws the traffic lights at signalised junctions near the player
//    (pooled), driven by the same clock the AI uses to stop at red.
//  - Drivers panic and speed off when shooting starts nearby, swerve and
//    honk when the player drives at them, and bail out of burning cars.
// ============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { VehicleEntity } from './vehicleEntity.js';
import { Driver, lightState } from './driver.js';
import { createVehicleRig, CIVILIAN_COLORS, RARE_COLORS } from './carModels.js';

const T = CONFIG.traffic;

function labelSprite(text, color) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.6)'; x.beginPath(); x.roundRect(4, 8, 504, 80, 16); x.fill();
    x.strokeStyle = color; x.lineWidth = 4; x.stroke();
    x.fillStyle = color; x.font = 'bold 40px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 256, 50);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(4.8, 0.9, 1);
    s.renderOrder = 10;
    return s;
}

const RING_GEO = new THREE.RingGeometry(2.4, 3.2, 40).rotateX(-Math.PI / 2);

export class Traffic {
    constructor(game) {
        this.game = game;
        this.cars = [];             // { v, driver, model, rare }
        this.pool = new Map();      // model -> [VehicleEntity]
        this.spawnT = 0;
        this.panicT = 0;
        this.rareSeen = 0;
        this._weights = Object.entries(T.weights);
        this._wsum = this._weights.reduce((a, [, w]) => a + w, 0);
        this.lights = [];           // pooled traffic light groups
        this.lightMats = {
            red: new THREE.MeshBasicMaterial({ color: 0xff2a1a }), amber: new THREE.MeshBasicMaterial({ color: 0xffb000 }),
            green: new THREE.MeshBasicMaterial({ color: 0x30ff70 }), off: new THREE.MeshStandardMaterial({ color: 0x1a1a1a }),
        };
    }

    // country = true mixes in tractors and work trucks
    pickModel(country = false) {
        for (const [m, p] of Object.entries(T.rare)) if (Math.random() < p) return m;
        const list = country ? [...this._weights, ...Object.entries(T.countryWeights)] : this._weights;
        const sum = list.reduce((a, [, w]) => a + w, 0);
        let r = Math.random() * sum;
        for (const [m, w] of list) { r -= w; if (r <= 0) return m; }
        return 'saloon';
    }

    _take(model) {
        const list = this.pool.get(model);
        const info = { ...CONFIG.vehicles[model], model };
        const color = RARE_COLORS[model] || CIVILIAN_COLORS[Math.floor(Math.random() * CIVILIAN_COLORS.length)];
        let v = list && list.pop();
        if (v) {
            v.rig.setColor && !info.livery && v.rig.setColor(color);
            v.health = v.maxHealth; v.alive = true; v.burnT = undefined; v.wreckT = 0; v.lastHitBy = null;
            this.game.scene.add(v.rig.root);
        } else v = new VehicleEntity(this.game.world, createVehicleRig(model, color), info);
        if (info.rare && T.rareGlow) this._decorateRare(v, info);
        return v;
    }

    _decorateRare(v, info) {
        if (v.rareDeco) return;
        const col = info.livery === 'police' ? '#5a8cff' : (RARE_COLORS[info.model] || '#ffd24a');
        const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
        ring.position.y = 0.06;
        const label = labelSprite('★ RARE · ' + info.name, col);
        label.position.y = v.rig.dims.y + 1.2;
        v.rig.root.add(ring, label);
        v.rareDeco = { ring, label };
    }

    // Return a car to its pool (or dispose wrecks).
    _recycle(c) {
        const g = this.game, v = c.v;
        const vi = g.vehicles.indexOf(v);
        if (vi >= 0) g.vehicles.splice(vi, 1);
        v.sleeping = false; v.ambient = false;
        g.drivers = g.drivers.filter(d => d !== c.driver);
        if (v === g.personalCar || g.player.vehicle === v) return;
        if (!v.alive) { v.dispose(); return; }
        g.scene.remove(v.rig.root);
        v.driver = null;
        if (!this.pool.has(c.model)) this.pool.set(c.model, []);
        if (this.pool.get(c.model).length < 6) this.pool.get(c.model).push(v); else v.dispose();
    }

    _spawn() {
        const g = this.game, map = g.map, pos = g.player.position;
        const a = Math.random() * Math.PI * 2;
        const d = T.spawnRadius[0] + Math.random() * (T.spawnRadius[1] - T.spawnRadius[0]);
        const r = map.nearestRoad(pos.x + Math.cos(a) * d, pos.y + Math.sin(a) * d, 120);
        if (!r) return;
        const e = r.edge;
        if (Math.hypot(r.x - pos.x, r.y - pos.y) < T.spawnRadius[0] * 0.8) return;
        if (map.surfaceAt(r.x, r.y).water > 0.1) return;
        if (r.s < map.nodes[e.a].half + 4 || r.s > e.len - map.nodes[e.b].half - 4) return;   // not inside junctions
        for (const v of g.vehicles) if (Math.abs(v.x - r.x) < T.minGap && Math.abs(v.y - r.y) < T.minGap) return;
        const model = this.pickModel(e.type === 'country');
        const v = this._take(model);
        const fwd = Math.random() < 0.5;
        const lane = Math.floor(Math.random() * e.lanes);
        const driver = new Driver(g, v, { mode: 'cruise', lane });
        if ((CONFIG.vehicles[model].mass || 0) > 3000) driver.speedFactor *= T.busSpeedFactor;   // heavy vehicles are slower
        driver.placeOn(e, fwd, fwd ? r.s : e.len - r.s);
        g.addVehicle(v, driver);
        const rare = !!CONFIG.vehicles[model].rare;
        this.cars.push({ v, driver, model, rare });
        if (rare && T.rareNotify) {
            this.rareSeen++;
            g.hud.notify(`★ A rare <b>${CONFIG.vehicles[model].name}</b> was spotted nearby! Look for the glowing marker.`, 5);
            g.audio.pickup();
        }
    }

    // Shots / explosions near traffic: drivers floor it.
    alarm(x, y) {
        for (const c of this.cars) {
            if (c.driver.v.driver !== c.driver) continue;
            if (Math.hypot(c.v.x - x, c.v.y - y) < 70) { c.driver.panic = 12; c.driver.speedFactor = 1.4; }
        }
    }

    blips() {
        const out = [];
        for (const c of this.cars) if (c.rare && c.v.alive) out.push({ x: c.v.x, y: c.v.y, icon: '★', color: '#c77dff', edge: true });
        return out;
    }

    update(dt) {
        const g = this.game, pos = g.player.position, pv = g.player.vehicle;
        // density by where the player is
        const r = g.map.roadAt(pos.x, pos.y);
        const zone = r && r.edge.type === 'highway' ? 'highway' : g.map.zoneAt(pos.x, pos.y);
        const want = Math.round(T.maxCars * (T.density[zone] ?? 0.5) * (this.density ?? 1));
        // recycle far / abandoned cars
        for (let i = this.cars.length - 1; i >= 0; i--) {
            const c = this.cars[i], v = c.v;
            const d = Math.hypot(v.x - pos.x, v.y - pos.y);
            const stolen = v.driver === 'player' || pv === v;
            if (stolen) { this.cars.splice(i, 1); continue; }       // the player owns it now
            if (d > T.despawnRadius || (!v.alive && v.wreckT > 30 && d > 80)) { this._recycle(c); this.cars.splice(i, 1); continue; }
            const drv = c.driver;
            if (v.driver !== drv) continue;      // driver gone (carjacked / fled)
            // burning car: the driver gets out and runs
            if (v.burnT !== undefined || !v.alive) {
                const dp = v.doorPoint(1);
                g.peds.spawnFleeing(dp.x, dp.y, v.x, v.y);
                v.driver = null;
                continue;
            }
            if (drv.panic > 0) { drv.panic -= dt; if (drv.panic <= 0) drv.speedFactor = 0.9; }
            // the player driving fast straight at them: swerve + honk
            if (pv && pv.veh.speed > 12 && d < 16 && !drv.swerve) {
                const rvx = pv.veh.vx - v.veh.vx, rvy = pv.veh.vy - v.veh.vy;
                const closing = -((v.x - pv.x) * rvx + (v.y - pv.y) * rvy) / (d || 1);
                if (closing < -10) {
                    drv.swerve = (Math.random() < 0.5 ? -1 : 1) * 1.8;
                    if (Math.random() < T.honkChance) g.npcHonk(v);
                }
            }
        }
        this.spawnT -= dt;
        if (this.spawnT <= 0 && this.cars.length < want) { this.spawnT = 0.12; this._spawn(); }
        this._updateParked();
        this._updateLights();
    }

    // Parked cars: spots from the chunk data within ~140 m get a (pooled)
    // sleeping car; it is released again beyond ~200 m unless someone moved it.
    // Spots whose car was stolen / wrecked / pushed stay empty this session.
    _updateParked() {
        const g = this.game, pos = g.player.position, map = g.map;
        if (!this.parked) { this.parked = new Map(); this.parkGone = new Set(); this.parkT = 0; }
        this.parkT -= 1 / 60;
        if (this.parkT > 0) return;
        this.parkT = 0.5;
        const C = CONFIG.streaming.chunkSize;
        const cx0 = Math.floor((pos.x - 140) / C), cx1 = Math.floor((pos.x + 140) / C);
        const cy0 = Math.floor((pos.y - 140) / C), cy1 = Math.floor((pos.y + 140) / C);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
            for (const spot of map.chunkData(cx, cy).park) {
                if (this.parked.has(spot.id) || this.parkGone.has(spot.id)) continue;
                if (Math.hypot(spot.x - pos.x, spot.y - pos.y) > 140) continue;
                if (g.vehicles.some(o => Math.abs(o.x - spot.x) < 3 && Math.abs(o.y - spot.y) < 3)) continue;
                const model = this.pickParkedModel(spot);
                const v = this._take(model);
                v.place(spot.x, spot.y, spot.th);
                v.sleeping = true;
                v.parkedSpot = spot;
                g.addVehicle(v);
                this.parked.set(spot.id, { v, spot, model });
            }
        }
        for (const [id, c] of this.parked) {
            const v = c.v;
            const moved = Math.hypot(v.x - c.spot.x, v.y - c.spot.y) > 2 || !v.alive || v.driver;
            if (moved) { this.parkGone.add(id); this.parked.delete(id); v.parkedSpot = null; v.ambient = true; continue; }
            if (Math.hypot(v.x - pos.x, v.y - pos.y) > 200) {
                this.parked.delete(id);
                this._recycle({ v, model: c.model, driver: null });
            }
        }
        // abandoned former parked / stolen cars far away are cleaned up too
        for (const v of [...g.vehicles]) {
            if (!v.ambient || v === g.player.vehicle || v === g.personalCar || v.driver) continue;
            if (Math.hypot(v.x - pos.x, v.y - pos.y) > 350) this._recycle({ v, model: v.info.model, driver: null });
        }
    }

    pickParkedModel(spot) {
        const list = ['hatch', 'saloon', 'saloon', 'coupe', 'suv', 'suvLuxury', 'pickup', 'van', 'taxi'];
        if (Math.random() < 1 / 120) return 'classic';      // the odd rare car parked up
        return list[(spot.id * 7919 + Math.floor(spot.x)) % list.length | 0] || 'saloon';
    }

    // Pooled traffic lights at the signalised junctions within ~180 m.
    _updateLights() {
        const g = this.game, pos = g.player.position, map = g.map;
        const near = [];
        for (const n of map.nodes) if (n.signal && Math.abs(n.x - pos.x) < 180 && Math.abs(n.y - pos.y) < 180) near.push(n);
        while (this.lights.length < near.length) this.lights.push(this._makeLight());
        this.lights.forEach((L, i) => {
            const n = near[i];
            L.group.visible = !!n;
            if (!n) return;
            if (L.node !== n) {
                L.node = n;
                L.group.position.set(n.x, map.heightAt(n.x, n.y) + 0.15, -n.y);
                L.group.scale.setScalar(n.half / 7.5);
            }
            for (const h of L.heads) {
                const st = lightState(n, h.axis, g.time);
                h.red.material = st === 'red' ? this.lightMats.red : this.lightMats.off;
                h.amber.material = st === 'amber' ? this.lightMats.amber : this.lightMats.off;
                h.green.material = st === 'green' ? this.lightMats.green : this.lightMats.off;
            }
        });
    }

    _makeLight() {
        const group = new THREE.Group();
        const metal = new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.5, roughness: 0.5 });
        const heads = [];
        // one pole per corner, each head facing the traffic that approaches it
        const corners = [[8.5, -8.5, 'x', 0], [-8.5, 8.5, 'x', Math.PI], [8.5, 8.5, 'y', Math.PI / 2], [-8.5, -8.5, 'y', -Math.PI / 2]];
        const sphere = new THREE.SphereGeometry(0.16, 8, 6);
        for (const [x, y, axis, rot] of corners) {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), metal);
            pole.position.set(x, 2.1, -y);
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.25, 0.35), metal);
            const head = new THREE.Group();
            head.position.set(x, 3.9, -y);
            head.rotation.y = rot;
            head.add(box);
            const mk = (yy) => { const m = new THREE.Mesh(sphere, this.lightMats.off); m.position.set(0, yy, 0.19); head.add(m); return m; };
            const h = { axis, red: mk(0.38), amber: mk(0), green: mk(-0.38) };
            heads.push(h);
            group.add(pole, head);
        }
        this.game.scene.add(group);
        return { group, heads, node: null };
    }

    dispose() {
        for (const L of this.lights) this.game.scene.remove(L.group);
        for (const list of this.pool.values()) for (const v of list) v.dispose();
    }
}
