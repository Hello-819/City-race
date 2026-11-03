// ============================================================================
// Pedestrians & police officers on foot.
//
// A fixed POOL of skinned characters is recycled around the player:
// civilians spawn on pavements just out of view and walk loops around their
// block; far-away ones are recycled. They react to violence:
//   FLEE  - run away from the danger
//   CALL  - phone the police (raises the wanted level after a few seconds)
//   FIGHT - armed civilians and police officers shoot back
// They can be shot, punched or run over (they fall and drop cash).
// ============================================================================
import * as THREE from 'three';
import { createPerson, COP_KINDS } from '../assets.js';
import { Ragdoll } from './ragdoll.js';
import { CONFIG } from '../config.js';
import { Rng, clamp, damp } from '../core/rng.js';
import { obbOverlap } from '../collide.js';
import { lineOfSight } from '../weapons/combat.js';
import { gunModel } from '../weapons/weapons.js';

const N = CONFIG.npc;
export const PED = { WALK: 'walk', IDLE: 'idle', FLEE: 'flee', CALL: 'call', FIGHT: 'fight', DEAD: 'dead' };
const _cols = { boxes: [], circles: [] };
const _s = {};

export class Peds {
    constructor(game) {
        this.game = game;
        this.rng = new Rng(4242);
        this.pool = [];         // civilians
        this.copPool = [];      // officers
        this.active = [];       // every ped currently in the world
        for (let i = 0; i < N.pedCount; i++) this.pool.push(this._make(false, i));
        for (let i = 0; i < CONFIG.police.officers[5]; i++) this.copPool.push(this._make(true, i));
        this.spawnTimer = 0;
        this.frame = 0;
    }

    _make(cop, i) {
        const r = this.rng;
        // officers wear SWAT / tactical gear; civilians are any of the character models
        const opts = cop ? { kind: COP_KINDS[i % COP_KINDS.length], noTint: true } : {};
        const person = createPerson(r, opts);
        person.root.visible = false;
        this.game.scene.add(person.root);
        const gun = gunModel('pistol');
        gun.visible = false;
        this.game.scene.add(gun);
        return { person, gun, cop, active: false, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, speed: 0, state: PED.WALK, health: N.health, dead: false, anim: 'Idle' };
    }

    // ---------------------------------------------------------------- spawn
    _activate(p, x, y) {
        p.active = true; p.dead = false; p.health = N.health * (p.cop ? 1.2 : 1);
        p.x = x; p.y = y; p.z = this.game.map.surfaceAt(x, y, _s).h;
        p.vx = p.vy = 0; p.speed = 0; p.timer = 0; p.deadT = 0; p.shootCD = 1 + Math.random(); p.callT = 0;
        p.walkSpeed = this.rng.range(N.walkSpeed[0], N.walkSpeed[1]);
        p.armed = p.cop || this.rng.chance(N.armedChance);
        p.person.root.visible = true;
        p.person.root.rotation.set(0, 0, 0);
        p.fall = 0;
        p.ragdoll = null;
        p.seen = false;
        this.active.push(p);
    }

    _release(p) {
        p.active = false;
        p.person.root.visible = false;
        p.gun.visible = false;
        const i = this.active.indexOf(p);
        if (i >= 0) this.active.splice(i, 1);
    }

    // Walk loop around a block's pavement (rectangle inset from the kerb).
    _loopFor(b) {
        const k = b.zone === 'city' ? 1.9 : b.sw * 0.5;
        return [[b.x0 + k, b.y0 + k], [b.x1 - k, b.y0 + k], [b.x1 - k, b.y1 - k], [b.x0 + k, b.y1 - k]];
    }

