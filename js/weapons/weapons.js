// The player's weapons: inventory & ammo, firing (semi / automatic / pellets),
// reload, recoil, spread + bloom, aiming, hit markers, muzzle flash, tracers,
// sounds, and the gun model held in the character's hand.
// All stats come from CONFIG.weapons.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { traceShot } from './combat.js';
import { clamp } from '../core/rng.js';

const W = CONFIG.weapons;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

// --- simple gun models (boxes), barrel along -Z, grip at origin ------------
export function gunModel(id) {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x1d1f22, metalness: 0.7, roughness: 0.4 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 });
    const box = (w, h, l, x, y, z, m = metal) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(x, y, z); g.add(b); };
    const len = { pistol: 0.2, smg: 0.38, shotgun: 0.85, rifle: 0.8, sniper: 1.1 }[id] || 0.2;
    box(0.04, 0.12, 0.05, 0, -0.04, 0.02);                    // grip
    box(0.045, 0.06, len, 0, 0.03, -len / 2 + 0.05);           // body / barrel
    if (id !== 'pistol') box(0.05, 0.08, 0.25, 0, 0.0, 0.2, id === 'shotgun' || id === 'sniper' ? wood : metal);   // stock
    if (id === 'smg' || id === 'rifle') box(0.03, 0.14, 0.05, 0, -0.06, -0.1);                                    // magazine
    if (id === 'sniper') box(0.05, 0.05, 0.3, 0, 0.09, -0.25);                                                     // scope
    if (id === 'shotgun') box(0.05, 0.05, 0.4, 0, -0.02, -0.4, wood);                                              // pump
    g.userData.muzzle = new THREE.Vector3(0, 0.03, -len + 0.03);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return g;
}

export class WeaponSystem {
    constructor(game, saved) {
        this.game = game;
        this.inv = { unarmed: { clip: 0, reserve: 0 } };
        if (saved && saved.inv) Object.assign(this.inv, saved.inv);
        else for (const [id, ammo] of Object.entries(W.startWeapons)) this.give(id, ammo);
        this.current = saved && this.inv[saved.current] ? saved.current : 'unarmed';
        this.cooldown = 0;
        this.reloadT = 0;
        this.bloom = 0;
        this.models = {};
        this.held = null;
        this.aiming = false;
    }

    get def() { return W[this.current]; }
    owned(id) { return !!this.inv[id]; }
    list() { return W.order.filter(id => this.inv[id]); }

    give(id, ammo = 0) {
        if (!this.inv[id]) this.inv[id] = { clip: 0, reserve: 0 };
        this.addAmmo(id, ammo);
        const s = this.inv[id], d = W[id];
        if (!d.melee && s.clip === 0) { const n = Math.min(d.clip, s.reserve); s.clip += n; s.reserve -= n; }
    }
    addAmmo(id, n) {
        const s = this.inv[id], d = W[id];
        if (!s || d.melee) return 0;
        const room = d.maxAmmo - s.reserve;
        const add = Math.max(0, Math.min(room, n));
        s.reserve += add;
        return add;
    }
    ammoFull(id) { const s = this.inv[id]; return s && s.reserve >= W[id].maxAmmo; }

    equip(id) {
        if (!this.inv[id] || id === this.current) return;
        this.current = id;
        this.reloadT = 0; this.cooldown = 0.25; this.bloom = 0;
        this.game.audio.reload();
    }
    cycle(dir) {
        const l = this.list();
        const i = l.indexOf(this.current);
        this.equip(l[(i + dir + l.length) % l.length]);
    }

    serialize() { return { current: this.current, inv: JSON.parse(JSON.stringify(this.inv)) }; }

    // HUD info
    hud() {
        const d = this.def, s = this.inv[this.current];
        return { name: d.name, melee: !!d.melee, clip: s.clip, reserve: s.reserve, reloading: this.reloadT > 0 };
    }

    startReload() {
        const d = this.def, s = this.inv[this.current];
        if (d.melee || this.reloadT > 0 || s.clip >= d.clip || s.reserve <= 0) return;
        this.reloadT = d.reload;
        this.game.audio.reload();
    }

    // Called every frame while on foot. Returns the crosshair style.
    update(dt, input, canAct) {
        const game = this.game, player = game.player;
        const d = this.def, s = this.inv[this.current];
        this.cooldown = Math.max(0, this.cooldown - dt);
        this.bloom = Math.max(0, this.bloom - dt * 0.12);
        if (this.reloadT > 0) {
            this.reloadT -= dt;
            if (this.reloadT <= 0) { const n = Math.min(d.clip - s.clip, s.reserve); s.clip += n; s.reserve -= n; }
        }
        this.aiming = canAct && input.mouse.right && !d.melee;
        player.aiming = this.aiming;
        if (canAct) {
            if (input.wheel) this.cycle(input.wheel > 0 ? 1 : -1);
            if (input.actHit('reload')) this.startReload();
            const trigger = d.auto ? input.mouse.left : input.mouseHit(0);
            if (trigger && this.cooldown <= 0 && this.reloadT <= 0) this.fire();
        }
        this._updateModel();
        if (d.melee) return { style: canAct ? 'dot' : null, spread: 0 };
        return { style: this.aiming ? (d.zoom ? 'aim sniper' : 'aim') : 'dot', spread: this.spread() };
    }

    spread() {
        const d = this.def;
        const move = clamp(this.game.player.speed / 6, 0, 1);
        return (this.aiming ? d.aimSpread : d.spread) + this.bloom + move * (d.spread * 0.6);
    }

