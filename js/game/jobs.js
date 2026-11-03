// Ways to earn money (besides cash dropped by pedestrians):
//  - Hidden packages: CONFIG.economy.packages glowing packages spread across
//    the island (pavements, beaches, countryside, mountain tops). Each pays
//    packageReward once; collected ones are saved.
//  - Courier jobs: stand on the yellow marker beside any 24/7 store and press
//    E. Deliver the parcel to the destination before the timer runs out.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Rng } from '../core/rng.js';
import { SPECIAL_NAMES } from '../world/materials.js';

const E = CONFIG.economy;

function marker(color) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const c = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.4, 24, 1, true), m);
    c.position.y = 0.7;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.2, 32), m);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
    g.add(c, ring);
    return g;
}

export class Jobs {
    constructor(game) {
        this.game = game;
        this.packages = this._placePackages();
        this.live = new Map();          // package id -> pickup item
        this.job = null;
        // job boards beside every 24/7 store
        this.boards = game.map.doors('convenience').map(d => ({
            x: d.x + d.ny * 4, y: d.y - d.nx * 4, door: d, mesh: null,
        }));
        this.destMarker = marker(0xffd24a);
        this.destMarker.visible = false;
        game.scene.add(this.destMarker);
    }

    _placePackages() {
        const map = this.game.map, rng = new Rng(map.seed ^ 0xabcdef);
        const out = [];
        let tries = 0;
        while (out.length < E.packages && tries++ < 5000) {
            let x, y;
            if (out.length % 2 === 0) {
                // on a random block's pavement corner
                const b = map.blocks[rng.int(0, map.blocks.length - 1)];
                x = rng.chance(0.5) ? b.x0 + 1 : b.x1 - 1; y = rng.chance(0.5) ? b.y0 + 1 : b.y1 - 1;
            } else {
                x = rng.range(-map.half + 400, map.half - 400); y = rng.range(-map.half + 400, map.half - 400);
                const s = map.surfaceAt(x, y);
                if (s.water > 0 || s.h < 0.8) continue;
                map.collidersNear(x, y, 3);
                if (map.collidersNear(x, y, 3).boxes.some(b => x > b.x0 - 1 && x < b.x1 + 1 && y > b.y0 - 1 && y < b.y1 + 1)) continue;
            }
            if (out.some(p => Math.hypot(p.x - x, p.y - y) < 250)) continue;
            out.push({ id: out.length, x, y });
        }
        return out;
    }

    get found() { return this.game.save.collected.length; }

    // radar blips for nearby packages, job boards and the job target
    blips() {
        const g = this.game, pos = g.player.position, out = [];
        for (const p of this.packages) {
            if (g.save.collected.includes(p.id)) continue;
            if (Math.hypot(p.x - pos.x, p.y - pos.y) < E.packageRadarRange) out.push({ x: p.x, y: p.y, dot: true, color: '#ffd24a', size: 3 });
        }
        for (const b of this.boards) out.push({ x: b.x, y: b.y, icon: 'J', color: '#ffd24a' });
        if (this.job) out.push({ x: this.job.x, y: this.job.y, icon: '⬤', color: '#ffd24a', edge: true });
        return out;
    }

    prompt() {
        const p = this.game.player;
        if (p.vehicle || this.job) return null;
        for (const b of this.boards) if (Math.hypot(b.x - p.x, b.y - p.y) < 1.8) return '<kbd>E</kbd> Start courier job';
        return null;
    }

