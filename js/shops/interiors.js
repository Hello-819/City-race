// ============================================================================
// Enterable buildings. Walking up to a shop door and pressing E fades to
// black, swaps the rendered scene to a small interior room (its own
// THREE.Scene with its own lights), and puts the player inside. Walking back
// out of the door (or pressing E there) fades back and returns the player to
// the exact spot outside the door.
//
// Each interior provides a "map adapter" with the same API the player and
// camera use outside (surfaceAt / collidersNear / heightAt), so the same
// movement code works indoors.
// ============================================================================
import * as THREE from 'three';
import { createPerson } from '../assets.js';
import { createVehicleRig } from '../vehicles/carModels.js';
import { gunModel } from '../weapons/weapons.js';
import { Rng } from '../core/rng.js';
import { SPECIAL_NAMES } from '../world/materials.js';
import { CONFIG } from '../config.js';

export const ENTERABLE = ['gun', 'clothes', 'dealership', 'convenience', 'cafe', 'hospital'];

// Room sizes (half extents, m) and colours per shop type.
// Three themes per shop type; each shop building picks one from its id, and
// the middle theme also mirrors the layout, so shops of the same kind differ.
const ROOMS = {
    gun: [{ hx: 7, hy: 6, wall: 0x4a4a46, floor: 0x2b2b2b, light: 0xfff0d8 }, { hx: 8, hy: 6.5, wall: 0x3b4a3a, floor: 0x5a4632, light: 0xffe0b0 }, { hx: 9, hy: 7, wall: 0x2a2f38, floor: 0x1e1e1e, light: 0xd8e8ff }],
    clothes: [{ hx: 9, hy: 7, wall: 0xe9e2d8, floor: 0xb08a62, light: 0xfff6ee }, { hx: 10, hy: 7, wall: 0x1d1d22, floor: 0x3a3a40, light: 0xffd6f0 }, { hx: 8, hy: 7.5, wall: 0xd7e8e4, floor: 0xe8e8e8, light: 0xffffff }],
    dealership: [{ hx: 16, hy: 12, wall: 0xf2f2f2, floor: 0xcfd3d6, light: 0xffffff }, { hx: 16, hy: 12, wall: 0x22262c, floor: 0x9aa0a8, light: 0xe8f0ff }, { hx: 18, hy: 12, wall: 0xe8dcc8, floor: 0x7a6a58, light: 0xfff0d8 }],
    convenience: [{ hx: 7, hy: 6, wall: 0xdedede, floor: 0xbfc7c9, light: 0xf2fbff }, { hx: 8, hy: 6, wall: 0xf0e2c0, floor: 0xa89a7a, light: 0xfff4dc }, { hx: 7, hy: 7, wall: 0xcfe0f0, floor: 0x8a9aa8, light: 0xe8f4ff }],
    cafe: [{ hx: 8, hy: 6, wall: 0xc8a27c, floor: 0x6d4a32, light: 0xffe2b8 }, { hx: 9, hy: 6, wall: 0x2e4a3a, floor: 0x8a6a4a, light: 0xffd8a0 }, { hx: 8, hy: 7, wall: 0xf0ece4, floor: 0x2a2a2a, light: 0xfff0e0 }],
    hospital: [{ hx: 10, hy: 8, wall: 0xf4f6f8, floor: 0xd8e0e4, light: 0xf4fbff }, { hx: 10, hy: 8, wall: 0xe2f0ec, floor: 0xc8d4d0, light: 0xffffff }, { hx: 11, hy: 8, wall: 0xf0f0f4, floor: 0xb8c8d8, light: 0xeef6ff }],
};
const H = 4;                 // ceiling height

