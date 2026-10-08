// Heads-up display: tachometer + speed, gear, timer, score/combo, minimap, popups.
import { clamp } from './core/rng.js';

export class Hud {
    constructor() {
        this.el = document.getElementById('hud');
        this.gauge = document.getElementById('gauge');
        this.gctx = this.gauge.getContext('2d');
        this.map = document.getElementById('minimap');
        this.mctx = this.map.getContext('2d');
        this.$ = (id) => document.getElementById(id);
        this.popups = this.$('popups');
        this.units = 'kmh';
        this.lastText = {};
    }

    show(v) { this.el.classList.toggle('active', v); }

    text(id, value) {
        if (this.lastText[id] === value) return;
        this.lastText[id] = value;
        this.$(id).textContent = value;
    }

    popup(text, cls = '') {
        const d = document.createElement('div');
        d.className = 'popup ' + cls;
        d.textContent = text;
        this.popups.appendChild(d);
        setTimeout(() => d.remove(), 1700);
    }

    toast(text) {
        const t = this.$('toast');
        t.textContent = text;
        t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    }

    update(state) {
        const { veh, game, road, player, traffic } = state;
        const speed = Math.abs(veh.forwardSpeed);
        const disp = this.units === 'kmh' ? speed * 3.6 : speed * 2.23694;
        this._drawGauge(veh, disp);
        this.text('hud-time', game.mode === 'timeattack' ? game.timeLeft.toFixed(1) : formatTime(game.elapsed));
        this.$('hud-time').classList.toggle('low', game.mode === 'timeattack' && game.timeLeft < 10);
        this.text('hud-time-label', game.mode === 'timeattack' ? 'TIME LEFT' : 'TIME');
        this.text('hud-score', Math.floor(game.score).toLocaleString());
        this.text('hud-combo', game.combo > 1 ? 'x' + game.combo.toFixed(1) : '');
        this.text('hud-dist', (game.distance / 1000).toFixed(2) + ' km');
        const next = game.nextCheckpointS;
        if (game.mode === 'sprint') this.text('hud-next', 'FINISH  ' + Math.max(0, Math.round(game.finishS - player.s)) + ' m');
        else this.text('hud-next', next != null ? 'CHECKPOINT  ' + Math.max(0, Math.round(next - player.s)) + ' m' : '');
        // race position
        const pos = state.position;
        this.$('hud-pos').innerHTML = pos ? `${pos.place}<small>/${pos.total}</small>` : '';
        // wanted level
        const police = state.police;
        const stars = police ? police.stars : 0;
        const key = stars + ':' + (police && police.active.length > 0);
        if (this.lastStars !== key) {
            this.lastStars = key;
            this.$('hud-wanted').innerHTML = stars ? Array.from({ length: 5 }, (_, i) => `<span class="${i < stars ? '' : 'off'}">★</span>`).join('') : '';
            this.$('hud-wanted').classList.toggle('flash', !!police && police.active.length > 0);
        }
        const mb = this.$('hud-meter');
        if (police && stars > 0 && police.bust > 0.02) {
            mb.className = 'meter-box show bust'; this.text('hud-meter-label', 'BUSTED'); this.$('hud-meter-bar').style.width = police.bust * 100 + '%';
        } else if (police && stars > 0) {
            mb.className = 'meter-box show'; this.text('hud-meter-label', police.evade > 0.02 ? 'EVADING' : 'PURSUIT'); this.$('hud-meter-bar').style.width = police.evade * 100 + '%';
        } else mb.className = 'meter-box';
        // car health
        const h = Math.round(state.health ?? 100);
        if (this.lastHealth !== h) {
            this.lastHealth = h;
            this.$('hud-health-bar').style.width = h + '%';
            this.$('hud-health').className = 'health' + (h < 25 ? ' low' : h < 55 ? ' mid' : '');
        }
        this._drawMap(road, player, traffic, state);
    }

