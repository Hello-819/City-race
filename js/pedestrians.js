// City pedestrians: walk along both sidewalks, cross the road at crosswalks (and
// sometimes jaywalk), flee from speeding cars and get knocked over when hit.
import * as THREE from 'three';
import { createPerson } from './assets.js';
import { Rng, clamp } from './core/rng.js';

const WALK = 0, CROSS = 1, IDLE = 2, FLEE = 3, DOWN = 4, WAIT = 5;

export class Pedestrians {
    constructor(scene, world, seed, count) {
        this.scene = scene;
        this.world = world;
        this.road = world.road;
        this.rng = new Rng(seed ^ 0x9e3779b9);
        this.peds = [];
        this.events = [];
        this.enabled = world.kind === 'city' && count > 0;
        if (!this.enabled) return;
        for (let i = 0; i < count; i++) {
            const p = createPerson(this.rng);
            p.baseY = p.model.position.y;
            scene.add(p.root);
            this.peds.push({
                ...p, state: WALK, s: -1e9, d: 0, dir: 1, speed: 1.3, timer: 0, crossTo: 0, anim: 'Walk',
                x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, spinAxis: new THREE.Vector3(1, 0, 0), downT: 0, hitBy: null, heading: 0,
                fleeCool: 0, settled: false,
            });
        }
        this.events = [];
        this.q = new THREE.Quaternion();
        this.v3 = new THREE.Vector3();
    }

    // two walking lines on each sidewalk, clear of lamp posts and trees (which sit at the kerb)
    sidewalkD(side, lane) { const P = this.road.p; return side * (P.roadHalf + 1.9 + lane * 1.2); }

    _spawn(p, playerS, initial) {
        const r = this.rng;
        p.s = initial ? playerS + r.range(-60, 420) : playerS + r.range(220, 460);
        if (p.s < 6 || p.s > this.road.frontS - 20) { p.s = -1e9; p.root.visible = false; return; }
        const side = r.sign();
        p.d = this.sidewalkD(side, r.int(0, 1));
        p.dir = r.sign();
        p.speed = r.range(1.1, 1.6);
        p.state = r.chance(0.12) ? IDLE : WALK;
        p.timer = r.range(2, 8);
        p.root.visible = true;
        p.root.rotation.set(0, 0, 0);
        p.model.position.y = p.baseY;
        p.hitBy = null; p.settled = false; p.fleeCool = 0;
        this._anim(p, p.state === IDLE ? 'Idle' : 'Walk', true);
    }

    reset(playerS) { for (const p of this.peds) this._spawn(p, playerS, true); }

    _anim(p, name, instant = false) {
        if (p.anim === name && !instant) return;
        p.anim = name;
        p.fade = instant ? 0 : 0.25;
        p.fadeT = 0;
    }

    // Obstacles for traffic: pedestrians on the carriageway
    obstacles(out) {
        if (!this.enabled) return out;
        const half = this.road.p.roadHalf;
        for (const p of this.peds) if (p.state !== DOWN && p.root.visible && Math.abs(p.d) < half + 0.5) out.push({ s: p.s, d: p.d, v: 0, ped: true });
        return out;
    }

    // cars: [{veh, s, isPlayer, tag}] dynamic cars that can hit people
    update(dt, playerS, camPos, cars, traffic) {
        this.events.length = 0;
        if (!this.enabled) return this.events;
        const road = this.road, P = road.p, r = this.rng;
        for (const p of this.peds) {
            if (p.state !== DOWN && (p.s < playerS - 150 || p.s > playerS + 520)) { this._spawn(p, playerS, false); continue; }
            if (p.state === DOWN && (p.s < playerS - 200 || p.downT > 45)) { this._spawn(p, playerS, false); continue; }
            if (!p.root.visible) continue;

            if (p.state !== DOWN) this._think(dt, p, cars, traffic);
            else this._tumble(dt, p);

            // collisions with dynamic cars
            if (p.state !== DOWN) {
                for (const c of cars) {
                    if (Math.abs(c.s - p.s) > 6) continue;
                    const v = c.veh;
                    const dx = p.x - v.x, dy = p.y - v.y;
                    const cs = Math.cos(v.th), sn = Math.sin(v.th);
                    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
                    if (Math.abs(lx) > v.P.halfLength + 0.3 || Math.abs(ly) > v.P.halfWidth + 0.3) continue;
                    const speed = Math.hypot(v.vx, v.vy);
                    if (speed > 2) this._knock(p, v, speed, c);
                    else {
                        // shove gently out of the way
                        const push = ly >= 0 ? 1 : -1;
                        p.d += push * 0.05;
                    }
                    break;
                }
            }
            this._pose(dt, p, camPos);
        }
        return this.events;
    }

