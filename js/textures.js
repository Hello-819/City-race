// Procedurally painted canvas textures (road markings, facades, signs ...).
import * as THREE from 'three';
import { mulberry32 } from './core/rng.js';

let maxAniso = 8;
export function setMaxAnisotropy(v) { maxAniso = v; }

function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
}

function toTexture(c, { srgb = true, repeat = true, aniso = true } = {}) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (aniso) t.anisotropy = maxAniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
}

function grain(ctx, w, h, rnd, amount, alpha = 0.18, size = 1) {
    for (let i = 0; i < amount; i++) {
        const v = Math.floor(rnd() * 255);
        ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rnd()})`;
        ctx.fillRect(rnd() * w, rnd() * h, size, size);
    }
}

// A lit room seen through a window: brighter ceiling, darker floor, sometimes blinds.
function litWindow(ctx, x, y, w, h, color, rnd) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(60,40,20,0.6)');
    ctx.globalAlpha = 0.35 + rnd() * 0.5;
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    if (rnd() < 0.4) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        for (let yy = y + 2; yy < y + h * (0.3 + rnd() * 0.6); yy += 4) ctx.fillRect(x, yy, w, 2);
    }
    if (rnd() < 0.3) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + w * rnd() * 0.6, y + h * 0.4, w * 0.25, h * 0.6); }
    ctx.globalAlpha = 1;
}

const cache = new Map();
function cached(key, fn) {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
}

// Road surface. u spans the whole asphalt width, v repeats every `period` metres.
// layout: list of {d, type} marking centre positions measured from the left edge (m).
export function roadTexture(kind) {
    return cached('road-' + kind, () => {
        const W = 512, H = 1024;
        const [c, ctx] = canvas(W, H);
        const rnd = mulberry32(kind === 'city' ? 11 : 12);
        const width = kind === 'city' ? 15 : 9.8;       // metres across
        const period = 12;                               // metres along
        const px = W / width, py = H / period;
        ctx.fillStyle = kind === 'city' ? '#3a3b3d' : '#3d3c3a';
        ctx.fillRect(0, 0, W, H);
        // tonal blotches + aggregate grain
        for (let i = 0; i < 260; i++) {
            const v = 45 + rnd() * 25;
            ctx.fillStyle = `rgba(${v},${v},${v + 2},0.12)`;
            const r = 6 + rnd() * 40;
            ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2); ctx.fill();
        }
        grain(ctx, W, H, rnd, 26000, 0.35, 1.5);
        // tyre wear darkening in wheel tracks
        const lanes = kind === 'city' ? [0.5, 4.0, 7.5, 11.0] : [0.5, 4.4];
        const laneW = kind === 'city' ? 3.5 : 3.6;
        const startOffset = kind === 'city' ? 0.5 : 1.3;
        ctx.fillStyle = 'rgba(20,20,22,0.18)';
        for (let l = 0; l < lanes.length; l++) {
            const x0 = (startOffset + l * laneW) * px;
            ctx.fillRect(x0 + 0.6 * px, 0, 0.7 * px, H);
            ctx.fillRect(x0 + 2.2 * px, 0, 0.7 * px, H);
        }
        const line = (dm, wm, color, dash = null) => {
            ctx.fillStyle = color;
            const x = dm * px - (wm * px) / 2;
            if (!dash) { ctx.fillRect(x, 0, wm * px, H); return; }
            const [on, off] = dash;
            for (let y = 0; y < H; y += (on + off) * py) ctx.fillRect(x, y, wm * px, on * py);
        };
        const white = 'rgba(236,236,230,0.92)', yellow = 'rgba(232,180,40,0.95)';
        if (kind === 'city') {
            // [gutter 0.5][lane][lane] || [lane][lane][gutter 0.5]
            line(0.5, 0.15, white);
            line(4.0, 0.13, white, [3, 9]);
            line(7.5 - 0.12, 0.12, yellow);
            line(7.5 + 0.12, 0.12, yellow);
            line(11.0, 0.13, white, [3, 9]);
            line(14.5, 0.15, white);
        } else {
            line(1.3, 0.15, white);
            line(4.9, 0.13, yellow, [4, 8]);
            line(8.5, 0.15, white);
        }
        // light cracks
        ctx.strokeStyle = 'rgba(15,15,15,0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 18; i++) {
            let x = rnd() * W, y = rnd() * H;
            ctx.beginPath(); ctx.moveTo(x, y);
            for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 30; y += rnd() * 25; ctx.lineTo(x, y); }
            ctx.stroke();
        }
        const t = toTexture(c);
        t.wrapS = THREE.ClampToEdgeWrapping;
        return t;
    });
}

export function sidewalkTexture() {
    return cached('sidewalk', () => {
        const S = 256;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(5);
        ctx.fillStyle = '#8f8d88'; ctx.fillRect(0, 0, S, S);
        grain(ctx, S, S, rnd, 9000, 0.25);
        // 4 slabs per texture (texture = 3m)
        ctx.strokeStyle = 'rgba(40,40,40,0.55)'; ctx.lineWidth = 2;
        for (let i = 0; i <= 2; i++) {
            ctx.beginPath(); ctx.moveTo(0, i * S / 2); ctx.lineTo(S, i * S / 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(i * S / 2, 0); ctx.lineTo(i * S / 2, S); ctx.stroke();
        }
        for (let i = 0; i < 4; i++) {
            ctx.fillStyle = `rgba(${90 + rnd() * 40},${90 + rnd() * 30},${80 + rnd() * 30},0.12)`;
            ctx.fillRect((i % 2) * S / 2, Math.floor(i / 2) * S / 2, S / 2, S / 2);
        }
        return toTexture(c);
    });
}

export function concreteTexture() {
    return cached('concrete', () => {
        const S = 512;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(8);
        ctx.fillStyle = '#5d5c59'; ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 400; i++) {
            const v = 70 + rnd() * 40;
            ctx.fillStyle = `rgba(${v},${v},${v},0.08)`;
            ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 10 + rnd() * 50, 0, 7); ctx.fill();
        }
        grain(ctx, S, S, rnd, 30000, 0.25);
        return toTexture(c);
    });
}

// Building facades: colour map + emissive (lit windows at night).
// One texture tile = 8 bays wide x 8 floors high.
export const FACADE_BAYS = 8, FACADE_FLOORS = 8;
export function facadeTextures(style) {
    return cached('facade-' + style, () => {
        const BW = 64, FH = 64;
        const W = BW * FACADE_BAYS, H = FH * FACADE_FLOORS;
        const [c, ctx] = canvas(W, H);
        const [e, ectx] = canvas(W, H);
        const rnd = mulberry32(100 + style.length * 7 + style.charCodeAt(0));
        ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
        const warm = ['#ffd9a0', '#ffe7c2', '#fff1d6', '#cfe3ff', '#ffc98a'];

        if (style === 'glass') {
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, '#5f7f99'); g.addColorStop(1, '#3d566b');
            ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
            for (let f = 0; f < FACADE_FLOORS; f++) {
                for (let b = 0; b < FACADE_BAYS; b++) {
                    const v = rnd() * 30;
                    ctx.fillStyle = `rgba(${150 + v},${190 + v},${215 + v * 0.5},${0.15 + rnd() * 0.2})`;
                    ctx.fillRect(b * BW + 2, f * FH + 4, BW - 4, FH - 10);
                    if (rnd() < 0.26) litWindow(ectx, b * BW + 8, f * FH + 10, BW - 16, FH - 22, warm[Math.floor(rnd() * warm.length)], rnd);
                }
            }
            ctx.fillStyle = '#2b3845';
            for (let f = 0; f <= FACADE_FLOORS; f++) ctx.fillRect(0, f * FH - 3, W, 6);
            for (let b = 0; b <= FACADE_BAYS; b++) ctx.fillRect(b * BW - 2, 0, 4, H);
        } else {
            const base = style === 'brick' ? ['#8a4b3a', '#7a3f30', '#93573f'] :
                style === 'stone' ? ['#b3a58c', '#a89a80', '#c0b49c'] : ['#9a9a96', '#8c8d8a', '#a7a6a0'];
            ctx.fillStyle = base[0]; ctx.fillRect(0, 0, W, H);
            if (style === 'brick') {
                for (let y = 0; y < H; y += 6) {
                    for (let x = (y / 6) % 2 ? -8 : 0; x < W; x += 16) {
                        ctx.fillStyle = base[Math.floor(rnd() * 3)];
                        ctx.fillRect(x, y, 15, 5);
                    }
                }
            } else {
                grain(ctx, W, H, rnd, 20000, 0.25, 2);
                ctx.fillStyle = 'rgba(0,0,0,0.15)';
                for (let f = 0; f < FACADE_FLOORS; f++) ctx.fillRect(0, f * FH + FH - 6, W, 3);
            }
            const ww = style === 'office' ? BW - 14 : BW - 30;
            const wh = style === 'office' ? FH - 24 : FH - 26;
            for (let f = 0; f < FACADE_FLOORS; f++) {
                for (let b = 0; b < FACADE_BAYS; b++) {
                    const x = b * BW + (BW - ww) / 2, y = f * FH + 10;
                    ctx.fillStyle = 'rgba(30,30,30,0.6)';
                    ctx.fillRect(x - 2, y - 2, ww + 4, wh + 4);
                    const v = 40 + rnd() * 50;
                    const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
                    g.addColorStop(0, `rgb(${v + 60},${v + 80},${v + 100})`);
                    g.addColorStop(1, `rgb(${v},${v + 10},${v + 25})`);
                    ctx.fillStyle = g;
                    ctx.fillRect(x, y, ww, wh);
                    ctx.fillStyle = 'rgba(220,220,220,0.5)';
                    ctx.fillRect(x + ww / 2 - 1, y, 2, wh);
                    if (style !== 'office') { ctx.fillStyle = 'rgba(230,225,215,0.8)'; ctx.fillRect(x - 3, y + wh + 2, ww + 6, 3); }
                    if (rnd() < 0.27) litWindow(ectx, x, y, ww, wh, warm[Math.floor(rnd() * warm.length)], rnd);
                }
            }
        }
        const map = toTexture(c);
        const emissive = toTexture(e);
        return { map, emissive };
    });
}

export function roofTexture() {
    return cached('roof', () => {
        const S = 256;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(31);
        ctx.fillStyle = '#4b4a48'; ctx.fillRect(0, 0, S, S);
        grain(ctx, S, S, rnd, 12000, 0.3, 2);
        return toTexture(c);
    });
}

export function chevronTexture() {
    return cached('chevron', () => {
        const [c, ctx] = canvas(256, 256);
        ctx.fillStyle = '#f1c40f'; ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.moveTo(70, 30); ctx.lineTo(150, 128); ctx.lineTo(70, 226); ctx.lineTo(120, 226); ctx.lineTo(200, 128); ctx.lineTo(120, 30);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = 10; ctx.strokeStyle = '#111'; ctx.strokeRect(5, 5, 246, 246);
        return toTexture(c, { repeat: false });
    });
}

export function bannerTexture(text, sub = '', bg = '#c0392b') {
    return cached('banner-' + text + sub + bg, () => {
        const [c, ctx] = canvas(1024, 128);
        ctx.fillStyle = bg; ctx.fillRect(0, 0, 1024, 128);
        ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 1024, 10); ctx.fillRect(0, 118, 1024, 10);
        for (let x = 0; x < 1024; x += 64) {
            ctx.fillStyle = (x / 64) % 2 ? '#111' : '#fff';
            ctx.fillRect(x, 10, 32, 10); ctx.fillRect(x + 32, 108, 32, 10);
            ctx.fillStyle = (x / 64) % 2 ? '#fff' : '#111';
            ctx.fillRect(x + 32, 10, 32, 10); ctx.fillRect(x, 108, 32, 10);
        }
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 72px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, 512, sub ? 58 : 66);
        if (sub) { ctx.font = 'bold 22px "Segoe UI", Arial'; ctx.fillText(sub, 512, 96); }
        return toTexture(c, { repeat: false });
    });
}

export function glowTexture() {
    return cached('glow', () => {
        const [c, ctx] = canvas(128, 128);
        const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.2, 'rgba(255,255,255,0.65)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.15)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
        return toTexture(c, { repeat: false, aniso: false });
    });
}

// Neutral greyscale detail noise, used to break up terrain vertex colours.
export function detailTexture() {
    return cached('detail', () => {
        const S = 256;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(77);
        ctx.fillStyle = '#c8c8c8'; ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 1500; i++) {
            const v = 150 + rnd() * 105;
            ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
            ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 1 + rnd() * 6, 0, 7); ctx.fill();
        }
        grain(ctx, S, S, rnd, 20000, 0.35, 1);
        return toTexture(c);
    });
}

export function gravelTexture() {
    return cached('gravel', () => {
        const S = 256;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(19);
        ctx.fillStyle = '#6e6658'; ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 6000; i++) {
            const v = 60 + rnd() * 90;
            ctx.fillStyle = `rgb(${v + 10},${v + 4},${v - 6})`;
            ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 3, 1 + rnd() * 3);
        }
        return toTexture(c);
    });
}

export function crosswalkTexture() {
    return cached('crosswalk', () => {
        const [c, ctx] = canvas(512, 64);
        ctx.clearRect(0, 0, 512, 64);
        ctx.fillStyle = 'rgba(240,240,235,0.95)';
        for (let x = 8; x < 512; x += 40) ctx.fillRect(x, 0, 22, 64);
        return toTexture(c, { repeat: false });
    });
}

export function neonTexture(text, color) {
    return cached('neon-' + text + color, () => {
        const [c, ctx] = canvas(512, 128);
        ctx.fillStyle = '#0b0b10'; ctx.fillRect(0, 0, 512, 128);
        ctx.font = 'bold 76px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = color; ctx.shadowBlur = 24;
        ctx.fillStyle = color; ctx.fillText(text, 256, 68);
        ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.6; ctx.fillText(text, 256, 68);
        return toTexture(c, { repeat: false });
    });
}

const SHOPS = ['CAFE', 'BAKERY', 'BOOKS', 'PHARMACY', 'DELI', 'FLOWERS', 'SHOES', 'BANK', 'SUSHI', 'PIZZA', 'MARKET', 'TAILOR', 'GYM', 'BARBER', 'NOODLES', 'RECORDS'];
// Ground-floor shops: one texture = 16 m wide x 4.2 m tall, four storefronts.
export function shopTextures() {
    return cached('shops', () => {
        const W = 1024, H = 256;
        const [c, ctx] = canvas(W, H);
        const [e, ectx] = canvas(W, H);
        const rnd = mulberry32(404);
        ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
        const fronts = ['#2c2f36', '#6b2a24', '#24433a', '#3d3550', '#1f3550', '#5a4a2a'];
        for (let i = 0; i < 4; i++) {
            const x0 = i * 256;
            ctx.fillStyle = fronts[Math.floor(rnd() * fronts.length)]; ctx.fillRect(x0, 0, 256, H);
            // sign band
            const sign = SHOPS[Math.floor(rnd() * SHOPS.length)];
            ctx.fillStyle = '#111'; ctx.fillRect(x0 + 10, 14, 236, 44);
            const hue = Math.floor(rnd() * 360);
            ctx.fillStyle = `hsl(${hue},70%,70%)`; ctx.font = 'bold 30px "Segoe UI", Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(sign, x0 + 128, 37);
            ectx.fillStyle = `hsl(${hue},80%,65%)`; ectx.font = ctx.font; ectx.textAlign = 'center'; ectx.textBaseline = 'middle'; ectx.fillText(sign, x0 + 128, 37);
            // window + door
            const g = ctx.createLinearGradient(0, 70, 0, 240);
            g.addColorStop(0, '#9fb6c8'); g.addColorStop(1, '#3c4a57');
            ctx.fillStyle = g; ctx.fillRect(x0 + 14, 72, 160, 170);
            ctx.fillStyle = '#20262c'; ctx.fillRect(x0 + 188, 80, 54, 176);
            ctx.fillStyle = '#7d8f9c'; ctx.fillRect(x0 + 194, 88, 42, 100);
            ctx.strokeStyle = '#ddd'; ctx.lineWidth = 4; ctx.strokeRect(x0 + 14, 72, 160, 170);
            // shop interior glow at night
            const ig = ectx.createLinearGradient(0, 72, 0, 242);
            ig.addColorStop(0, 'rgba(255,225,170,0.95)'); ig.addColorStop(1, 'rgba(160,120,70,0.5)');
            ectx.fillStyle = ig; ectx.fillRect(x0 + 16, 74, 156, 166);
            // goods silhouettes
            for (let k = 0; k < 6; k++) { ctx.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.2})`; ctx.fillRect(x0 + 20 + k * 25, 180 + rnd() * 30, 18, 60); }
        }
        return { map: toTexture(c), emissive: toTexture(e) };
    });
}

