// The player character: walking / sprinting / jumping / swimming on foot,
// collisions with buildings, props and cars, and getting in / out of
// vehicles (press F). Health & armour live here too.
import * as THREE from 'three';
import { createPerson } from '../assets.js';
import { CONFIG } from '../config.js';
import { Rng, clamp, damp } from '../core/rng.js';
import { obbOverlap } from '../collide.js';

const P = CONFIG.player;
const _surf = {}, _cols = { boxes: [], circles: [] };

export class Player {
    constructor(world, outfit = {}) {
        this.world = world;
        this.x = P.spawn.x; this.y = P.spawn.y; this.z = 0;
        this.vx = 0; this.vy = 0; this.vz = 0;
        this.yaw = Math.PI / 2;       // map-frame heading the body faces
        this.onGround = true;
        this.swimming = false;
        this.vehicle = null;          // VehicleEntity while driving
        this.health = 100; this.maxHealth = 100;
        this.armour = 0; this.maxArmour = 100;
        this.dead = false;
        this.aiming = false;
        this.speed = 0;
        this.setOutfit(outfit);
    }

    // (Re)build the character model, e.g. after buying clothes.
    setOutfit(outfit) {
        if (this.person) this.world.scene.remove(this.person.root);
        this.outfit = { kind: 'man', top: '#2b3a55', bottom: '#1f1f22', ...outfit };
        this.person = createPerson(new Rng(7), this.outfit);
        this.person.anim = 'Idle';
        for (const [n, a] of Object.entries(this.person.actions)) a.setEffectiveWeight(n === 'Idle' ? 1 : 0);
        this.world.scene.add(this.person.root);
        this.person.root.visible = !this.vehicle;
    }

    get inVehicle() { return !!this.vehicle; }
    get position() { return this.vehicle ? { x: this.vehicle.x, y: this.vehicle.y } : { x: this.x, y: this.y }; }

    teleport(x, y, yaw = this.yaw) {
        this.x = x; this.y = y; this.yaw = yaw;
        this.vx = this.vy = this.vz = 0;
        this.z = this.world.map.surfaceAt(x, y, _surf).h;
        this._sync(0);
    }

    // input: Input, camYaw: map-frame yaw the camera looks along
    update(dt, input, camYaw, vehicles) {
        if (this.vehicle) { this.x = this.vehicle.x; this.y = this.vehicle.y; return; }
        const map = this.world.map;
        const surf = map.surfaceAt(this.x, this.y, _surf);
        const ground = surf.h;
        this.swimming = surf.water > 1.25;
        // desired velocity relative to the camera
        let mx = this.dead ? 0 : input.moveX, my = this.dead ? 0 : input.moveY;
        const len = Math.hypot(mx, my);
        if (len > 1) { mx /= len; my /= len; }
        const fwdX = Math.cos(camYaw), fwdY = Math.sin(camYaw);
        const rightX = Math.sin(camYaw), rightY = -Math.cos(camYaw);
        const dirX = fwdX * my + rightX * mx, dirY = fwdY * my + rightY * mx;
        const sprint = input.act('sprint') && !this.aiming;
        const speed = this.swimming ? P.swimSpeed : this.aiming ? P.walkSpeed * 1.4 : sprint ? P.sprintSpeed : P.jogSpeed;
        const tvx = dirX * speed, tvy = dirY * speed;
        const accel = this.onGround || this.swimming ? 12 : 2;
        this.vx = damp(this.vx, tvx, accel, dt);
        this.vy = damp(this.vy, tvy, accel, dt);
        // facing: aim direction while aiming, otherwise movement direction
        if (this.aiming) this.yaw = turn(this.yaw, camYaw, 18, dt);
        else if (len > 0.1) this.yaw = turn(this.yaw, Math.atan2(dirY, dirX), 10, dt);

        // jump / gravity
        if (this.swimming) {
            this.z = damp(this.z, CONFIG.map.seaLevel - 1.25, 6, dt); this.vz = 0; this.onGround = false;
        } else {
            if (this.onGround && input.actHit('jump') && !this.dead) { this.vz = P.jumpSpeed; this.onGround = false; }
            this.vz -= 14 * dt;
            this.z += this.vz * dt;
            if (this.z <= ground) {
                // step up kerbs smoothly, fall off ledges naturally
                this.z = this.onGround ? damp(this.z, ground, 30, dt) : ground;
                if (this.z < ground) this.z = ground;
                this.vz = 0; this.onGround = true;
            } else if (this.z - ground > 0.35) this.onGround = false;
            else if (this.vz <= 0) { this.z = damp(this.z, ground, 30, dt); this.onGround = true; this.vz = 0; }
        }
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this._collide(vehicles);
        // the sea pushes swimmers back at the edge of the world
        const lim = map.half - 60;
        if (Math.abs(this.x) > lim) this.x -= Math.sign(this.x) * 2 * dt;
        if (Math.abs(this.y) > lim) this.y -= Math.sign(this.y) * 2 * dt;
        this.speed = Math.hypot(this.vx, this.vy);
        this._sync(dt);
    }

