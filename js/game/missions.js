// ============================================================================
// Story missions. Each mission is a list of steps; the next mission's contact
// stands on a pavement marked with a yellow "M" (radar + marker). Walk into the
// marker and press E to start. The GPS guides you to every objective.
//
// Step types:
//   goto        reach a point (optionally in a vehicle)
//   stealCar    a specific car is parked somewhere: get in it
//   deliverCar  bring that car (or any rare car) to a point and stop
//   rareCar     get into any rare car (glowing marker cars in traffic)
//   kill        armed gang members appear at a location: take them all out
//   evade       you get a wanted level: lose it
//   checkpoints drive through a series of checkpoints before time runs out
// ============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

function marker(color, radius = 1.2) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const c = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1.6, 24, 1, true), m);
    c.position.y = 0.8;
    g.add(c);
    return g;
}

// Mission definitions (positions are map metres; steps run in order)
const MISSIONS = [
    {
        id: 'wheels', name: 'Wheels for Rico', giver: [40, -100], reward: 1500,
        brief: 'Rico needs a <b>Strada GT</b> for a client. One is parked across town: steal it and bring it to his lock-up.',
        steps: [
            { type: 'stealCar', model: 'coupe', at: [620, -360], text: 'Steal the <b>Strada GT</b>' },
            { type: 'deliverCar', at: [1460, -230], r: 8, text: 'Deliver the car to <b>Rico\'s lock-up</b>' },
        ],
    },
    {
        id: 'sweep', name: 'Clean Sweep', giver: [-260, 380], reward: 2500,
        brief: 'A gang has taken over a farm south-east of the city. Drive out there and <b>take them all out</b>.',
        steps: [
            { type: 'goto', at: [2160, -1700], r: 120, text: 'Get to the <b>farm</b>' },
            { type: 'kill', at: [2160, -1700], count: 5, text: 'Kill the <b>gang members</b>' },
        ],
    },
    {
        id: 'heat', name: 'Heat Check', giver: [140, -620], reward: 2000,
        brief: 'Someone wants to know how good you are at losing the cops. <b>Get a 2-star wanted level and shake it.</b>',
        steps: [
            { type: 'evade', stars: 2, text: 'Lose the <b>police</b>' },
        ],
    },
    {
        id: 'mountain', name: 'Mountain Run', giver: [-500, -260], reward: 3500,
        brief: 'A time trial up the Granite Ridge pass. Bring your own car. <b>Hit every checkpoint</b> before the clock runs out.',
        steps: [
            { type: 'goto', at: 'mountainStart', r: 14, vehicle: true, text: 'Drive to the <b>start line</b> at the foot of the mountain' },
            { type: 'checkpoints', count: 8, time: 210, text: 'Checkpoint' },
        ],
    },
    {
        id: 'collector', name: 'The Collector', giver: [720, 460], reward: 6000,
        brief: 'A collector pays big for rare cars. <b>Find one</b> (they glow in traffic) and deliver it to any car dealership.',
        steps: [
            { type: 'rareCar', text: 'Find and get into a <b>rare car</b>' },
            { type: 'deliverCar', at: 'dealership', r: 10, text: 'Deliver it to a <b>car dealership</b>' },
        ],
    },
];

export class Missions {
    constructor(game) {
        this.game = game;
        game.save.missionsDone = game.save.missionsDone || [];
        this.active = null;      // { def, step, data }
        this.target = null;      // GPS target {x, y}
        this.markers = [];
        this.giverMarker = marker(0xffd24a, 1.4);
        game.scene.add(this.giverMarker);
        // put every contact on the nearest pavement
        for (const m of MISSIONS) {
            const r = game.map.nearestRoad(m.giver[0], m.giver[1], 200);
            const off = r.edge.half + 2;
            const side = Math.sign(game.map._project(r.edge, m.giver[0], m.giver[1]).d) || 1;
            m.giverPos = game.map.edgePoint(r.edge, r.s, off * side, {});
        }
    }

    get next() { return MISSIONS.find(m => !this.game.save.missionsDone.includes(m.id)) || null; }

