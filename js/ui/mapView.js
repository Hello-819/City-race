// Island map rendering for the HUD radar and the full-screen map (M).
// The land / water picture is drawn once at start-up; roads on the radar are
// drawn as vectors every frame so they stay crisp when zoomed in.
import { CONFIG } from '../config.js';

const ICONS = {
    hospital: ['+', '#ff4d4d'], police: ['★', '#4d8cff'], gun: ['⌖', '#e0e0e0'], clothes: ['👕', '#d17cff'],
    dealership: ['🚗', '#3fd4b4'], convenience: ['24', '#ffa040'], cafe: ['☕', '#d0a070'],
};
export const MAP_ICONS = ICONS;

export class MapView {
    constructor(map) {
        this.map = map;
        const N = 1024;
        this.N = N;
        this.size = map.half * 2;
        this.k = N / this.size;            // pixels per metre in the base image
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const ctx = c.getContext('2d');
        const cell = 4, step = this.size / (N / cell);
        for (let j = 0; j < N / cell; j++) for (let i = 0; i < N / cell; i++) {
            const x = -map.half + (i + 0.5) * step, y = map.half - (j + 0.5) * step;
            const h = map.heightAt(x, y);
            let col;
            if (h < CONFIG.map.seaLevel - 0.2) { const d = Math.min(1, -h / 20); col = `rgb(${Math.round(60 - 30 * d)},${Math.round(110 - 40 * d)},${Math.round(150 - 40 * d)})`; }
            else if (h < 2.2) col = '#c9b98a';
            else if (y > CONFIG.map.mountainY && h > 90) { const t = Math.min(1, (h - 90) / 250); col = `rgb(${Math.round(110 + 110 * t)},${Math.round(112 + 108 * t)},${Math.round(100 + 120 * t)})`; }
            else {
                const z = map.zoneAt(x, y);
                col = z === 'city' ? '#6f6c68' : z === 'suburb' ? '#5f7d48' : '#58764a';
            }
            ctx.fillStyle = col;
            ctx.fillRect(i * cell, j * cell, cell, cell);
        }
        // roads
        ctx.lineCap = 'square';
        for (const e of map.edges) {
            const [a, b] = this._ends(e);
            ctx.strokeStyle = e.type === 'highway' ? '#e8c35a' : e.type === 'city' ? '#d8d8d8' : '#b9b9b0';
            ctx.lineWidth = e.type === 'highway' ? 3 : e.type === 'city' ? 2 : 1.4;
            ctx.beginPath();
            ctx.moveTo(...this.toPx(a.x, a.y)); ctx.lineTo(...this.toPx(b.x, b.y));
            ctx.stroke();
        }
        this.image = c;
    }

    _ends(e) { return [this.map.edgePoint(e, 0, 0, {}), this.map.edgePoint(e, e.len, 0, {})]; }
    toPx(x, y) { return [(x + this.map.half) * this.k, (this.map.half - y) * this.k]; }

    // Circular radar. heading: map-frame yaw that points "up" on the radar.
    drawRadar(ctx, W, H, px, py, heading, blips, radius = 260) {
        const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 2;
        const s = R / radius;                       // pixels per metre on the radar
        ctx.save();
        ctx.clearRect(0, 0, W, H);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#2b3b46'; ctx.fillRect(0, 0, W, H);
        ctx.translate(cx, cy);
        ctx.rotate(heading - Math.PI / 2);
        // background land image
        const [ix, iy] = this.toPx(px, py);
        const sc = s / this.k;
        ctx.globalAlpha = 0.85;
        ctx.drawImage(this.image, -ix * sc, -iy * sc, this.N * sc, this.N * sc);
        ctx.globalAlpha = 1;
        // crisp roads
        const seen = new Set();
        for (let gx = px - radius * 1.5; gx <= px + radius * 1.5; gx += 60) for (let gy = py - radius * 1.5; gy <= py + radius * 1.5; gy += 60) {
            for (const id of this.map.edgesNear(gx, gy)) {
                if (seen.has(id)) continue; seen.add(id);
                const e = this.map.edges[id];
                const [a, b] = this._ends(e);
                ctx.strokeStyle = e.type === 'highway' ? '#f0cf6a' : '#dfe3e8';
                ctx.lineWidth = Math.max(1.5, e.half * 2 * s * 0.8);
                ctx.beginPath();
                ctx.moveTo((a.x - px) * s, -(a.y - py) * s);
                ctx.lineTo((b.x - px) * s, -(b.y - py) * s);
                ctx.stroke();
            }
        }
        // blips (clamped to the rim)
        for (const b of blips) {
            let dx = (b.x - px) * s, dy = -(b.y - py) * s;
            const d = Math.hypot(dx, dy);
            if (d > R - 8) { if (!b.edge) continue; dx *= (R - 8) / d; dy *= (R - 8) / d; }
            ctx.save();
            ctx.translate(dx, dy);
            ctx.rotate(-(heading - Math.PI / 2));
            drawBlip(ctx, b);
            ctx.restore();
        }
        ctx.restore();
        // player arrow (always pointing up)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }

    // Full-screen map with legend.
    drawFull(ctx, W, H, px, py, heading, blips) {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1d2c38'; ctx.fillRect(0, 0, W, H);
        const S = Math.min(W, H) * 0.92;
        const ox = (W - S) / 2, oy = (H - S) / 2;
        ctx.drawImage(this.image, ox, oy, S, S);
        const k = S / this.size;
        const P = (x, y) => [ox + (x + this.map.half) * k, oy + (this.map.half - y) * k];
        for (const b of blips) { const [x, y] = P(b.x, b.y); ctx.save(); ctx.translate(x, y); drawBlip(ctx, b, 1.2); ctx.restore(); }
        const [x, y] = P(px, py);
        ctx.save(); ctx.translate(x, y); ctx.rotate(-(heading - Math.PI / 2));
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
        // legend
        ctx.font = '13px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        let ly = oy + 16;
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(ox + 8, oy + 4, 170, 24 + Object.keys(ICONS).length * 20);
        for (const [type, [sym, col]] of Object.entries(ICONS)) {
            ctx.save(); ctx.translate(ox + 22, ly + 6); drawBlip(ctx, { type, icon: sym, color: col }); ctx.restore();
            ctx.fillStyle = '#fff'; ctx.fillText(LABEL[type], ox + 40, ly + 6);
            ly += 20;
        }
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText('M / Esc to close', ox + 14, ly + 10);
    }
}

const LABEL = { hospital: 'Hospital', police: 'Police', gun: 'Gun shop', clothes: 'Clothing', dealership: 'Car dealer', convenience: '24/7 store', cafe: 'Café' };

function drawBlip(ctx, b, scale = 1) {
    const [sym, col] = ICONS[b.type] || [b.icon || '', b.color || '#fff'];
    ctx.scale(scale, scale);
    if (b.dot) {
        ctx.fillStyle = b.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, b.size || 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = b.color || col; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = b.color || col;
    ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(b.icon || sym, 0, 0.5);
}