    _trySpawnCivilian() {
        const p = this.pool.find(q => !q.active);
        if (!p) return;
        const g = this.game, pos = g.player.position, r = this.rng;
        for (let tries = 0; tries < 6; tries++) {
            const a = r.range(0, Math.PI * 2), d = r.range(N.spawnMin, N.spawnMax);
            const x = pos.x + Math.cos(a) * d, y = pos.y + Math.sin(a) * d;
            const b = g.map.blockAt(x, y);
            if (!b) continue;
            const loop = this._loopFor(b);
            const leg = r.int(0, 3), t = r.float();
            const [ax, ay] = loop[leg], [bx, by] = loop[(leg + 1) % 4];
            this._activate(p, ax + (bx - ax) * t, ay + (by - ay) * t);
            p.loop = loop; p.dir = r.sign(); p.leg = p.dir > 0 ? (leg + 1) % 4 : leg;
            p.state = r.chance(0.12) ? PED.IDLE : PED.WALK;
            p.timer = r.range(2, 6);
            return;
        }
    }

    // Police officer joining the fight (from a patrol car or on foot).
    spawnCop(x, y) {
        const p = this.copPool.find(q => !q.active);
        if (!p) return null;
        this._activate(p, x, y);
        p.state = PED.FIGHT;
        return p;
    }

    // A civilian appears at (x, y) and runs away from (fx, fy), e.g. a carjacked driver.
    spawnFleeing(x, y, fx, fy) {
        const p = this.pool.find(q => !q.active);
        if (!p) return null;
        this._activate(p, x, y);
        p.armed = false;
        this._flee(p, fx, fy);
        return p;
    }

    // Armed gang member for missions: fights until killed, never wanders off.
    spawnHostile(x, y) {
        const p = this.pool.find(q => !q.active);
        if (!p) return null;
        this._activate(p, x, y);
        p.armed = true; p.hostile = true;
        p.health = 140;
        p.state = PED.FIGHT;
        return p;
    }

    get copsActive() { return this.active.filter(p => p.cop && !p.dead); }

    // ------------------------------------------------------------- reactions
    // Something violent happened at (x, y). Witnesses react.
    alarm(x, y, radius = N.reactRadius) {
        const r = this.rng;
        for (const p of this.active) {
            if (p.dead || p.cop || p.state === PED.FIGHT || p.state === PED.CALL) continue;
            if (Math.hypot(p.x - x, p.y - y) > radius) continue;
            if (p.armed) { p.state = PED.FIGHT; continue; }
            if (p.state === PED.FLEE) continue;
            if (r.chance(N.callPoliceChance)) { p.state = PED.CALL; p.callT = N.callTime; }
            else this._flee(p, x, y);
        }
    }

    _flee(p, x, y) {
        p.state = PED.FLEE;
        const a = Math.atan2(p.y - y, p.x - x) + this.rng.range(-0.5, 0.5);
        p.fleeX = Math.cos(a); p.fleeY = Math.sin(a);
        p.timer = this.rng.range(8, 14);
    }

    // Returns true if the ped died. by: 'player' | 'cop' | 'car' ...
    // impulse: optional three.js world velocity given to the ragdoll
    damage(p, amount, by, hit = null, impulse = null) {
        if (p.dead) return false;
        p.health -= amount;
        const g = this.game;
        if (hit && !hit.punch) g.effects.blood(hit.x, hit.z, -hit.y);
        if (p.health <= 0) { this._kill(p, by, hit, impulse); return true; }
        if (by === 'player') {
            if (p.armed) p.state = PED.FIGHT;
            else this._flee(p, g.player.x, g.player.y);
            if (p.cop) g.crime('copHurt', p.x, p.y);
        }
        return false;
    }

    _kill(p, by, hit, impulse = null) {
        const g = this.game;
        p.dead = true; p.state = PED.DEAD; p.deadT = 0;
        p.gun.visible = false;
        // fall away from the shooter
        const ax = hit ? p.x - g.player.x : Math.cos(p.yaw), ay = hit ? p.y - g.player.y : Math.sin(p.yaw);
        p.fallDir = Math.atan2(ay, ax);
        // ragdoll: knocked away from the attacker (bullets push gently, cars and blasts hard)
        if (!impulse) { const l = Math.hypot(ax, ay) || 1; impulse = new THREE.Vector3(ax / l * 2.5, 0.8, -ay / l * 2.5); }
        const map = g.activeMap || g.map;
        p.person.mixer.update(0);
        p.ragdoll = new Ragdoll(p.person, impulse, (x, z) => map.surfaceAt(x, -z).h, map);
        if (!p.ragdoll.ok) p.ragdoll = null;
        if (by === 'player' || by === 'playerCar') {
            g.crime(p.cop ? 'copKilled' : 'pedKilled', p.x, p.y);
            g.save.stats.kills++;
        }
        if (!p.cop || this.rng.chance(0.5)) {
            const [a, b] = N.cashDrop;
            g.pickups.add('cash', p.x + 0.4, p.y, Math.round(this.rng.range(a, b)));
        }
        if (p.cop && this.rng.chance(0.6)) g.pickups.add('ammo', p.x - 0.4, p.y, 24);
    }