    fire() {
        const game = this.game, d = this.def, s = this.inv[this.current], player = game.player;
        this.cooldown = 1 / d.fireRate;
        if (d.melee) return this._punch();
        if (s.clip <= 0) { game.audio.click(); this.startReload(); return; }
        s.clip--;
        const cam = game.cam, ray = cam.aimRay();
        // start the ray level with the player so nothing between camera and player is hit
        const t0 = Math.max(0, (player.x - ray.ox) * ray.dx + (player.y - ray.oy) * ray.dy + (player.z + 1.4 - ray.oz) * ray.dz);
        const ox = ray.ox + ray.dx * t0, oy = ray.oy + ray.dy * t0, oz = ray.oz + ray.dz * t0;
        const muzzle = this.muzzleWorld();
        const sp = this.spread();
        let hitAny = false, kill = false;
        for (let k = 0; k < (d.pellets || 1); k++) {
            // random direction inside the spread cone
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * sp;
            const ux = -ray.dy, uy = ray.dx;                       // horizontal right-ish axis
            const ul = Math.hypot(ux, uy) || 1;
            let dx = ray.dx + (ux / ul) * Math.cos(a) * r, dy = ray.dy + (uy / ul) * Math.cos(a) * r, dz = ray.dz + Math.sin(a) * r;
            const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
            const hit = traceShot(game, ox, oy, oz, dx, dy, dz, d.range, player);
            game.fx.tracer(muzzle.x, muzzle.y, muzzle.z, hit.x, hit.y, hit.z);
            const dmg = d.damage * (hit.head ? W.headshotMultiplier : 1);
            if (hit.kind === 'ped') { hitAny = true; if (game.peds.damage(hit.target, dmg, 'player', hit)) kill = true; }
            else if (hit.kind === 'vehicle') { hitAny = true; hit.target.damage(dmg * 0.6, 'player'); game.effects.impactSparks(hit.x, hit.z, -hit.y, 0, 0, 2); }
            else if (hit.kind === 'world') game.effects.dust(hit.x, hit.z, -hit.y);
        }
        if (hitAny) { game.hud.hitMarker(kill); game.audio.hitmark(kill); }
        game.fx.flash(muzzle.x, muzzle.y, muzzle.z, d.pellets > 1 || d.zoom);
        game.audio.gunshot(d.sound);
        this.bloom = Math.min(d.spread * 1.5, this.bloom + d.bloom);
        cam.pitch -= d.recoil * (this.aiming ? 0.7 : 1);
        cam.yaw += (Math.random() - 0.5) * d.recoil * 0.4;
        cam.shake = Math.max(cam.shake, d.recoil * 2);
        game.crime('shooting', player.x, player.y);
        if (s.clip === 0) this.startReload();
    }

    _punch() {
        const game = this.game, p = game.player;
        const fx = Math.cos(p.yaw), fy = Math.sin(p.yaw);
        let best = null, bd = W.unarmed.range;
        for (const ped of game.peds.active) {
            if (ped.dead) continue;
            const dx = ped.x - p.x, dy = ped.y - p.y, dist = Math.hypot(dx, dy);
            if (dist < bd && (dx * fx + dy * fy) / (dist || 1) > 0.5) { bd = dist; best = ped; }
        }
        if (best) {
            const kill = game.peds.damage(best, W.unarmed.damage, 'player', { x: best.x, y: best.y, z: best.z + 1.4, punch: true });
            game.audio.impact(4); game.hud.hitMarker(kill);
            game.crime('assault', p.x, p.y);
        }
    }

    // gun tip in map frame
    muzzleWorld() {
        if (!this.held) { const p = this.game.player; return { x: p.x + Math.cos(p.yaw) * 0.5, y: p.y + Math.sin(p.yaw) * 0.5, z: p.z + 1.4 }; }
        this.held.updateMatrixWorld(true);
        _v.copy(this.held.userData.muzzle).applyMatrix4(this.held.matrixWorld);
        return { x: _v.x, y: -_v.z, z: _v.y };
    }

    // Position the gun in the right hand and pose the arms while aiming.
    _updateModel() {
        const game = this.game, player = game.player;
        const id = this.current;
        const show = id !== 'unarmed' && !player.vehicle && !player.dead && !game.interiors.inside;
        if (!this.models[id] && id !== 'unarmed') { this.models[id] = gunModel(id); game.activeScene.add(this.models[id]); }
        for (const [k, m] of Object.entries(this.models)) m.visible = show && k === id;
        this.held = show ? this.models[id] : null;
        // arms
        const aimDir = this.aiming || (show && this.cooldown > 0 && !W[id].melee) ? game.camera.getWorldDirection(new THREE.Vector3()) : null;
        player.poseArms(aimDir, show && W[id].pellets !== undefined && id !== 'pistol');
        if (!this.held) return;
        const hand = player.person.bones.RightHand;
        if (!hand) return;
        hand.getWorldPosition(this.held.position);
        if (aimDir) {
            _q.setFromUnitVectors(_v.set(0, 0, -1), aimDir);
            this.held.quaternion.copy(_q);
        } else {
            // low ready: pointing forward and down
            const yaw = player.yaw - Math.PI / 2;      // barrel (-Z) along the body heading
            this.held.rotation.set(-0.9, yaw, 0, 'YXZ');
        }
    }

    dispose() { for (const m of Object.values(this.models)) this.game.scene.remove(m); }
}
