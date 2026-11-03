// World streaming: keeps the chunks around the focus point loaded at the right
// level of detail, builds new ones within a per-frame time budget (no loading
// screens while exploring) and frees chunks that drift out of range.
// Also owns the always-visible horizon mesh and the ocean plane.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildChunk, buildHorizon, disposeChunk } from './chunkBuilder.js';
import { worldMaterials } from './materials.js';

const S = CONFIG.streaming;
const CHUNK = S.chunkSize;

export class Streamer {
    constructor(scene, map) {
        this.scene = scene;
        this.map = map;
        this.root = new THREE.Group();
        this.root.name = 'world';
        scene.add(this.root);
        this.loaded = new Map();     // key -> { group, lod, cx, cy }
        this.horizon = buildHorizon(map);
        this.horizon.receiveShadow = false;
        scene.add(this.horizon);
        const ocean = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), worldMaterials().ocean);
        ocean.rotation.x = -Math.PI / 2;
        ocean.position.y = CONFIG.map.seaLevel;
        ocean.receiveShadow = false;
        this.ocean = ocean;
        scene.add(ocean);
        this.stats = { near: 0, far: 0, built: 0 };
        this.nearRadius = S.nearRadius;     // set from the graphics preset / adaptive quality
        this.farRadius = S.farRadius;
    }

    _rectDist(cx, cy, x, y) {
        const x0 = cx * CHUNK, y0 = cy * CHUNK;
        const dx = Math.max(x0 - x, 0, x - (x0 + CHUNK)), dy = Math.max(y0 - y, 0, y - (y0 + CHUNK));
        return Math.hypot(dx, dy);
    }

    // Load/unload around (x, y). `budgetMs` limits building time this frame;
    // pass Infinity to build everything synchronously (initial load).
    update(x, y, budgetMs = S.buildBudgetMs) {
        const map = this.map;
        const R = Math.ceil(this.farRadius / CHUNK) + 1;
        const fcx = Math.floor(x / CHUNK), fcy = Math.floor(y / CHUNK);
        const B = map.bounds;
        const want = [];
        const keep = new Set();
        for (let cx = fcx - R; cx <= fcx + R; cx++) for (let cy = fcy - R; cy <= fcy + R; cy++) {
            if (cx * CHUNK < B.x0 - 600 || cx * CHUNK > B.x1 + 600 || cy * CHUNK < B.y0 - 600 || cy * CHUNK > B.y1 + 600) continue;
            const dist = this._rectDist(cx, cy, x, y);
            const key = map.chunkKey(cx, cy);
            const cur = this.loaded.get(key);
            if (dist > this.farRadius + (cur ? 120 : 0)) continue;
            // hysteresis so chunks on the boundary do not flip LOD every frame
            const nearR = this.nearRadius + (cur && cur.lod === 0 ? 60 : 0);
            const lod = dist <= nearR ? 0 : 1;
            keep.add(key);
            if (!cur || cur.lod !== lod) want.push({ key, cx, cy, lod, dist });
        }
        // unload what is out of range
        for (const [key, c] of this.loaded) {
            if (!keep.has(key)) { this.root.remove(c.group); disposeChunk(c.group); this.loaded.delete(key); }
        }
        // build the most important first: near LOD, then by distance
        want.sort((a, b) => (a.lod - b.lod) * 1e6 + a.dist - b.dist);
        const t0 = performance.now();
        let built = 0;
        for (const w of want) {
            if (built > 0 && performance.now() - t0 > budgetMs) break;
            const group = buildChunk(map, w.cx, w.cy, w.lod);
            const old = this.loaded.get(w.key);
            if (old) { this.root.remove(old.group); disposeChunk(old.group); }
            this.root.add(group);
            this.loaded.set(w.key, { group, lod: w.lod, cx: w.cx, cy: w.cy });
            built++;
        }
        this.pending = want.length - built;
        this.stats.built += built;
        this.stats.near = 0; this.stats.far = 0;
        for (const c of this.loaded.values()) c.lod === 0 ? this.stats.near++ : this.stats.far++;
        // ocean follows the camera so it never ends
        this.ocean.position.x = Math.round(x / 200) * 200;
        this.ocean.position.z = -Math.round(y / 200) * 200;
    }

    // Shadows only from near chunks.
    dispose() {
        for (const c of this.loaded.values()) { this.root.remove(c.group); disposeChunk(c.group); }
        this.loaded.clear();
        this.scene.remove(this.root, this.horizon, this.ocean);
    }
}
