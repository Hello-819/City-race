// Ghost car: records the player's run and replays the best one on the same track.
import * as THREE from 'three';
import { createCar } from './assets.js';

const RATE = 10;   // samples per second
const STRIDE = 5;  // t, x, y, z, yaw

export class GhostRecorder {
    constructor() { this.data = []; this.next = 0; }
    record(t, root) {
        if (t < this.next) return;
        this.next = t + 1 / RATE;
        const e = new THREE.Euler().setFromQuaternion(root.quaternion, 'YXZ');
        this.data.push(+t.toFixed(2), +root.position.x.toFixed(2), +root.position.y.toFixed(2), +root.position.z.toFixed(2), +e.y.toFixed(3));
    }
}

export const ghostStore = {
    key: (kind, seed, mode) => `cityrace.ghost.${kind}.${seed}.${mode}`,
    load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    save(key, ghost) {
        try {
            localStorage.setItem(key, JSON.stringify(ghost));
            // keep only the 6 most recent ghosts
            const idx = JSON.parse(localStorage.getItem('cityrace.ghosts') || '[]').filter(k => k !== key);
            idx.push(key);
            while (idx.length > 6) localStorage.removeItem(idx.shift());
            localStorage.setItem('cityrace.ghosts', JSON.stringify(idx));
        } catch { /* storage full or blocked: ghosts are optional */ }
    },
};

export class GhostCar {
    constructor(scene, ghost) {
        this.ghost = ghost;
        this.rig = createCar(ghost.car, { lod: true, color: '#7fd4ff' });
        const mat = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.28, depthWrite: false });
        this.rig.root.traverse((o) => { if (o.isMesh) { o.material = o === this.rig.shadow ? o.material : mat; o.castShadow = false; } });
        this.rig.shadow.visible = false;
        this.rig.root.rotation.order = 'YXZ';
        this.scene = scene;
        scene.add(this.rig.root);
        this.i = 0;
    }

    update(t) {
        const d = this.ghost.data, n = d.length / STRIDE;
        if (n < 2) return;
        while (this.i < n - 2 && d[(this.i + 1) * STRIDE] <= t) this.i++;
        while (this.i > 0 && d[this.i * STRIDE] > t) this.i--;
        const a = this.i * STRIDE, b = Math.min(n - 1, this.i + 1) * STRIDE;
        const ta = d[a], tb = d[b];
        const k = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
        const r = this.rig.root;
        r.visible = t <= d[(n - 1) * STRIDE];
        r.position.set(d[a + 1] + (d[b + 1] - d[a + 1]) * k, d[a + 2] + (d[b + 2] - d[a + 2]) * k, d[a + 3] + (d[b + 3] - d[a + 3]) * k);
        let dy = d[b + 4] - d[a + 4]; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        r.rotation.set(0, d[a + 4] + dy * k, 0);
    }

    dispose() { this.scene.remove(this.rig.root); }
}
