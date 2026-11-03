// ============================================================================
// Wanted level (0-5 stars) and the police response.
//
//  crime(type)  - a crime was committed (CONFIG.police.crimes says how many
//                 stars it is worth). Shooting only counts with witnesses;
//                 civilians may also phone it in (report()).
//  Patrol cars are spawned on roads around the player, drive to them with a
//  pursuit Driver, and deploy officers (from the pedestrian pool) who shoot.
//  Stay out of sight for CONFIG.police.evadeTime[stars] seconds to lose the
//  stars (they flash while the police are searching). Standing still next to
//  an officer gets you busted.
// ============================================================================
import { CONFIG } from '../config.js';
import { Driver } from '../vehicles/driver.js';
import { VehicleEntity } from '../vehicles/vehicleEntity.js';
import { createVehicleRig } from '../vehicles/carModels.js';

const P = CONFIG.police;

export class Police {
    constructor(game) {
        this.game = game;
        this.stars = 0;
        this.unseenT = 0;
        this.seenThisFrame = false;
        this.units = [];          // { car, driver, deployed, officers: [] }
        this.spawnT = 0;
        this.killsWhileWanted = 0;
        this.bustT = 0;
        this.sirenT = 0;
        this.nearest = Infinity;
    }

    get searching() { return this.stars > 0 && this.unseenT > 2; }

    setStars(n) {
        const before = this.stars;
        this.stars = Math.max(0, Math.min(5, n));
        if (this.stars > before) { this.unseenT = 0; this.game.onWanted(this.stars, before); }
        if (this.stars === 0 && before > 0) this._standDown();
    }

    // A crime at (x, y). Witnessed crimes raise the wanted level immediately.
    crime(type, x, y) {
        const g = this.game, level = P.crimes[type] || 1;
        const witnesses = g.peds.active.some(p => !p.dead && Math.hypot(p.x - x, p.y - y) < 40) ||
            this.units.some(u => Math.hypot(u.car.x - x, u.car.y - y) < P.sightRange);
        if (type === 'shooting' && !witnesses) return;
        if (this.stars === 0) { if (witnesses || type !== 'shooting') this.setStars(level); return; }
        // already wanted: serious crimes escalate
        if (type === 'copKilled') this.setStars(Math.max(this.stars + 1, level));
        else if (type === 'pedKilled' && ++this.killsWhileWanted % 3 === 0) this.setStars(this.stars + 1);
        else if (this.stars < level) this.setStars(level);
        this.seen();
    }

    // a civilian phoned it in
    report() { if (this.stars === 0) this.setStars(1); }

    seen() { this.seenThisFrame = true; }

    clear() { this.setStars(0); this.bustT = 0; }