class RoomMap {
    constructor(hx, hy) {
        this.hx = hx; this.hy = hy;
        this.half = 1e5;
        this.boxes = [];
        const t = 0.5;
        // walls (with a gap in the south wall for the door)
        this.boxes.push({ x0: -hx - t, y0: -hy, x1: -hx, y1: hy, h: H }, { x0: hx, y0: -hy, x1: hx + t, y1: hy, h: H });
        this.boxes.push({ x0: -hx, y0: hy, x1: hx, y1: hy + t, h: H });
        this.boxes.push({ x0: -hx, y0: -hy - t, x1: -1.1, y1: -hy, h: H }, { x0: 1.1, y0: -hy - t, x1: hx, y1: -hy, h: H });
        this.boxes.push({ x0: -1.1, y0: -hy - 3, x1: 1.1, y1: -hy - 2.5, h: H });   // behind the door: you leave before reaching it
    }
    heightAt() { return 0; }
    surfaceAt(x, y, out = {}) { out.h = 0; out.kind = 'floor'; out.water = 0; return out; }
    collidersNear(x, y, r, out = { boxes: [], circles: [] }) { out.boxes = this.boxes; out.circles = EMPTY; return out; }
    zoneAt() { return 'interior'; }
    shoreDist() { return 1e4; }
    roadAt() { return null; }
    blockAt() { return null; }
    inBounds() { return true; }
}
const EMPTY = [];

export class Interiors {
    constructor(game) {
        this.game = game;
        this.current = null;        // { type, door, scene, map, counter, exitPt }
        this.busy = false;
        this.cache = new Map();
    }

    get inside() { return !!this.current; }

    nearDoor() {
        const g = this.game, p = g.player;
        if (p.vehicle) return null;
        for (const b of g.specialBlips) if (Math.abs(b.x - p.x) < 2.6 && Math.abs(b.y - p.y) < 2.6) return b;
        return null;
    }

    prompt(b) {
        if (!ENTERABLE.includes(b.type)) return `${SPECIAL_NAMES[b.type]}`;
        if (this.game.police.stars > 0) return `${SPECIAL_NAMES[b.type]}: closed while you are wanted`;
        return `<kbd>E</kbd> Enter ${SPECIAL_NAMES[b.type]}`;
    }

    // ---------------------------------------------------------- transitions
    enter(blip) {
        const g = this.game;
        if (this.busy || !ENTERABLE.includes(blip.type) || g.police.stars > 0) return;
        const door = g.map.doors(blip.type).find(d => Math.abs(d.x - blip.x) < 0.1 && Math.abs(d.y - blip.y) < 0.1);
        if (!door) return;
        this.busy = true;
        g.hud.fade(1, 350);
        setTimeout(() => {
            const variant = [...door.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7) % 3;
            const room = this._room(blip.type, variant);
            this.current = { ...room, type: blip.type, door, outside: { x: g.player.x, y: g.player.y, yaw: g.player.yaw } };
            this._movePlayer(room.scene, room.map);
            g.player.teleport(0, -room.map.hy + 1.6, Math.PI / 2);
            g.cam.yaw = Math.PI / 2; g.cam.pitch = 0.12;
            g.hud.zone(SPECIAL_NAMES[blip.type]);
            g.hud.fade(0, 350);
            this.busy = false;
        }, 380);
    }

    exit() {
        const g = this.game;
        if (this.busy || !this.current) return;
        this.busy = true;
        g.shopUI.close();
        g.hud.fade(1, 350);
        setTimeout(() => {
            const { door } = this.current;
            this.current = null;
            this._movePlayer(g.scene, g.map);
            // back on the pavement in front of the door, facing the street
            g.player.teleport(door.x + door.nx * 1.4, door.y + door.ny * 1.4, Math.atan2(door.ny, door.nx));
            g.cam.yaw = g.player.yaw; g.cam.pitch = 0.15;
            g.hud.fade(0, 350);
            this.busy = false;
        }, 380);
    }

    _movePlayer(scene, map) {
        const g = this.game, p = g.player;
        p.world = { scene, map, game: g };
        scene.add(p.person.root);
        for (const m of Object.values(g.weapons.models)) scene.add(m);
        g.activeScene = scene;
        g.activeMap = map;
    }