    // --------------------------------------------------------------- update
    update(dt) {
        const g = this.game, player = g.player, pos = player.position;
        this.frame++;
        this.spawnTimer -= dt;
        const civs = this.active.reduce((n, p) => n + (p.cop ? 0 : 1), 0);
        const zone = g.map.zoneAt(pos.x, pos.y);
        const want = zone === 'country' ? 2 : zone === 'suburb' ? Math.round(N.pedCount * 0.55) : N.pedCount;
        if (this.spawnTimer <= 0 && civs < want) { this.spawnTimer = 0.15; this._trySpawnCivilian(); }
        for (let i = this.active.length - 1; i >= 0; i--) {
            const p = this.active[i];
            const dist = Math.hypot(p.x - pos.x, p.y - pos.y);
            if ((dist > N.despawn + (p.cop ? 80 : 0) && !(p.hostile && !p.dead && dist < 800)) || (p.dead && p.deadT > 40)) { this._release(p); continue; }
            this._think(p, dt, dist);
            this._hitByCars(p);
            this._pose(p, dt, dist);
        }
    }

    _think(p, dt, dist) {
        const g = this.game, player = g.player;
        if (p.dead) { p.deadT += dt; return; }
        let tx = 0, ty = 0, speed = 0;
        switch (p.state) {
            case PED.IDLE:
                p.timer -= dt;
                if (p.timer <= 0) { p.state = PED.WALK; p.timer = 0; }
                break;
            case PED.WALK: {
                if (!p.loop) { this._flee(p, p.x - 1, p.y); break; }
                const [cx, cy] = p.loop[p.leg];
                const dx = cx - p.x, dy = cy - p.y, d = Math.hypot(dx, dy);
                if (d < 0.6) {
                    p.leg = (p.leg + p.dir + 4) % 4;
                    if (this.rng.chance(0.15)) { p.state = PED.IDLE; p.timer = this.rng.range(2, 6); }
                } else { tx = dx / d; ty = dy / d; speed = p.walkSpeed; }
                // scared of fast cars coming at them / of the player with a gun out
                if (player.aiming && dist < 14) this._flee(p, player.x, player.y);
                break;
            }
            case PED.FLEE:
                p.timer -= dt;
                tx = p.fleeX; ty = p.fleeY; speed = N.runSpeed;
                if (p.timer <= 0) {
                    const b = g.map.blockAt(p.x, p.y);
                    if (b) { p.loop = this._loopFor(b); p.leg = 0; p.dir = 1; p.state = PED.WALK; }
                    else p.timer = 3;
                }
                break;
            case PED.CALL:
                p.callT -= dt;
                if (p.callT <= 0) { g.police.report(p.x, p.y); this._flee(p, player.x, player.y); }
                break;
            case PED.FIGHT: {
                const tp = player.position;
                const dx = tp.x - p.x, dy = tp.y - p.y, d = Math.hypot(dx, dy);
                if (player.dead || (!p.cop && !p.hostile && g.police.stars === 0 && p.calm > 20)) { this._flee(p, tp.x, tp.y); break; }
                p.calm = (p.calm || 0) + dt;
                const pz = player.vehicle ? player.vehicle.veh.z + 1 : player.z + 1.3;
                const see = d < (p.cop ? CONFIG.police.sightRange : 40) && lineOfSight(g.map, p.x, p.y, p.z + 1.5, tp.x, tp.y, pz);
                if (p.cop) { p.seen = see; if (see) g.police.seen(); }
                const want = p.cop ? 9 : 12;
                // chase until close enough and in sight, then stand and shoot
                if (!see || d > want + 6) { tx = dx / d; ty = dy / d; speed = d > 30 ? N.runSpeed : 3; }
                else if (p.cop && d > 3 && g.police.stars <= 1 && !player.vehicle && !(g.weapons && g.weapons.current !== 'unarmed')) { tx = dx / d; ty = dy / d; speed = 3.2; }
                p.aimYaw = Math.atan2(dy, dx);
                if (see && d < 60) {
                    p.shootCD -= dt;
                    if (p.shootCD <= 0) { p.shootCD = p.cop ? 0.7 + Math.random() * 0.6 : 0.9 + Math.random(); this._shoot(p, d, pz); }
                }
                break;
            }
        }
        p.vx = damp(p.vx, tx * speed, 8, dt);
        p.vy = damp(p.vy, ty * speed, 8, dt);
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.speed = Math.hypot(p.vx, p.vy);
        if (p.state === PED.FIGHT && p.aimYaw !== undefined && p.speed < 1.5) p.yaw = turnTo(p.yaw, p.aimYaw, 10, dt);
        else if (p.speed > 0.2) p.yaw = turnTo(p.yaw, Math.atan2(p.vy, p.vx), 8, dt);
        if (p.state !== PED.WALK && p.state !== PED.IDLE && dist < 120) this._collide(p);
        p.z = damp(p.z, g.map.surfaceAt(p.x, p.y, _s, p.z + 0.5).h, 20, dt);
    }

