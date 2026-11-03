// World pickups: dropped cash, health, armour, ammo and hidden packages.
// Pooled meshes; collected by walking (or driving) through them.
import * as THREE from 'three';

const STYLE = {
    cash: { color: 0x3ad35a, geo: () => new THREE.BoxGeometry(0.35, 0.12, 0.2) },
    health: { color: 0xff3b30, geo: () => new THREE.BoxGeometry(0.4, 0.4, 0.4) },
    armour: { color: 0x3a7bff, geo: () => new THREE.BoxGeometry(0.45, 0.5, 0.15) },
    ammo: { color: 0xe0b030, geo: () => new THREE.BoxGeometry(0.4, 0.25, 0.25) },
    package: { color: 0xffd24a, geo: () => new THREE.OctahedronGeometry(0.45) },
};
const GEO = {};

export class Pickups {
    constructor(game) {
        this.game = game;
        this.items = [];
        this.mats = {};
        for (const [k, s] of Object.entries(STYLE)) {
            GEO[k] = s.geo();
            this.mats[k] = new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.5, roughness: 0.4 });
        }
        this.t = 0;
    }

    // onCollect(item) -> bool (return false to leave it lying there)
    add(type, x, y, amount = 0, { onCollect = null, life = 60, id = null } = {}) {
        const mesh = new THREE.Mesh(GEO[type], this.mats[type]);
        const z = this.game.map.surfaceAt(x, y).h;
        mesh.position.set(x, z + 0.5, -y);
        mesh.castShadow = false;
        this.game.scene.add(mesh);
        const it = { type, x, y, z, amount, mesh, onCollect, life, id };
        this.items.push(it);
        return it;
    }

    remove(it) {
        this.game.scene.remove(it.mesh);
        const i = this.items.indexOf(it);
        if (i >= 0) this.items.splice(i, 1);
    }

    update(dt) {
        this.t += dt;
        const p = this.game.player, pos = p.position;
        const reach = p.vehicle ? 3 : 1.4;
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            it.mesh.rotation.y += dt * 2;
            it.mesh.position.y = it.z + 0.55 + Math.sin(this.t * 3 + i) * 0.12;
            if (it.life !== Infinity) { it.life -= dt; if (it.life <= 0) { this.remove(it); continue; } }
            if (p.dead || Math.abs(it.x - pos.x) > reach || Math.abs(it.y - pos.y) > reach) continue;
            if (it.onCollect && it.onCollect(it) === false) continue;
            if (!it.onCollect) this.game.collect(it);
            this.remove(it);
        }
    }

    dispose() { for (const it of this.items) this.game.scene.remove(it.mesh); this.items.length = 0; }
}
