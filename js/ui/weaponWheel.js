// Radial weapon wheel. Hold the wheel key: the game slows down (see
// CONFIG.weapons.wheelTimeScale), mouse movement picks a slice, releasing the
// key equips the highlighted weapon. Locked slices show weapons not owned yet.
import { CONFIG } from '../config.js';

const W = CONFIG.weapons;
const ICON = { unarmed: '✊', pistol: '🔫', smg: 'SMG', shotgun: 'SG', rifle: 'AR', sniper: '🎯' };

export class WeaponWheel {
    constructor() {
        this.el = document.getElementById('wheel');
        this.open = false;
        this.vx = 0; this.vy = 0;
        this.sel = null;
        const ids = W.order;
        const n = ids.length;
        this.slots = ids.map((id, i) => {
            // slot i is centred on angle a (0 = up, clockwise)
            const a = i / n * Math.PI * 2;
            const div = document.createElement('div');
            div.className = 'slot';
            div.style.left = (50 + Math.sin(a) * 34) + '%';
            div.style.top = (50 - Math.cos(a) * 34) + '%';
            div.innerHTML = `<div class="ic">${ICON[id]}</div><div class="nm">${W[id].name}</div><div class="am"></div>`;
            this.el.appendChild(div);
            return { id, a, div };
        });
        this.center = document.createElement('div');
        this.center.className = 'wheel-center';
        this.el.appendChild(this.center);
    }

    show(weapons) {
        this.open = true;
        this.vx = 0; this.vy = 0;
        this.sel = weapons.current;
        this.weapons = weapons;
        this.el.classList.add('active');
        this._render();
    }

    // mouse deltas move a virtual cursor; its angle chooses the slot
    move(dx, dy) {
        this.vx += dx; this.vy += dy;
        const len = Math.hypot(this.vx, this.vy);
        if (len > 120) { this.vx *= 120 / len; this.vy *= 120 / len; }
        if (len > 25) {
            let a = Math.atan2(this.vx, -this.vy); if (a < 0) a += Math.PI * 2;
            const n = this.slots.length;
            const i = Math.round(a / (Math.PI * 2 / n)) % n;
            this.sel = this.slots[i].id;
            this._render();
        }
    }

    // keyboard / scroll alternative while open
    step(dir) {
        const i = this.slots.findIndex(s => s.id === this.sel);
        this.sel = this.slots[(i + dir + this.slots.length) % this.slots.length].id;
        this._render();
    }

    close() {
        this.open = false;
        this.el.classList.remove('active');
        return this.weapons && this.weapons.owned(this.sel) ? this.sel : null;
    }

    _render() {
        const w = this.weapons;
        for (const s of this.slots) {
            const owned = w.owned(s.id), st = w.inv[s.id];
            s.div.classList.toggle('on', s.id === this.sel);
            s.div.classList.toggle('locked', !owned);
            s.div.querySelector('.am').textContent = !owned ? 'LOCKED' : W[s.id].melee ? '' : `${st.clip + st.reserve}`;
        }
        const d = W[this.sel];
        this.center.innerHTML = w.owned(this.sel) && !d.melee
            ? `<b>${d.name}</b><small>DMG ${d.damage * (d.pellets || 1)} · ${d.fireRate}/s · CLIP ${d.clip}</small>`
            : `<b>${d.name}</b>${w.owned(this.sel) ? '' : '<small>Buy at a gun shop</small>'}`;
    }
}