    _shoot(p, dist, pz) {
        const g = this.game, player = g.player;
        const tp = player.position;
        const P = CONFIG.police;
        const stars = g.police.stars;
        let acc = p.cop ? P.accuracy[Math.max(1, stars)] : N.accuracy;
        acc *= clamp(1.3 - dist / 60, 0.3, 1.2) * (player.speed > 3 ? 0.6 : 1) * (player.vehicle ? 0.7 : 1);
        const hit = Math.random() < acc;
        const mx = p.x + Math.cos(p.yaw) * 0.5, my = p.y + Math.sin(p.yaw) * 0.5, mz = p.z + 1.4;
        const miss = hit ? 0 : 1.2;
        g.fx.tracer(mx, my, mz, tp.x + (Math.random() - 0.5) * miss * 2, tp.y + (Math.random() - 0.5) * miss * 2, pz + (Math.random() - 0.5) * miss);
        g.fx.flash(mx, my, mz);
        g.audio.gunshot('npc', dist);
        if (hit) {
            const dmg = p.cop ? P.damage[Math.max(1, stars)] : 10;
            if (player.vehicle) { player.vehicle.damage(dmg * 2, 'npc'); if (Math.random() < 0.3) g.hurtPlayer(dmg * 0.5); }
            else g.hurtPlayer(dmg, new THREE.Vector3(Math.cos(p.yaw) * 3, 0.8, -Math.sin(p.yaw) * 3));
        }
    }

    _collide(p) {
        this.game.map.collidersNear(p.x, p.y, 3, _cols);
        const r = 0.35;
        for (const b of _cols.boxes) {
            if (b.zMax !== undefined && (p.z > b.zMax - 0.2 || p.z + 1.8 < b.zMin)) continue;
            const qx = clamp(p.x, b.x0, b.x1), qy = clamp(p.y, b.y0, b.y1);
            const dx = p.x - qx, dy = p.y - qy, d = Math.hypot(dx, dy);
            if (d >= r) continue;
            if (d < 1e-5) { p.x += (p.x < (b.x0 + b.x1) / 2 ? -1 : 1) * 0.5; continue; }
            p.x += dx / d * (r - d); p.y += dy / d * (r - d);
            // slide along the wall: keep only the tangential part of the flee direction
            if (p.state === PED.FLEE) {
                const nx = dx / d, ny = dy / d;
                let fx = p.fleeX - nx * (p.fleeX * nx + p.fleeY * ny), fy = p.fleeY - ny * (p.fleeX * nx + p.fleeY * ny);
                const l = Math.hypot(fx, fy);
                if (l < 0.1) { fx = -ny; fy = nx; } else { fx /= l; fy /= l; }
                p.fleeX = fx; p.fleeY = fy;
            }
        }
    }

