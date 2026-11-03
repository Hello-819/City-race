// HUD: radar, health / armour, money, wanted stars, weapon + ammo, clock,
// speedometer, crosshair, hit markers, context prompts, notifications,
// zone names, big messages ("WASTED") and screen fades.
import { MapView } from './mapView.js';

const $ = (id) => document.getElementById(id);

export class Hud {
    constructor(map) {
        this.mapView = new MapView(map);
        this.radar = $('radar');
        this.rctx = this.radar.getContext('2d');
        this.full = $('fullmap');
        this.fctx = this.full.getContext('2d');
        this.cache = {};
        this.units = 'kmh';
        this.notifyTimer = 0;
        this.zoneTimer = 0;
        this.hitTimer = 0;
        this.lastZone = '';
    }

    text(id, v) { if (this.cache[id] !== v) { this.cache[id] = v; $(id).textContent = v; } }
    html(id, v) { if (this.cache[id] !== v) { this.cache[id] = v; $(id).innerHTML = v; } }
    show(on) { $('hud').classList.toggle('active', on); }

    // GTA-style help box in the top-left
    notify(msg, secs = 4) {
        const n = $('notify');
        n.innerHTML = msg;
        n.classList.add('show');
        this.notifyTimer = secs;
    }

    // centre-bottom one-line hint ("Press F to enter")
    prompt(msg) { this.html('prompt', msg || ''); $('prompt').classList.toggle('show', !!msg); }

    mission(html) { this.html('mission', html || ''); document.getElementById('mission').classList.toggle('show', !!html); }

    zone(name) {
        if (name === this.lastZone) return;
        this.lastZone = name;
        const z = $('zone-name');
        z.textContent = name;
        z.classList.remove('show'); void z.offsetWidth; z.classList.add('show');
    }

    big(text, sub = '', cls = '') {
        const b = $('bigmsg');
        b.className = text ? 'show ' + cls : '';
        b.innerHTML = text ? `<div>${text}</div><small>${sub}</small>` : '';
    }

    fade(alpha, ms = 400) {
        const f = $('fade');
        f.style.transition = `opacity ${ms}ms`;
        f.style.opacity = alpha;
    }

    hitMarker(kill = false) {
        const h = $('hitmarker');
        h.classList.toggle('kill', kill);
        h.classList.remove('show'); void h.offsetWidth; h.classList.add('show');
    }

    // state: { player, vehicle, clock, money, wanted, weapon, heading, blips, aiming, spread }
    update(dt, st) {
        if (this.notifyTimer > 0) { this.notifyTimer -= dt; if (this.notifyTimer <= 0) $('notify').classList.remove('show'); }
        const p = st.player;
        this.text('hud-clock', st.clock);
        this.text('hud-money', '$' + Math.floor(st.money).toLocaleString());
        $('bar-health').style.width = (p.health / p.maxHealth * 100).toFixed(1) + '%';
        $('bar-armour').style.width = (p.armour / p.maxArmour * 100).toFixed(1) + '%';
        $('bar-health').classList.toggle('low', p.health < 30);
        // wanted stars
        const w = st.wanted || { stars: 0, flash: false };
        const key = w.stars + (w.flash ? 'f' : '');
        if (this.cache.stars !== key) {
            this.cache.stars = key;
            let s = '';
            for (let i = 1; i <= 5; i++) s += `<span class="${i <= w.stars ? 'on' : ''}">★</span>`;
            const el = $('hud-wanted');
            el.innerHTML = s;
            el.classList.toggle('flash', !!w.flash);
            el.classList.toggle('active', w.stars > 0);
        }
        // weapon / ammo
        if (st.weapon) {
            this.text('hud-weapon', st.weapon.name);
            this.text('hud-ammo', st.weapon.melee ? '' : `${st.weapon.clip} / ${st.weapon.reserve}`);
            $('hud-weapon-box').classList.toggle('reloading', !!st.weapon.reloading);
        }
        // vehicle speedo
        const v = st.vehicle;
        $('speedo').classList.toggle('show', !!v);
        if (v) {
            const sp = Math.abs(v.veh.forwardSpeed);
            this.text('speedo-val', String(Math.round(this.units === 'kmh' ? sp * 3.6 : sp * 2.237)));
            this.text('speedo-unit', this.units === 'kmh' ? 'km/h' : 'mph');
            this.text('speedo-name', v.info.name || '');
            $('veh-health').style.width = Math.max(0, v.health / v.maxHealth * 100).toFixed(0) + '%';
        }
        // crosshair
        const ch = $('crosshair');
        ch.className = st.crosshair ? 'show ' + st.crosshair : '';
        if (st.crosshair) ch.style.setProperty('--spread', (6 + (st.spread || 0) * 120).toFixed(1) + 'px');
        // radar
        const pos = p.position;
        this.mapView.drawRadar(this.rctx, this.radar.width, this.radar.height, pos.x, pos.y, st.heading, st.blips || []);
    }

    drawFullMap(st) {
        const c = this.full;
        if (c.width !== window.innerWidth || c.height !== window.innerHeight) { c.width = window.innerWidth; c.height = window.innerHeight; }
        const pos = st.player.position;
        this.mapView.drawFull(this.fctx, c.width, c.height, pos.x, pos.y, st.heading, st.blips || []);
    }
}
