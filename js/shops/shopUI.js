// Shop menus: a simple panel listing items, prices, the player's money and a
// Buy button. Purchases go through the Game (money, weapons, health, outfits,
// vehicles), all prices come from CONFIG.shops / CONFIG.vehicles.
import { CONFIG } from '../config.js';
import { SPECIAL_NAMES } from '../world/materials.js';

const S = CONFIG.shops;
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Math.round(n).toLocaleString();

export class ShopUI {
    constructor(game) {
        this.game = game;
        this.open = false;
        this.type = null;
        this.tab = 'buy';
        $('shop-close').onclick = () => this.close();
    }

    show(type) {
        const g = this.game;
        this.open = true; this.type = type; this.tab = 'buy';
        g.wantsCursor = true;
        g.input.exitLock();
        $('shop').classList.add('active');
        this.render();
    }

    close() {
        if (!this.open) return;
        this.open = false;
        const g = this.game;
        g.wantsCursor = false;
        $('shop').classList.remove('active');
        g.input.requestLock();
        g.snapshot();
    }

    msg(text, bad = false) {
        const m = $('shop-msg');
        m.textContent = text; m.className = bad ? 'bad' : 'ok';
    }

    // Try to pay; returns true on success.
    pay(price) {
        const g = this.game;
        if (g.money < price) { this.msg('Not enough money.', true); g.audio.click(); return false; }
        g.money -= price;
        g.audio.cash();
        return true;
    }

    render() {
        const g = this.game, type = this.type;
        $('shop-title').textContent = SPECIAL_NAMES[type];
        $('shop-money').textContent = money(g.money);
        const list = $('shop-list');
        list.innerHTML = '';
        $('shop-tabs').innerHTML = '';
        const row = (name, desc, price, label, onBuy, { disabled = false, swatch = null, owned = false } = {}) => {
            const r = document.createElement('div');
            r.className = 'shop-row' + (owned ? ' owned' : '');
            r.innerHTML = `${swatch ? `<i class="sw" style="background:${swatch}"></i>` : ''}<div class="nm"><b>${name}</b><small>${desc || ''}</small></div><div class="pr">${price == null ? '' : price === 0 ? 'FREE' : money(price)}</div>`;
            const b = document.createElement('button');
            b.textContent = label;
            b.disabled = disabled;
            b.onclick = () => { onBuy(); this.render(); };
            r.appendChild(b);
            list.appendChild(r);
        };
        const W = CONFIG.weapons, wp = g.weapons;
        if (type === 'gun') {
            for (const [id, s] of Object.entries(S.guns)) {
                const d = W[id];
                if (!wp.owned(id)) {
                    row(d.name, `Dmg ${d.damage * (d.pellets || 1)} · ${d.fireRate}/s · clip ${d.clip} · reload ${d.reload}s`, s.price, 'Buy',
                        () => { if (this.pay(s.price)) { wp.give(id, s.ammoPack * 2); wp.equip(id); this.msg(`Bought ${d.name}.`); } });
                } else {
                    const st = wp.inv[id];
                    row(`${d.name} ammo`, `+${s.ammoPack} rounds (have ${st.clip + st.reserve}/${d.maxAmmo + d.clip})`, s.ammoPrice, 'Buy ammo',
                        () => { if (wp.ammoFull(id)) { this.msg('Ammo full.', true); return; } if (this.pay(s.ammoPrice)) { wp.addAmmo(id, s.ammoPack); this.msg(`+${s.ammoPack} ${d.name} rounds.`); } },
                        { disabled: wp.ammoFull(id) });
                }
            }
        } else if (type === 'clothes') {
            const owned = g.save.ownedOutfits;
            const cur = g.save.outfitId || 'default';
            for (const o of S.outfits) {
                const have = owned.includes(o.id);
                row(o.name, 'Character outfit', have ? null : o.price, cur === o.id ? 'Wearing' : have ? 'Wear' : 'Buy', () => {
                    if (!have && !this.pay(o.price)) return;
                    if (!have) owned.push(o.id);
                    g.setOutfit(o);
                    this.msg(`Now wearing ${o.name}.`);
                }, { disabled: cur === o.id, swatch: o.top || o.tint, owned: have });
            }
        } else if (type === 'convenience' || type === 'cafe') {
            for (const it of S[type]) {
                const full = (it.health && g.player.health >= g.player.maxHealth) && !it.armour || (it.armour && g.player.armour >= 100);
                row(it.name, it.desc, it.price, 'Buy', () => {
                    if (full) return;
                    if (!this.pay(it.price)) return;
                    if (it.health) g.player.heal(it.health);
                    if (it.armour) g.player.armour = Math.min(100, g.player.armour + it.armour);
                    this.msg(`${it.name}: ${it.desc}.`);
                }, { disabled: full });
            }
            const p = g.player;
            this.msg(`Health ${Math.round(p.health)} / 100 · Armour ${Math.round(p.armour)} / 100`);
        } else if (type === 'dealership') {
            const tabs = $('shop-tabs');
            for (const [t, label] of [['buy', 'Buy vehicles'], ['garage', `My garage (${g.save.ownedCars.length})`]]) {
                const b = document.createElement('button');
                b.textContent = label; b.className = this.tab === t ? 'on' : '';
                b.onclick = () => { this.tab = t; this.render(); };
                tabs.appendChild(b);
            }
            if (this.tab === 'buy') {
                for (const id of S.dealership) {
                    const v = CONFIG.vehicles[id];
                    const desc = v.rare ? 'Rare model' : `${v.hp ? v.hp + ' hp · ' : ''}${v.mass ? v.mass + ' kg' : ''}`;
                    row(v.name, desc, v.price, 'Buy', () => {
                        if (g.save.ownedCars.length >= S.garageSlots) { this.msg('Your garage is full.', true); return; }
                        if (!this.pay(v.price)) return;
                        g.save.ownedCars.push({ model: id, color: null });
                        this.msg(`${v.name} delivered to your garage. Take it out from the Garage tab.`);
                    });
                }
            } else {
                if (!g.save.ownedCars.length) this.msg('No vehicles yet. Buy one first.');
                g.save.ownedCars.forEach((c, i) => {
                    const v = CONFIG.vehicles[c.model];
                    row(v.name, 'Stored in your garage', null, 'Take out', () => {
                        g.deliverOwnedCar(i);
                        this.msg(`${v.name} is parked outside.`);
                    });
                });
                if (g.personalCar && g.personalCar.alive && g.vehicles.includes(g.personalCar)) {
                    row('Store current car', g.personalCar.info.name, null, 'Store', () => { g.storePersonalCar(); this.msg('Stored.'); });
                }
            }
        }
        $('shop-money').textContent = money(g.money);
    }
}