    _collide(vehicles) {
        const r = P.radius, map = this.world.map;
        map.collidersNear(this.x, this.y, 4, _cols);
        for (const b of _cols.boxes) {
            const qx = clamp(this.x, b.x0, b.x1), qy = clamp(this.y, b.y0, b.y1);
            let dx = this.x - qx, dy = this.y - qy;
            const d = Math.hypot(dx, dy);
            if (d >= r) continue;
            if (d < 1e-5) {
                // inside: push out through the nearest face
                const opts = [[this.x - b.x0, -1, 0], [b.x1 - this.x, 1, 0], [this.y - b.y0, 0, -1], [b.y1 - this.y, 0, 1]].sort((a, c) => a[0] - c[0]);
                this.x += opts[0][1] * (opts[0][0] + r); this.y += opts[0][2] * (opts[0][0] + r);
                continue;
            }
            dx /= d; dy /= d;
            this.x += dx * (r - d); this.y += dy * (r - d);
            const vn = this.vx * dx + this.vy * dy;
            if (vn < 0) { this.vx -= vn * dx; this.vy -= vn * dy; }
        }
        for (const c of _cols.circles) {
            const dx = this.x - c.x, dy = this.y - c.y, d = Math.hypot(dx, dy), rr = r + c.r;
            if (d >= rr || d < 1e-5) continue;
            this.x += dx / d * (rr - d); this.y += dy / d * (rr - d);
        }
        // cars are solid (stand on them? no - just get pushed aside)
        for (const ve of vehicles) {
            if (Math.abs(ve.x - this.x) > 6 || Math.abs(ve.y - this.y) > 6) continue;
            const v = ve.veh;
            const hit = obbOverlap(this.x, this.y, 0, r, r, v.x, v.y, v.th, v.P.halfLength, v.P.halfWidth);
            if (!hit) continue;
            this.x += hit.nx * hit.depth; this.y += hit.ny * hit.depth;
        }
    }

    // pose the skinned model and blend Idle / Walk / Run
    _sync(dt) {
        const p = this.person;
        p.root.position.set(this.x, this.z, -this.y);
        p.root.rotation.set(0, this.yaw + Math.PI / 2, 0);
        if (this.dead) return;
        const sp = this.speed;
        const want = sp < 0.3 ? 'Idle' : sp < 2.4 ? 'Walk' : 'Run';
        if (want !== p.anim) { p.anim = want; p.fadeT = 0; }
        p.fadeT = Math.min(1, (p.fadeT ?? 1) + dt * 6);
        for (const [n, a] of Object.entries(p.actions)) {
            const w = a.getEffectiveWeight();
            a.setEffectiveWeight(n === p.anim ? Math.min(1, w + dt * 6) : Math.max(0, w - dt * 6));
        }
        p.actions.Walk.timeScale = Math.max(0.6, sp / 1.35);
        p.actions.Run.timeScale = Math.max(0.8, sp / 3.9);
        p.mixer.update(dt);
        if (this._armDir) this._applyArms();
    }

    // Aiming pose: point the right arm (and left for two-handed guns) along
    // `dir` (three.js world vector), applied on top of the walk animation.
    poseArms(dir, twoHanded) {
        this._armDir = dir ? (this._armDir || new THREE.Vector3()).copy(dir) : null;
        this._twoHanded = twoHanded;
        if (dir && !this.vehicle) this._applyArms();
    }