    blips() {
        const out = [];
        if (!this.active && this.next) out.push({ x: this.next.giverPos.x, y: this.next.giverPos.y, icon: 'M', color: '#ffd24a', edge: true });
        if (this.target) out.push({ x: this.target.x, y: this.target.y, icon: '◆', color: '#ffd24a', edge: true });
        if (this.active && this.active.data.hostiles) for (const p of this.active.data.hostiles) if (!p.dead) out.push({ x: p.x, y: p.y, dot: true, color: '#ff3b30', size: 4 });
        return out;
    }

    prompt() {
        const n = this.next, p = this.game.player;
        if (this.active || !n || p.vehicle) return null;
        if (Math.hypot(n.giverPos.x - p.x, n.giverPos.y - p.y) < 2) return `<kbd>E</kbd> Start mission: ${n.name}`;
        return null;
    }

    update(dt) {
        const g = this.game, p = g.player;
        const n = this.next;
        // contact marker
        this.giverMarker.visible = !this.active && !!n;
        if (n && !this.active) {
            this.giverMarker.position.set(n.giverPos.x, g.map.surfaceAt(n.giverPos.x, n.giverPos.y).h, -n.giverPos.y);
            if (!p.vehicle && Math.hypot(n.giverPos.x - p.x, n.giverPos.y - p.y) < 2 && g.input.actHit('interact') && !g.jobs.job) this.start(n);
        }
        if (!this.active) return;
        const a = this.active, st = a.def.steps[a.step];
        if (p.dead) return this.fail('You died.');
        const pos = p.position;
        if (a.timer !== undefined) { a.timer -= dt; if (a.timer <= 0) return this.fail('Out of time.'); }
        const tStr = a.timer !== undefined ? ` · <span class="${a.timer < 20 ? 'low' : ''}">${Math.ceil(a.timer)}s</span>` : '';
        switch (st.type) {
            case 'goto': {
                const d = Math.hypot(this.target.x - pos.x, this.target.y - pos.y);
                g.hud.mission(`${st.text} · ${Math.round(d)} m${tStr}`);
                if (d < st.r && (!st.vehicle || p.vehicle)) this.advance();
                break;
            }
            case 'stealCar': {
                if (!a.data.car.alive) return this.fail('The car was destroyed.');
                g.hud.mission(st.text + tStr);
                if (p.vehicle === a.data.car) this.advance();
                break;
            }
            case 'rareCar':
                g.hud.mission(st.text);
                if (p.vehicle && p.vehicle.info.rare && p.vehicle.alive) { a.data.car = p.vehicle; this.advance(); }
                break;
            case 'deliverCar': {
                const car = a.data.car;
                if (!car.alive) return this.fail('The car was destroyed.');
                const dest = a.data.dest, inCar = p.vehicle === car;
                const d = Math.hypot(dest.x - car.x, dest.y - car.y);
                g.hud.mission(inCar ? `${st.text} · ${Math.round(d)} m` : 'Get back in the <b>car</b>');
                // GPS: to the car when you're out of it, else to the drop-off
                this.target = inCar ? dest : { x: car.x, y: car.y };
                if (inCar && d < st.r && car.veh.speed < 3) { p.exit(); this.advance(); }
                break;
            }
            case 'kill': {
                const left = a.data.hostiles.filter(h => !h.dead).length;
                g.hud.mission(`${st.text} · ${left} left`);
                if (left === 0) this.advance();
                break;
            }
            case 'evade':
                g.hud.mission(g.police.stars > 0 ? st.text : 'Done!');
                if (g.police.stars === 0) this.advance();
                break;
            case 'checkpoints': {
                const cp = a.data.cps[a.data.i];
                const d = Math.hypot(cp.x - pos.x, cp.y - pos.y);
                g.hud.mission(`${st.text} ${a.data.i + 1} / ${a.data.cps.length} · ${Math.round(d)} m${tStr}`);
                if (d < 12) {
                    g.audio.blip(880, 0.12, 'square', 0.12);
                    a.data.i++;
                    if (a.data.i >= a.data.cps.length) { a.timer = undefined; this.advance(); }
                    else this._setTarget(a.data.cps[a.data.i]);
                }
                break;
            }
        }
        for (const m of this.markers) m.rotation.y += dt;
    }

    start(def) {
        const g = this.game;
        this.active = { def, step: -1, data: {} };
        g.hud.notify(`<b>${def.name}</b><br>${def.brief}`, 7);
        g.audio.pickup();
        this.advance();
    }