    update(dt) {
        const g = this.game, pos = g.player.position, input = g.input;
        // stream package pickups near the player
        for (const p of this.packages) {
            const d = Math.hypot(p.x - pos.x, p.y - pos.y);
            const have = this.live.get(p.id);
            if (!have && d < 250 && !g.save.collected.includes(p.id)) {
                this.live.set(p.id, g.pickups.add('package', p.x, p.y, E.packageReward, { life: Infinity, onCollect: () => this._collectPackage(p) }));
            } else if (have && d > 320) { g.pickups.remove(have); this.live.delete(p.id); }
        }
        // job boards: show markers near the player
        for (const b of this.boards) {
            const near = Math.hypot(b.x - pos.x, b.y - pos.y) < 300 && !this.job;
            if (near && !b.mesh) {
                b.mesh = marker(0xffd24a);
                b.mesh.position.set(b.x, g.map.surfaceAt(b.x, b.y).h, -b.y);
                g.scene.add(b.mesh);
            }
            if (b.mesh) b.mesh.visible = near;
        }
        if (!this.job && !g.player.vehicle && input.actHit('interact')) {
            const b = this.boards.find(bb => Math.hypot(bb.x - pos.x, bb.y - pos.y) < 1.8);
            if (b) this._startJob(b);
        }
        if (this.job) {
            const j = this.job;
            j.time -= dt;
            const d = Math.hypot(j.x - pos.x, j.y - pos.y);
            g.hud.mission(`DELIVER TO <b>${j.name}</b> · ${Math.round(d)} m · <span class="${j.time < 15 ? 'low' : ''}">${Math.max(0, j.time).toFixed(0)}s</span>`);
            this.destMarker.rotation.y += dt;
            if (d < 5) this._finishJob();
            else if (j.time <= 0 || g.player.dead) this._failJob(g.player.dead ? 'You died. The parcel is lost.' : 'Too late! The client cancelled the delivery.');
        }
    }

    _collectPackage(p) {
        const g = this.game;
        g.save.collected.push(p.id);
        this.live.delete(p.id);
        g.money += E.packageReward;
        g.audio.cash();
        g.hud.notify(`Hidden package <b>${this.found} / ${this.packages.length}</b> found. <b>+$${E.packageReward}</b>`, 4);
        g.snapshot();
        return true;
    }

    _startJob(board) {
        const g = this.game, map = g.map, rng = Math.random;
        // destination: another shop door or a random kerb at the right distance
        const cands = map.doors().filter(d => {
            const dist = Math.hypot(d.x - board.x, d.y - board.y);
            return dist > E.jobDistance[0] && dist < E.jobDistance[1];
        });
        let dest;
        if (cands.length) { const d = cands[Math.floor(rng() * cands.length)]; dest = { x: d.x + d.nx * 3, y: d.y + d.ny * 3, name: SPECIAL_NAMES[d.type] }; }
        else { const r = map.nearestRoad(board.x + 900, board.y); dest = { x: r.x, y: r.y, name: 'the drop-off' }; }
        const dist = Math.hypot(dest.x - board.x, dest.y - board.y);
        this.job = { ...dest, dist, time: dist / 11 + 40, start: performance.now() };
        this.destMarker.position.set(dest.x, map.surfaceAt(dest.x, dest.y).h, -dest.y);
        this.destMarker.visible = true;
        g.hud.notify(`Courier job: take the parcel to <b>${dest.name}</b> (${Math.round(dist)} m). Follow the yellow blip on the radar.`, 6);
        g.audio.pickup();
    }

    _finishJob() {
        const g = this.game, j = this.job, P = E.jobPay;
        const pay = Math.round(P.base + j.dist * P.perMetre + Math.max(0, j.time) * P.timeBonus);
        g.money += pay;
        g.save.stats.jobs++;
        g.audio.cash();
        g.hud.big('DELIVERED', `+$${pay}`, 'good');
        setTimeout(() => g.hud.big(''), 2500);
        this._endJob();
        g.snapshot();
    }

    _failJob(msg) { this.game.hud.notify(msg, 4); this._endJob(); }

    _endJob() {
        this.job = null;
        this.destMarker.visible = false;
        this.game.hud.mission('');
    }

    dispose() {
        this.game.scene.remove(this.destMarker);
        for (const b of this.boards) if (b.mesh) this.game.scene.remove(b.mesh);
    }
}
