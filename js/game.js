// Game rules: time attack with checkpoints, or free roam; scoring with
// near misses, drifting, speed and a combo multiplier.
import { clamp } from './core/rng.js';

export class GameRules {
    constructor(mode, kind) {
        this.mode = mode;
        this.kind = kind;
        this.timeLeft = kind === 'city' ? 75 : 70;
        this.elapsed = 0;
        this.score = 0;
        this.combo = 1;
        this.comboTimer = 0;
        this.distance = 0;
        this.topSpeed = 0;
        this.nearMisses = 0;
        this.crashes = 0;
        this.checkpointsHit = 0;
        this.driftPts = 0;
        this.driftActive = 0;
        this.nextCheckpointS = null;
        this.over = false;
        this.endReason = null;   // 'time' | 'finish' | 'busted'
        this.lastS = null;
        this.finishS = kind === 'city' ? 5000 : 4500;
        this.finished = false;
        this.finishTime = 0;
        this.pedsHit = 0;
    }

    end(reason) { if (!this.over) { this.over = true; this.endReason = reason; } }

    bump(amount) {
        this.combo = clamp(this.combo + amount, 1, 5);
        this.comboTimer = 4;
    }

    // returns list of {text, cls} popups
    update(dt, player, road, events, impacts, hud, audio) {
        const out = [];
        if (this.over) return out;
        this.elapsed += dt;
        const v = player.veh;
        const speed = Math.abs(v.forwardSpeed);
        this.topSpeed = Math.max(this.topSpeed, speed);
        if (this.lastS == null) this.lastS = player.s;
        const ds = player.s - this.lastS;
        if (ds > 0 && ds < 100) { this.distance += ds; this.score += ds * 0.5 * this.combo; }
        this.lastS = Math.max(this.lastS, player.s);

        // speed bonus
        if (speed > 45) this.score += (speed - 45) * dt * 4 * this.combo;

        // drift scoring
        const slip = Math.abs(v.slipRear);
        if (slip > 0.16 && speed > 12 && v.forwardSpeed > 0) {
            this.driftActive += dt;
            this.driftPts += slip * speed * dt * 12;
        } else if (this.driftActive > 0) {
            if (this.driftActive > 0.8 && this.driftPts > 40) {
                const pts = Math.round(this.driftPts * this.combo);
                this.score += pts;
                out.push({ text: 'DRIFT +' + pts, cls: 'drift' });
                this.bump(0.25);
            }
            this.driftActive = 0; this.driftPts = 0;
        }

        for (const e of events) {
            if (e.type === 'nearmiss') {
                this.nearMisses++;
                const pts = Math.round((150 + e.closeness * 250 + e.relSpeed * 5) * (e.oncoming ? 1.6 : 1) * this.combo);
                this.score += pts;
                out.push({ text: (e.oncoming ? 'ONCOMING NEAR MISS +' : 'NEAR MISS +') + pts, cls: 'near' });
                this.bump(e.oncoming ? 0.5 : 0.3);
                audio.blip(1320, 0.08, 'triangle', 0.12);
            } else if (e.type === 'crash') {
                this.crashes++;
                if (this.combo > 1) out.push({ text: 'COMBO LOST', cls: 'bad' });
                this.combo = 1; this.comboTimer = 0;
                if (this.mode === 'timeattack') { this.timeLeft -= 2; out.push({ text: 'CRASH  -2s', cls: 'bad' }); }
            }
        }
        for (const hit of impacts) {
            if (hit > 7 && this.combo > 1) { out.push({ text: 'COMBO LOST', cls: 'bad' }); this.combo = 1; }
        }

        if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) this.combo = 1; }

        // checkpoints
        const next = this.mode === 'sprint' ? null : road.checkpoints.find(c => c.index === this.checkpointsHit + 1);
        this.nextCheckpointS = next ? next.s : null;
        if (next && player.s >= next.s) {
            this.checkpointsHit++;
            const bonus = Math.max(22, 40 - this.checkpointsHit * 2);
            if (this.mode === 'timeattack') { this.timeLeft += bonus; out.push({ text: 'CHECKPOINT  +' + bonus + 's', cls: 'cp' }); }
            else out.push({ text: 'CHECKPOINT ' + this.checkpointsHit, cls: 'cp' });
            this.score += 1000 * this.checkpointsHit;
            audio.blip(660, 0.12, 'square', 0.12); setTimeout(() => audio.blip(990, 0.18, 'square', 0.12), 120);
        }

        if (this.mode === 'timeattack') {
            this.timeLeft -= dt;
            if (this.timeLeft <= 0) { this.timeLeft = 0; this.end('time'); }
        }
        if (this.mode === 'sprint' && player.s >= this.finishS && !this.finished) {
            this.finished = true; this.finishTime = this.elapsed;
            this.score += Math.max(0, 20000 - this.elapsed * 60);
            this.end('finish');
        }
        return out;
    }
}