    _applyArms() {
        const B = this.person.bones, d = this._armDir;
        if (!B.RightArm || !B.RightForeArm || !B.RightHand) return;
        // lift the aim a little: the shoulder is above the camera's aim line
        pointBone(B.RightArm, B.RightForeArm, d);
        pointBone(B.RightForeArm, B.RightHand, d);
        if (this._twoHanded && B.LeftArm && B.LeftForeArm && B.LeftHand) {
            B.RightHand.getWorldPosition(_a);
            _a.addScaledVector(d, 0.28);
            twoBoneIK(B.LeftArm, B.LeftForeArm, B.LeftHand, _a);
        }
    }

    // --- vehicles ---------------------------------------------------------
    nearestVehicle(vehicles) {
        let best = null, bd = P.enterVehicleRange;
        for (const v of vehicles) {
            if (!v.alive || v.driver === 'player') continue;
            const d = Math.hypot(v.x - this.x, v.y - this.y) - v.veh.P.halfWidth;
            if (d < bd) { bd = d; best = v; }
        }
        return best;
    }

    enter(vehicle) {
        this.vehicle = vehicle;
        vehicle.driver = 'player';
        this.person.root.visible = false;
        this.aiming = false;
    }

    // Leave the car on the driver's side (or the other side if blocked).
    exit() {
        const v = this.vehicle;
        if (!v) return false;
        const map = this.world.map;
        let spot = v.doorPoint(1);
        map.collidersNear(spot.x, spot.y, 1.5, _cols);
        const blocked = _cols.boxes.some(b => spot.x > b.x0 - 0.4 && spot.x < b.x1 + 0.4 && spot.y > b.y0 - 0.4 && spot.y < b.y1 + 0.4);
        if (blocked) spot = v.doorPoint(-1);
        v.driver = null;
        this.vehicle = null;
        this.person.root.visible = true;
        this.teleport(spot.x, spot.y, v.th);
        return true;
    }

    // --- damage ------------------------------------------------------------
    damage(amount) {
        if (this.dead) return;
        const toArmour = Math.min(this.armour, amount * 0.7);
        this.armour -= toArmour;
        this.health -= amount - toArmour;
        if (this.health <= 0) { this.health = 0; this.dead = true; }
    }

    heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); }

    dispose() { this.world.scene.remove(this.person.root); }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qp = new THREE.Quaternion();
// Rotate `bone` (in world space) so the direction towards `child` matches `dir`.
function pointBone(bone, child, dir) {
    bone.updateWorldMatrix(true, true);
    bone.getWorldPosition(_a); child.getWorldPosition(_b);
    _d.subVectors(_b, _a).normalize();
    _qa.setFromUnitVectors(_d, dir);
    bone.getWorldQuaternion(_qb);
    _qb.premultiply(_qa);
    bone.parent.getWorldQuaternion(_qp);
    bone.quaternion.copy(_qp.invert().multiply(_qb));
    bone.updateWorldMatrix(false, true);
}

// Two-bone IK: place `hand` at `target` bending the elbow downwards.
const _s = new THREE.Vector3(), _e = new THREE.Vector3(), _h = new THREE.Vector3(), _axis = new THREE.Vector3(), _dn = new THREE.Vector3(0, -1, 0);
function twoBoneIK(upper, fore, hand, tgt) {
    const target = tgt.clone();   // pointBone() reuses the scratch vectors
    upper.updateWorldMatrix(true, true);
    upper.getWorldPosition(_s); fore.getWorldPosition(_e); hand.getWorldPosition(_h);
    const a = _s.distanceTo(_e), b = _e.distanceTo(_h);
    const toT = _c.subVectors(target, _s);
    const d = Math.min(toT.length(), a + b - 1e-3);
    toT.normalize();
    const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
    _axis.crossVectors(toT, _dn);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    const upDir = _d.copy(toT).applyAxisAngle(_axis, -Math.acos(cosA));
    pointBone(upper, fore, upDir.clone());
    fore.getWorldPosition(_e);
    pointBone(fore, hand, _c.subVectors(target, _e).normalize().clone());
}

function turn(a, b, rate, dt) {
    let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d));
    return a + d * Math.min(1, rate * dt);
}

export { THREE };