    // Set up the next step (or pass the mission).
    advance() {
        const g = this.game, a = this.active;
        a.step++;
        this._clearMarkers();
        a.timer = undefined;
        const st = a.def.steps[a.step];
        if (!st) return this.pass();
        const at = this._resolve(st.at);
        switch (st.type) {
            case 'goto': this._setTarget(at); break;
            case 'stealCar': {
                const r = g.map.nearestRoad(at.x, at.y, 200);
                const p = g.map.edgePoint(r.edge, r.s, r.edge.half + 1.3, {});
                const t = g.map.tangent(r.edge, r.s);
                a.data.car = g.spawnParked(st.model, p.x, p.y, Math.atan2(t.y, t.x), '#ff6a00');
                a.data.car.ambient = false;
                this._setTarget(p, false);
                break;
            }
            case 'rareCar': this.target = null; break;
            case 'deliverCar': a.data.dest = at; this._setTarget(at); break;
            case 'kill': {
                a.data.hostiles = [];
                for (let i = 0; i < st.count; i++) {
                    const ang = i / st.count * Math.PI * 2;
                    const h = g.peds.spawnHostile(at.x + Math.cos(ang) * 14, at.y + Math.sin(ang) * 14);
                    if (h) a.data.hostiles.push(h);
                }
                this.target = { x: at.x, y: at.y };
                break;
            }
            case 'evade': g.police.setStars(st.stars); this.target = null; break;
            case 'checkpoints': {
                const e = g.map.mountainRoad.edge;
                a.data.cps = [];
                for (let i = 1; i <= st.count; i++) a.data.cps.push(g.map.edgePoint(e, e.len * i / (st.count + 0.3), 0, {}));
                a.data.i = 0;
                a.timer = st.time;
                this._setTarget(a.data.cps[0]);
                break;
            }
        }
        if (a.step > 0) g.audio.blip(660, 0.15, 'square', 0.12);
    }

    _resolve(at) {
        const g = this.game;
        if (at === 'mountainStart') { const e = g.map.mountainRoad.edge; return g.map.edgePoint(e, 25, 0, {}); }
        if (at === 'dealership') {
            const p = g.player.position;
            let best = null, bd = Infinity;
            for (const d of g.map.doors('dealership')) { const dd = Math.hypot(d.x - p.x, d.y - p.y); if (dd < bd) { bd = dd; best = d; } }
            return { x: best.x + best.nx * 10, y: best.y + best.ny * 10 };
        }
        return at ? { x: at[0], y: at[1] } : null;
    }

    _setTarget(p, withMarker = true) {
        const g = this.game;
        this.target = { x: p.x, y: p.y };
        g.gpsT = 0;
        if (withMarker) {
            const m = marker(0xffd24a, 3);
            m.position.set(p.x, g.map.surfaceAt(p.x, p.y, {}, 9999).h, -p.y);
            g.scene.add(m);
            this.markers.push(m);
        }
    }

    _clearMarkers() { for (const m of this.markers) this.game.scene.remove(m); this.markers = []; }

    pass() {
        const g = this.game, def = this.active.def;
        g.money += def.reward;
        g.save.missionsDone.push(def.id);
        g.audio.cash();
        g.hud.big('MISSION PASSED', `${def.name} · +$${def.reward.toLocaleString()}`, 'good');
        setTimeout(() => g.hud.big(''), 3500);
        this._end();
        g.snapshot();
        const n = this.next;
        if (n) setTimeout(() => g.hud.notify(`New mission available: <b>${n.name}</b> (yellow M on the map).`, 5), 3800);
    }

    fail(why) {
        const g = this.game;
        g.hud.big('MISSION FAILED', why);
        setTimeout(() => { if (!this.active) g.hud.big(''); }, 3000);
        this._end();
    }

    _end() {
        const a = this.active;
        if (a && a.data.hostiles) for (const h of a.data.hostiles) h.hostile = false;
        this.active = null;
        this.target = null;
        this._clearMarkers();
        this.game.hud.mission('');
    }

    dispose() { this._clearMarkers(); this.game.scene.remove(this.giverMarker); }
}

export { CONFIG };
