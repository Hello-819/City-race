// Persistent progress (localStorage): money, clock, position, outfit,
// weapons & ammo, owned vehicles, collected packages.
import { CONFIG } from '../config.js';

const KEY = 'cityrace.openworld.save';

export function defaultSave() {
    return {
        version: 1,
        money: CONFIG.player.startMoney,
        hour: CONFIG.time.startHour,
        pos: null,                 // {x, y, yaw}
        health: 100, armour: 0,
        outfit: null,
        ownedOutfits: ['default'],
        weapons: null,             // filled by the weapon system
        ownedCars: [],             // [{model, color}]
        collected: [],             // collectible ids
        stats: { kills: 0, deaths: 0, jobs: 0 },
    };
}

export function loadSave() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        return Object.assign(defaultSave(), JSON.parse(raw));
    } catch { return null; }
}

export function writeSave(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch { return false; }
}

export function deleteSave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