// Houses: siding with windows; one texture = 8 m wide x 6 m tall (two floors).
export function houseTextures(variant) {
    return cached('house' + variant, () => {
        const W = 512, H = 384;
        const [c, ctx] = canvas(W, H);
        const [e, ectx] = canvas(W, H);
        const rnd = mulberry32(900 + variant);
        const cols = ['#d8cbb0', '#b9c7cf', '#e6e1d6', '#c9a98a', '#9fb39a', '#d9b8b0'];
        ctx.fillStyle = cols[variant % cols.length]; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 2;
        for (let y = 0; y < H; y += 10) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        ectx.fillStyle = '#000'; ectx.fillRect(0, 0, W, H);
        for (let f = 0; f < 2; f++) for (let b = 0; b < 3; b++) {
            const x = 40 + b * 160, y = 40 + f * 192;
            ctx.fillStyle = '#f4f4f0'; ctx.fillRect(x - 6, y - 6, 92, 122);
            ctx.fillStyle = '#4a5866'; ctx.fillRect(x, y, 80, 110);
            ctx.fillStyle = '#f4f4f0'; ctx.fillRect(x + 38, y, 4, 110); ctx.fillRect(x, y + 53, 80, 4);
            if (rnd() < 0.45) { ectx.fillStyle = '#ffcf8a'; ectx.globalAlpha = 0.8; ectx.fillRect(x, y, 80, 110); ectx.globalAlpha = 1; }
        }
        return { map: toTexture(c), emissive: toTexture(e) };
    });
}

export function grassTexture() {
    return cached('grass', () => {
        const S = 256;
        const [c, ctx] = canvas(S, S);
        const rnd = mulberry32(55);
        ctx.fillStyle = '#4e7a33'; ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 9000; i++) {
            const g = 90 + rnd() * 70;
            ctx.fillStyle = `rgba(${g * 0.5},${g},${g * 0.35},0.5)`;
            ctx.fillRect(rnd() * S, rnd() * S, 1, 2 + rnd() * 3);
        }
        return toTexture(c);
    });
}