    update(dt) {
        const g = this.game, player = g.player, pos = player.position;
        // police cars see the player too
        for (const u of this.units) if (u.car.alive && Math.hypot(u.car.x - pos.x, u.car.y - pos.y) < P.sightRange * 0.8) this.seenThisFrame = true;
        if (this.stars > 0) {
            if (this.seenThisFrame) this.unseenT = 0; else this.unseenT += dt;
            if (this.unseenT > P.evadeTime[this.stars]) { this.setStars(0); g.hud.notify('You lost the police.', 3); }
        }
        this.seenThisFrame = false;

        // --- keep the right number of cars chasing ---
        const wantCars = P.cars[this.stars];
        this.spawnT -= dt;
        const alive = this.units.filter(u => u.car.alive && !u.leaving);
        if (alive.length < wantCars && this.spawnT <= 0) { this.spawnT = 2.5; this._spawnCar(); }

        let nearest = Infinity;
        for (let i = this.units.length - 1; i >= 0; i--) {
            const u = this.units[i];
            const d = Math.hypot(u.car.x - pos.x, u.car.y - pos.y);
            if (u.car.alive && !u.leaving) nearest = Math.min(nearest, d);
            // release units that are far away / wrecked and out of view
            if (d > 450 || ((!u.car.alive || u.leaving) && d > 220)) { this._remove(u, i); continue; }
            if (u.driver.v.driver !== u.driver) { u.driver = null; u.leaving = true; continue; }   // carjacked
            if (!u.car.alive) continue;
            u.driver.target = pos;
            u.driver.aggression = this.stars >= 3 ? 1 : 0;
            // close and slow: officers get out and fight on foot
            if (!u.deployed && !u.leaving && this.stars > 0 && d < 28 && u.car.veh.speed < 4 && (!player.vehicle || player.vehicle.veh.speed < 6)) {
                u.deployed = true;
                u.driver.stopped = true;
                for (const side of [1, -1]) {
                    if (g.peds.copsActive.length >= P.officers[this.stars]) break;
                    const dp = u.car.doorPoint(side);
                    const cop = g.peds.spawnCop(dp.x, dp.y);
                    if (cop) u.officers.push(cop);
                }
            }
            // redeploy if the player drives off
            if (u.deployed && d > 70 && this.stars > 0) { u.deployed = false; u.driver.stopped = false; }
            // flashing light bar
            const rig = u.car.rig;
            if (rig.siren) {
                const on = this.stars > 0 && !u.leaving;
                const ph = Math.floor(g.time * 6) % 2;
                for (const m of rig.siren.lights) m.emissiveIntensity = on ? (ph ? 7 : 0.3) : 0.3;
                if (on) for (const m of rig.siren.tail) m.emissiveIntensity = ph ? 0.3 : 4;
            }
        }
        this.nearest = nearest;

        // --- busted: held still next to an officer while wanted ---
        if (this.stars > 0 && !player.vehicle && !player.dead) {
            const close = g.peds.copsActive.some(c => Math.hypot(c.x - player.x, c.y - player.y) < 2.2);
            if (close && player.speed < 1.2 && !player.aiming) this.bustT += dt; else this.bustT = Math.max(0, this.bustT - dt * 2);
            if (this.bustT > P.bustTime) { this.bustT = 0; g.busted(); }
        } else this.bustT = 0;
    }

    _spawnCar() {
        const g = this.game, pos = g.player.position, map = g.map;
        for (let tries = 0; tries < 8; tries++) {
            const a = Math.random() * Math.PI * 2;
            const dist = P.spawnDistance[0] + Math.random() * (P.spawnDistance[1] - P.spawnDistance[0]);
            const r = map.nearestRoad(pos.x + Math.cos(a) * dist, pos.y + Math.sin(a) * dist, 200);
            if (!r || Math.hypot(r.x - pos.x, r.y - pos.y) < 120) continue;
            if (map.surfaceAt(r.x, r.y).water > 0.2) continue;
            const rig = createVehicleRig('police');
            const car = new VehicleEntity(g.world, rig, { ...CONFIG.vehicles.police, model: 'police', police: true });
            const driver = new Driver(g, car, { mode: 'pursue', lane: 0 });
            driver.target = pos;
            // face towards the player
            const e = r.edge;
            const toward = (pos.x - r.x) * e.ux + (pos.y - r.y) * e.uy >= 0;
            driver.placeOn(e, toward, toward ? r.s : e.len - r.s);
            g.addVehicle(car, driver);
            this.units.push({ car, driver, deployed: false, officers: [], leaving: false });
            return;
        }
    }

    _remove(u, i) {
        this.units.splice(i, 1);
        if (this.game.player.vehicle !== u.car) this.game.removeVehicle(u.car);
    }

    // Wanted level gone: officers walk off, cars drive away.
    _standDown() {
        for (const u of this.units) {
            u.leaving = true;
            if (u.driver) { u.driver.mode = 'cruise'; u.driver.stopped = false; u.driver.target = null; }
        }
        for (const c of this.game.peds.copsActive) { c.state = 'flee'; c.fleeX = Math.random() - 0.5; c.fleeY = Math.random() - 0.5; c.timer = 30; }
        this.killsWhileWanted = 0;
    }

    dispose() { this.units.length = 0; }
}