    // Cars knock people down; the faster, the deadlier.
    _hitByCars(p) {
        if (p.dead) return;
        const g = this.game;
        for (const ve of g.vehicles) {
            const sp = ve.veh.speed;
            if (sp < 2.5 || Math.abs(ve.x - p.x) > 6 || Math.abs(ve.y - p.y) > 6) continue;
            const v = ve.veh;
            const hit = obbOverlap(p.x, p.y, 0, 0.3, 0.3, v.x, v.y, v.th, v.P.halfLength, v.P.halfWidth);
            if (!hit) continue;
            p.x += hit.nx * (hit.depth + 0.2); p.y += hit.ny * (hit.depth + 0.2);
            const byPlayer = ve.driver === 'player';
            const imp = new THREE.Vector3(v.vx * 0.9, 2.5 + sp * 0.15, -v.vy * 0.9);
            const killed = this.damage(p, sp * 9, byPlayer ? 'playerCar' : 'car', null, imp);
            if (killed) { g.effects.blood(p.x, p.z + 1, -p.y); p.fallDir = Math.atan2(v.vy, v.vx); }
            if (byPlayer) { g.audio.impact(5); if (!killed) g.crime('assault', p.x, p.y); else if (!p.cop) g.crime('pedKilled', p.x, p.y); }
            else if (!killed) this._flee(p, ve.x, ve.y);
            v.vx *= 0.93; v.vy *= 0.93;
            return;
        }
    }

    // Skinned animation, cheaper for distant peds.
    _pose(p, dt, dist) {
        const per = p.person;
        if (p.dead && p.ragdoll) { if (dist < 150) p.ragdoll.update(dt); return; }
        per.root.position.set(p.x, p.z, -p.y);
        if (p.dead) {
            // tip over and lie flat
            p.fall = Math.min(1, p.fall + dt * 3);
            per.root.rotation.set(0, p.fallDir + Math.PI / 2, 0, 'YXZ');
            per.root.rotateX(-p.fall * Math.PI / 2);
            per.root.position.y = p.z + 0.15 * p.fall;
            return;
        }
        per.root.rotation.set(0, p.yaw + Math.PI / 2, 0);
        const A = per.actions;
        let anim = p.speed < 0.3 ? 'Idle' : p.speed < 2.5 ? 'Walk' : 'Run';
        if (p.state === PED.CALL) anim = A.Wave ? 'Wave' : 'Idle';                       // on the phone
        else if (p.state === PED.FIGHT && p.armed && p.speed < 0.6 && A.GunIdle) anim = 'GunIdle';
        for (const [n, a] of Object.entries(per.actions)) {
            const w = a.getEffectiveWeight();
            a.setEffectiveWeight(n === anim ? Math.min(1, w + dt * 5) : Math.max(0, w - dt * 5));
        }
        A.Walk.timeScale = Math.max(0.6, p.speed / per.walkSpeed);
        A.Run.timeScale = Math.max(0.8, p.speed / per.runSpeed);
        const every = dist < 50 ? 1 : dist < 100 ? 2 : 4;
        if (this.frame % every === 0) per.mixer.update(dt * every);
        // gun in hand while fighting
        const showGun = p.state === PED.FIGHT && p.armed && dist < 80;
        p.gun.visible = showGun;
        if (showGun && per.bones.RightHand) {
            per.bones.RightHand.getWorldPosition(p.gun.position);
            p.gun.rotation.set(-0.2, (p.aimYaw ?? p.yaw) - Math.PI / 2, 0, 'YXZ');
        }
    }

    dispose() {
        for (const p of [...this.pool, ...this.copPool]) { this.game.scene.remove(p.person.root); this.game.scene.remove(p.gun); }
    }
}

function turnTo(a, b, rate, dt) {
    let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d));
    return a + d * Math.min(1, rate * dt);
}

export { THREE };