    _drawGauge(veh, disp) {
        const c = this.gctx, W = this.gauge.width, H = this.gauge.height;
        const cx = W / 2, cy = H / 2 + 6, R = W * 0.42;
        c.clearRect(0, 0, W, H);
        const P = veh.P;
        const maxRpm = Math.ceil(P.redline / 1000) * 1000 + 1000;
        const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
        const ang = (rpm) => a0 + (a1 - a0) * clamp(rpm / maxRpm, 0, 1);
        // dial
        c.beginPath(); c.arc(cx, cy, R + 14, 0, Math.PI * 2);
        c.fillStyle = 'rgba(8,10,14,0.72)'; c.fill();
        c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.15)'; c.stroke();
        // redline band
        c.beginPath(); c.arc(cx, cy, R, ang(P.redline), a1);
        c.lineWidth = 10; c.strokeStyle = 'rgba(230,40,40,0.85)'; c.stroke();
        // ticks
        c.fillStyle = '#ddd'; c.font = 'bold 15px "Segoe UI", Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
        for (let r = 0; r <= maxRpm; r += 500) {
            const a = ang(r), major = r % 1000 === 0;
            const r0 = R - (major ? 14 : 7);
            c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
            c.lineWidth = major ? 3 : 1.5; c.strokeStyle = r >= P.redline ? '#ff5050' : '#e8e8e8'; c.stroke();
            if (major) c.fillText(String(r / 1000), cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
        }
        // rpm arc fill
        c.beginPath(); c.arc(cx, cy, R + 6, a0, ang(veh.rpm));
        c.lineWidth = 4; c.strokeStyle = veh.rpm > P.redline * 0.95 ? '#ff3b3b' : '#ffb000'; c.stroke();
        // needle
        const a = ang(veh.rpm);
        c.beginPath(); c.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12); c.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6));
        c.lineWidth = 4; c.strokeStyle = '#ff4020'; c.lineCap = 'round'; c.stroke();
        c.beginPath(); c.arc(cx, cy, 8, 0, Math.PI * 2); c.fillStyle = '#222'; c.fill();
        // digital speed + gear
        c.fillStyle = '#fff'; c.font = 'bold 54px "Segoe UI", Arial';
        c.fillText(String(Math.round(disp)), cx, cy + R * 0.42);
        c.font = '600 13px "Segoe UI", Arial'; c.fillStyle = '#aaa';
        c.fillText(this.units === 'kmh' ? 'km/h' : 'mph', cx, cy + R * 0.66);
        c.font = 'bold 28px "Segoe UI", Arial';
        c.fillStyle = veh.limiter ? '#ff4040' : '#ffb000';
        const gear = veh.gear === -1 ? 'R' : (Math.abs(veh.forwardSpeed) < 0.3 && veh.throttle < 0.05 ? 'N' : String(veh.gear));
        c.fillText(gear, cx, cy - R * 0.32);
        c.font = '600 11px "Segoe UI", Arial'; c.fillStyle = '#888';
        c.fillText('x1000 rpm', cx, cy - R * 0.1);
    }

    _drawMap(road, player, traffic, state = {}) {
        const c = this.mctx, W = this.map.width, H = this.map.height;
        c.clearRect(0, 0, W, H);
        c.save();
        c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); c.clip();
        c.fillStyle = 'rgba(8,12,18,0.7)'; c.fillRect(0, 0, W, H);
        const scale = 0.32; // px per metre
        const v = player.veh;
        c.translate(W / 2, H * 0.62);
        c.rotate(v.th - Math.PI / 2);
        const tx = (x, y) => [(x - v.x) * scale, -(y - v.y) * scale];
        c.beginPath();
        let first = true;
        const step = 4;
        for (let s = Math.max(road.backS + 2, player.s - 260); s < Math.min(road.frontS - 2, player.s + 700); s += step * 2) {
            const f = road.frameAt(s);
            const [px, py] = tx(f.x, f.y);
            if (first) { c.moveTo(px, py); first = false; } else c.lineTo(px, py);
        }
        c.lineWidth = road.p.roadHalf * 2 * scale + 4; c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineJoin = 'round'; c.stroke();
        c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.65)'; c.stroke();
        // checkpoints
        for (const cp of road.checkpoints) {
            if (cp.s < player.s - 50 || cp.s > player.s + 700) continue;
            const f = road.frameAt(cp.s);
            const [px, py] = tx(f.x, f.y);
            c.fillStyle = '#ff4d4d'; c.fillRect(px - 4, py - 4, 8, 8);
        }
        for (const t of traffic.cars) {
            if (!t.rig.root.visible || Math.abs(t.s - player.s) > 600) continue;
            const [px, py] = tx(t.x, t.y);
            c.fillStyle = t.lane.dir > 0 ? '#ffd24a' : '#4ac8ff';
            c.beginPath(); c.arc(px, py, 2.6, 0, Math.PI * 2); c.fill();
        }
        const dot = (x, y, col, r = 3) => { const [px, py] = tx(x, y); c.fillStyle = col; c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill(); };
        if (state.racers) for (const u of state.racers.units) dot(u.car.veh.x, u.car.veh.y, '#ff6ad5', 3.5);
        if (state.police) for (const u of state.police.units) if (u.active) dot(u.car.veh.x, u.car.veh.y, Math.sin(performance.now() / 90) > 0 ? '#ff2020' : '#2050ff', 4);
        c.restore();
        // player arrow
        c.save();
        c.translate(W / 2, H * 0.62);
        c.fillStyle = '#ff3b3b';
        c.beginPath(); c.moveTo(0, -8); c.lineTo(6, 6); c.lineTo(0, 3); c.lineTo(-6, 6); c.closePath(); c.fill();
        c.restore();
        c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
        c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.25)'; c.stroke();
    }
}

export function formatTime(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