    _think(dt, p, cars, traffic) {
        const road = this.road, P = road.p, r = this.rng;
        p.timer -= dt;
        // get out of the way of a car coming straight at us
        p.fleeCool -= dt;
        if (p.state !== FLEE && p.fleeCool <= 0) {
            for (const c of cars) {
                const v = c.veh;
                const speed = Math.hypot(v.vx, v.vy);
                if (speed < 4 || Math.abs(c.s - p.s) > 25) continue;
                const dx = p.x - v.x, dy = p.y - v.y;
                const along = (dx * v.vx + dy * v.vy) / speed;
                const lateral = (-dx * v.vy + dy * v.vx) / speed;    // + = to the car's left
                if (along > 2 && along < 4 + speed * 0.3 && Math.abs(lateral) < 2.2) {
                    p.fleeCool = 4;
                    if (this.rng.chance(0.5)) break;          // frozen in panic
                    // step to whichever side is farther from the car's line, never past the building line
                    const onWalk = Math.abs(p.d) > P.roadHalf;
                    const loc = this.road.nearest(v.x, v.y, {});
                    const carD = loc ? loc.d : 0;
                    if (onWalk) {
                        const side = Math.sign(p.d);
                        const inner = side * (P.roadHalf + 1.0), outer = side * (P.sidewalkOuter - 0.6);
                        p.fleeTo = Math.abs(inner - carD) > Math.abs(outer - carD) ? inner : outer;
                    } else {
                        p.fleeTo = (carD > p.d ? -1 : 1) * this.sidewalkD(1, 0);   // run for the far kerb
                    }
                    p.state = FLEE; p.timer = 2.5; p.fleeCool = 4;
                    break;
                }
            }
        }
        switch (p.state) {
            case WALK: {
                p.s += p.dir * p.speed * dt;
                this._anim(p, 'Walk');
                // decide to cross: at crosswalks often, elsewhere rarely (jaywalking)
                const it = road.inIntersection(p.s, 4);
                if (p.timer <= 0) {
                    p.timer = r.range(4, 12);
                    if (r.chance(0.08)) { p.state = IDLE; p.timer = r.range(2, 6); }
                    else if (r.chance(it ? 0.6 : 0.12)) { p.state = WAIT; p.timer = r.range(0.5, 1.5); p.crossTo = -Math.sign(p.d) * Math.abs(p.d); p.jay = !it && r.chance(0.5); }
                }
                break;
            }
            case IDLE:
                this._anim(p, 'Idle');
                if (p.timer <= 0) { p.state = WALK; p.timer = r.range(4, 10); if (r.chance(0.4)) p.dir *= -1; }
                break;
            case WAIT: {
                this._anim(p, 'Idle');
                // look for a gap in traffic (jaywalkers are less careful)
                let clear = true;
                for (const c of traffic.cars) {
                    const ds = (p.s - c.s) * c.lane.dir;
                    if (ds > -4 && ds < (p.jay ? 18 : 45) && c.v > 1) { clear = false; break; }
                }
                if (clear && p.timer <= 0) { p.state = CROSS; }
                if (p.timer < -12) { p.state = WALK; p.timer = 5; }
                break;
            }
            case CROSS: {
                const dirD = Math.sign(p.crossTo - p.d);
                p.d += dirD * p.speed * 1.15 * dt;
                this._anim(p, 'Walk');
                if (Math.sign(p.crossTo - p.d) !== dirD) { p.d = p.crossTo; p.state = WALK; p.timer = r.range(5, 12); }
                break;
            }
            case FLEE: {
                const dir = Math.sign(p.fleeTo - p.d);
                p.fleeDir = dir || 1;
                p.d += dir * 3.0 * dt;
                this._anim(p, 'Run');
                if (Math.sign(p.fleeTo - p.d) !== dir || p.timer <= 0) {
                    p.d = p.fleeTo;
                    // catch breath, then carry on along the sidewalk
                    p.state = Math.abs(p.d) > P.roadHalf ? IDLE : CROSS;
                    p.crossTo = Math.sign(p.d || 1) * Math.abs(this.sidewalkD(1, 0));
                    p.timer = 1.5;
                }
                break;
            }
        }
    }

    _knock(p, v, speed, c) {
        p.state = DOWN;
        p.downT = 0;
        p.hitBy = c.tag;
        p.settled = false;
        // limp pose, and pivot the body around the hips while tumbling
        for (const [name, a] of Object.entries(p.actions)) a.setEffectiveWeight(name === 'Idle' ? 1 : 0);
        p.mixer.update(0);
        const f = road3(this.road, p);
        p.model.position.y = p.baseY - 0.95;
        p.x3 = f.x; p.y3 = f.y + 0.95; p.z3 = f.z;
        // velocity in three space (map (x,y) -> (x, -y))
        p.vx = v.vx * 0.9 + (Math.random() - 0.5) * 2;
        p.vz = -v.vy * 0.9 + (Math.random() - 0.5) * 2;
        p.vy = 2.5 + speed * 0.22;
        p.spin = 6 + speed * 0.4;
        p.spinAxis.set(-p.vz, 0, p.vx).normalize();
        if (!isFinite(p.spinAxis.x)) p.spinAxis.set(1, 0, 0);
        this.events.push({ type: 'pedHit', by: c.tag, speed, isPlayer: c.isPlayer });
    }