    // Called every frame while inside.
    update() {
        const g = this.game, p = g.player, c = this.current;
        if (!c || this.busy) return;
        // shopkeeper looks at the player
        if (c.keeper) c.keeper.root.rotation.y = Math.atan2(p.x - c.keeper.root.position.x, -p.y - c.keeper.root.position.z);
        if (c.keeper) c.keeper.mixer.update(1 / 60);
        const atCounter = Math.hypot(p.x - c.counter.x, p.y - c.counter.y) < 2.2;
        const atDoor = p.y < -c.map.hy + 0.9 && Math.abs(p.x) < 1.2;
        if (atDoor) { this.exit(); return; }
        if (g.shopUI.open) { g.hud.prompt(''); return; }
        g.hud.prompt(atCounter ? `<kbd>E</kbd> Shop` : `Walk to the counter · leave through the door`);
        if (atCounter && g.input.actHit('interact')) g.shopUI.show(c.type);
    }

    // ---------------------------------------------------------- room build
    _room(type, variant = 0) {
        const key = type + variant;
        if (this.cache.has(key)) return this.cache.get(key);
        const R = ROOMS[type][variant];
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x101010);
        scene.environment = this.game.scene.environment;
        const map = new RoomMap(R.hx, R.hy);
        const std = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, ...o });
        const add = (geo, mat, x, y, z, shadow = true) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, z, -y);
            m.castShadow = shadow; m.receiveShadow = true;
            scene.add(m);
            return m;
        };
        // shell
        const floor = add(new THREE.PlaneGeometry(R.hx * 2, R.hy * 2), std(R.floor, { roughness: 0.4 }), 0, 0, 0, false);
        floor.rotation.x = -Math.PI / 2;
        const ceil = add(new THREE.PlaneGeometry(R.hx * 2, R.hy * 2), std(0xf0f0f0), 0, 0, H, false);
        ceil.rotation.x = Math.PI / 2;
        const wallM = std(R.wall);
        for (const b of map.boxes.slice(0, 5)) {
            add(new THREE.BoxGeometry(b.x1 - b.x0, H, b.y1 - b.y0), wallM, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, H / 2, false);
        }
        // door: bright opening to the street
        const door = add(new THREE.PlaneGeometry(2.2, 2.8), new THREE.MeshBasicMaterial({ color: 0xdfeeff }), 0, -R.hy - 0.3, 1.4, false);
        door.rotation.y = Math.PI;      // face into the room
        // lights
        scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.1));
        for (const x of [-R.hx / 2, R.hx / 2]) for (const y of [-R.hy / 2, R.hy / 2]) {
            const l = new THREE.PointLight(R.light, 30, R.hx * 2.2, 1.6);
            l.position.set(x, H - 0.3, -y);
            scene.add(l);
            add(new THREE.BoxGeometry(1.4, 0.06, 0.4), std(0xffffff, { emissive: R.light, emissiveIntensity: 2 }), x, y, H - 0.05, false);
        }
        // counter at the back + shopkeeper
        const counter = { x: 0, y: R.hy - 3.2 };
        const cw = type === 'dealership' ? 5 : 4.4;
        add(new THREE.BoxGeometry(cw, 1.05, 0.9), std(0x5a3b28), counter.x, counter.y + 1, 0.525);
        map.boxes.push({ x0: -cw / 2, y0: counter.y + 0.55, x1: cw / 2, y1: counter.y + 1.45, h: 1.05 });
        const keeper = createPerson(new Rng(type.length * 31), {});
        keeper.root.position.set(counter.x, 0, -(counter.y + 2.2));
        for (const [n, a] of Object.entries(keeper.actions)) a.setEffectiveWeight(n === 'Idle' ? 1 : 0);
        scene.add(keeper.root);
        const rng = new Rng(77 + type.length);
        // decor per type
        const firstDecor = scene.children.length, firstBox = map.boxes.length;
        if (type === 'hospital') {        // beds with curtains, a waiting bench
            for (let k = 0; k < 4; k++) {
                const x = -R.hx + 2.2 + k * 2.6;
                add(new THREE.BoxGeometry(1.0, 0.55, 2.1), std(0xffffff), x, -1.5, 0.3);
                add(new THREE.BoxGeometry(1.0, 0.12, 0.5), std(0xb8d8f0), x, -0.7, 0.62);
                add(new THREE.BoxGeometry(0.04, 2.2, 2.4), std(0x7fb8c8, { transparent: true, opacity: 0.8 }), x + 1.25, -1.5, 1.1);
                map.boxes.push({ x0: x - 0.55, y0: -2.6, x1: x + 0.55, y1: -0.4, h: 0.6 });
            }
            add(new THREE.BoxGeometry(4, 0.45, 0.6), std(0x3a6a9a), R.hx - 3, -R.hy + 2.2, 0.25);
            map.boxes.push({ x0: R.hx - 5, y0: -R.hy + 1.9, x1: R.hx - 1, y1: -R.hy + 2.5, h: 0.5 });
            add(new THREE.BoxGeometry(1.4, 1.4, 0.05), std(0xffffff, { emissive: 0xff2020, emissiveIntensity: 0.8 }), 0, R.hy - 0.1, 3.0);
        }
        if (type === 'gun') {
            for (const [i, id] of ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'].entries()) {
                const g = gunModel(id);
                g.position.set(-R.hx + 0.3, 1.2 + i * 0.45, -(-2 + i * 0.9));
                g.rotation.y = Math.PI / 2;
                scene.add(g);
            }
            add(new THREE.BoxGeometry(0.2, 2.6, 6), std(0x3a2a1c), -R.hx + 0.1, 0, 1.4);
            for (let i = 0; i < 3; i++) { add(new THREE.BoxGeometry(2.4, 1.0, 0.8), std(0x2c2c2c), R.hx - 2, -3 + i * 2.6, 0.5); map.boxes.push({ x0: R.hx - 3.2, y0: -3.4 + i * 2.6, x1: R.hx - 0.8, y1: -2.6 + i * 2.6, h: 1 }); }
        } else if (type === 'clothes') {
            const cols = CONFIG.shops.outfits.map((o, i) => o.top || o.tint || ['#c0392b', '#2f5d8a', '#3a4a3a', '#d4a017', '#6b2fb3'][i % 5]);
            for (let r = 0; r < 4; r++) {
                const x = -R.hx + 2.5 + r * 3.2;
                add(new THREE.BoxGeometry(2.4, 0.05, 0.05), std(0xaaaaaa, { metalness: 0.8 }), x, -1, 1.6);
                for (let k = 0; k < 6; k++) add(new THREE.BoxGeometry(0.06, 0.9, 0.5), std(cols[(r * 6 + k) % cols.length]), x - 1 + k * 0.4, -1, 1.1);
                map.boxes.push({ x0: x - 1.3, y0: -1.4, x1: x + 1.3, y1: -0.6, h: 1.7 });
            }
            add(new THREE.BoxGeometry(1.2, 2, 0.05), std(0xbfd6e6, { metalness: 0.9, roughness: 0.05 }), R.hx - 0.3, 1, 1.1).rotation.y = Math.PI / 2;
        } else if (type === 'dealership') {
            const show = ['sports', 'classic', 'suv'];
            show.forEach((m, i) => {
                const rig = createVehicleRig(m, ['#ff6a00', '#1f8f8a', '#22355e'][i]);
                rig.root.position.set(-9 + i * 9, 0, -(-2));
                rig.root.rotation.y = 0.5 + i * 0.4;
                scene.add(rig.root);
                map.boxes.push({ x0: -9 + i * 9 - 2.6, y0: -4.6, x1: -9 + i * 9 + 2.6, y1: 0.6, h: 1.4 });
                const plinth = add(new THREE.CylinderGeometry(3.4, 3.4, 0.12, 32), std(0x222428, { roughness: 0.2, metalness: 0.5 }), -9 + i * 9, -2, -0.05, false);
                void plinth;
            });
        } else if (type === 'convenience') {
            for (let r = 0; r < 3; r++) {
                const x = -R.hx + 2.5 + r * 3.3;
                add(new THREE.BoxGeometry(1, 1.8, 6), std(0xe8e8e8), x, -1, 0.9);
                for (let k = 0; k < 18; k++) add(new THREE.BoxGeometry(0.3, 0.3, 0.3), std(new THREE.Color().setHSL(rng.float(), 0.7, 0.5)), x + (k % 2 ? 0.35 : -0.35), -3.6 + (k >> 1) * 0.8, 0.4 + (k % 3) * 0.55);
                map.boxes.push({ x0: x - 0.5, y0: -4, x1: x + 0.5, y1: 2, h: 1.8 });
            }
            add(new THREE.BoxGeometry(1.2, 2, 3), std(0xc9e6f2, { emissive: 0x9fd8ff, emissiveIntensity: 0.4 }), R.hx - 0.7, -1, 1);
            map.boxes.push({ x0: R.hx - 1.3, y0: -2.5, x1: R.hx, y1: 0.5, h: 2 });
        } else if (type === 'cafe') {
            for (let i = 0; i < 4; i++) {
                const x = -4.5 + (i % 2) * 9, y = -2.5 + Math.floor(i / 2) * 3.2;
                add(new THREE.CylinderGeometry(0.6, 0.6, 0.06, 16), std(0xe8dcc8), x, y, 0.78);
                add(new THREE.CylinderGeometry(0.06, 0.06, 0.76, 8), std(0x333333), x, y, 0.38);
                for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.45, 0.5, 0.45), std(0x7a4a2a), x + s * 0.95, y, 0.25);
                map.boxes.push({ x0: x - 1.3, y0: y - 0.7, x1: x + 1.3, y1: y + 0.7, h: 0.8 });
            }
        }
        // variant extras
        if (variant === 2) {
            if (type === 'gun') {          // a short shooting range along the side wall
                for (let i = 0; i < 3; i++) {
                    add(new THREE.BoxGeometry(0.05, 1.6, 0.9), std(0x8a8a8a), -R.hx + 0.4, -R.hy + 2 + i * 1.6, 1.6);
                    add(new THREE.CircleGeometry(0.3, 16), std(0xffffff, { emissive: 0xff2020, emissiveIntensity: 0.3 }), -R.hx + 0.5, -R.hy + 2 + i * 1.6, 1.6).rotation.y = Math.PI / 2;
                }
            } else if (type === 'clothes' || type === 'cafe' || type === 'convenience') {
                for (let i = 0; i < 3; i++) {   // mannequins / plants / displays along the front
                    const x = -R.hx + 2.5 + i * (R.hx - 1.5);
                    add(new THREE.CylinderGeometry(0.25, 0.3, 1.7, 10), std(type === 'cafe' ? 0x2f6a3a : 0xdedede), x, -R.hy + 2.2, 0.85);
                    map.boxes.push({ x0: x - 0.35, y0: -R.hy + 1.85, x1: x + 0.35, y1: -R.hy + 2.55, h: 1.7 });
                }
            } else if (type === 'dealership') {
                const rig = createVehicleRig('prototype', '#8e24aa');
                rig.root.position.set(R.hx - 4, 0, -(R.hy - 5)); rig.root.rotation.y = -0.6;
                scene.add(rig.root);
                map.boxes.push({ x0: R.hx - 6.6, y0: R.hy - 7.6, x1: R.hx - 1.4, y1: R.hy - 2.4, h: 1.4 });
            }
        }
        // the middle theme mirrors everything after the shell left <-> right
        if (variant === 1) {
            for (let i = firstDecor; i < scene.children.length; i++) { const o = scene.children[i]; o.position.x *= -1; o.rotation.y *= -1; }
            for (let i = firstBox; i < map.boxes.length; i++) { const b = map.boxes[i]; [b.x0, b.x1] = [-b.x1, -b.x0]; }
        }
        const room = { scene, map, counter, keeper };
        this.cache.set(key, room);
        return room;
    }
}