    _tumble(dt, p) {
        p.downT += dt;
        if (!p.settled) {
            const ground = this._groundAt(p.x3, p.z3);
            p.vy -= 18 * dt;
            p.x3 += p.vx * dt; p.y3 += p.vy * dt; p.z3 += p.vz * dt;
            p.root.quaternion.premultiply(this.q.setFromAxisAngle(p.spinAxis, p.spin * dt));
            if (p.y3 <= ground + 0.35) {
                p.y3 = ground + 0.35;
                if (Math.abs(p.vy) > 3) { p.vy *= -0.3; p.vx *= 0.5; p.vz *= 0.5; p.spin *= 0.5; }
                else {
                    // came to rest: lying flat, no longer moving
                    p.settled = true;
                    const yaw = Math.atan2(p.vx, p.vz) + (Math.random() - 0.5);
                    p.root.rotation.set(Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1), yaw, 0, 'YXZ');
                    p.y3 = ground + 0.14;
                }
            }
            p.x = p.x3; p.y = -p.z3;
            const loc = this.road.nearest(p.x, p.y, {});
            if (loc) { p.s = loc.s; p.d = loc.d; }
        }
        p.root.position.set(p.x3, p.y3, p.z3);
    }

    _groundAt(x, z) {
        const loc = this.road.nearest(x, -z, {});
        if (!loc) return 0;
        return this.road.heightAt(loc.s, Math.max(-this.road.p.sidewalkOuter, Math.min(this.road.p.sidewalkOuter, loc.d)));
    }

    _pose(dt, p, camPos) {
        if (p.state !== DOWN) {
            const f = road3(this.road, p);
            p.x = f.mx; p.y = f.my;
            p.root.position.set(f.x, f.y, f.z);
            let heading;
            if (p.state === CROSS || p.state === FLEE) {
                const sgn = p.state === CROSS ? Math.sign(p.crossTo - p.d) : p.fleeDir;
                heading = f.th + Math.PI / 2 * (sgn || 1);
            } else heading = f.th + (p.dir < 0 ? Math.PI : 0);
            // model faces +Z: three yaw so that +Z points along 2D heading
            const yaw = heading + Math.PI / 2;
            let dy = yaw - p.heading; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
            p.heading += dy * Math.min(1, dt * 8);
            p.root.rotation.set(0, p.heading, 0);
        }
        // animation blending (skip far away people)
        const dist = camPos.distanceTo(p.root.position);
        if (dist < 140 && p.state !== DOWN) {
            if (p.fade !== undefined) {
                p.fadeT += dt;
                const t = p.fade > 0 ? Math.min(1, p.fadeT / p.fade) : 1;
                for (const [name, a] of Object.entries(p.actions)) {
                    const w = a.getEffectiveWeight();
                    a.setEffectiveWeight(name === p.anim ? w + (1 - w) * t : w * (1 - t));
                }
                if (t >= 1) p.fade = undefined;
            }
            const rate = p.anim === 'Walk' ? p.speed / 1.35 : 1;
            p.actions.Walk.timeScale = rate;
            p.mixer.update(dt * (dist > 60 ? 1 : 1));
        }
    }

    // replay support
    capture(buf, o) {
        for (const p of this.peds) {
            const r = p.root;
            buf[o++] = r.position.x; buf[o++] = r.position.y; buf[o++] = r.position.z;
            buf[o++] = r.quaternion.x; buf[o++] = r.quaternion.y; buf[o++] = r.quaternion.z; buf[o++] = r.quaternion.w;
            buf[o++] = r.visible ? 1 : 0;
            buf[o++] = ['Idle', 'Walk', 'Run'].indexOf(p.anim); buf[o++] = p.actions.Walk.time;
        }
        return o;
    }
    get captureSize() { return this.peds.length * 10; }
    apply(a, b, t, o, dt) {
        for (const p of this.peds) {
            const r = p.root;
            r.position.set(a[o] + (b[o] - a[o]) * t, a[o + 1] + (b[o + 1] - a[o + 1]) * t, a[o + 2] + (b[o + 2] - a[o + 2]) * t);
            r.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
            r.visible = a[o + 7] > 0.5;
            const anim = ['Idle', 'Walk', 'Run'][a[o + 8]] || 'Walk';
            for (const [name, act] of Object.entries(p.actions)) act.setEffectiveWeight(name === anim ? 1 : 0);
            p.mixer.update(dt);
            o += 10;
        }
        return o;
    }

    dispose() { for (const p of this.peds) this.scene.remove(p.root); this.peds = []; }
}

// world position of a pedestrian standing at (s, d)
function road3(road, p) {
    const f = road.pointAt(p.s, p.d, _pt);
    const h = road.heightAt(p.s, p.d);
    return { x: f.px, y: h, z: -f.py, th: f.th, mx: f.px, my: f.py };
}
const _pt = {};
