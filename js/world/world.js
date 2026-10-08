// Owns the road, the environment builder and the streaming of chunks/tiles.
import * as THREE from 'three';
import { Road, ROAD_PROFILES, DS } from '../road.js';
import { CityBuilder } from './city.js';
import { MountainBuilder, MountainTerrain } from './mountain.js';
import { CHUNK_SAMPLES, makeGantry } from './common.js';

const AHEAD = 900, BEHIND = 220;

export class World {
    constructor(scene, kind, night, seed) {
        this.scene = scene;
        this.kind = kind;
        this.seed = seed;
        this.terrain = kind === 'mountain' ? new MountainTerrain(seed) : null;
        this.road = new Road(ROAD_PROFILES[kind], seed, this.terrain);
        this.road.generateTo(2400);
        this.builder = kind === 'city'
            ? new CityBuilder(this.road, scene, night, seed)
            : new MountainBuilder(this.road, scene, night, seed, this.terrain);
        this.chunks = new Map();
        this.nextChunk = 0;
        this.gantries = new Map();
        const span = kind === 'city' ? this.road.p.sidewalkOuter - 0.5 : this.road.p.guardrail + 0.4;
        this.gantrySpan = span;
        this.start = makeGantry(this.road, 34, 'START', '', '#1f2a36', span);
        scene.add(this.start);
    }

    // Ensure road and geometry exist around arc-length s.
    update(s, pos3, pos2, budgetMs = 8) {
        const road = this.road;
        // keep the road well ahead (and far enough in +y for terrain tiles)
        let target = s + 2200;
        road.generateTo(target);
        if (this.terrain) {
            let guard = 0;
            while (road.sample(road.totalSamples - 1).y < pos2.y + 1150 && guard++ < 400) road.generateTo(road.frontS + 20);
        }
        road.pruneBefore(s - 2600);

        const t0 = performance.now();
        const lastNeeded = Math.floor((s + AHEAD) / (CHUNK_SAMPLES * DS));
        while (this.nextChunk <= lastNeeded) {
            if (performance.now() - t0 > budgetMs && this.chunks.size > 4) break;
            const ci = this.nextChunk++;
            const chunk = this.builder.build(ci);
            this.scene.add(chunk.group);
            chunk.s0 = ci * CHUNK_SAMPLES * DS;
            chunk.s1 = (ci + 1) * CHUNK_SAMPLES * DS;
            this.chunks.set(ci, chunk);
        }
        for (const [ci, chunk] of this.chunks) {
            if (chunk.s1 < s - BEHIND) {
                this.scene.remove(chunk.group);
                chunk.group.traverse((o) => {
                    if (o.isInstancedMesh) o.dispose();
                    if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
                });
                this.chunks.delete(ci);
            }
        }
        // checkpoint gantries
        for (const cp of road.checkpoints) {
            if (cp.s > s + AHEAD || cp.s < s - BEHIND || this.gantries.has(cp.index)) continue;
            const g = makeGantry(road, cp.s, 'CHECKPOINT ' + cp.index, '', '#c0392b', this.gantrySpan);
            this.scene.add(g);
            this.gantries.set(cp.index, g);
        }
        for (const [k, g] of this.gantries) {
            const cp = road.checkpoints.find(c => c.index === k);
            if (!cp || cp.s < s - BEHIND) { this.scene.remove(g); this.gantries.delete(k); }
        }
        this.builder.update(pos3, pos2, Math.max(2, budgetMs - (performance.now() - t0)));
    }

    // static circle colliders near s
    colliders(s) {
        const out = [];
        for (const c of this.chunks.values()) {
            if (c.s1 < s - 30 || c.s0 > s + 30) continue;
            for (const k of c.colliders) out.push(k);
        }
        return out;
    }

    dispose() {
        for (const c of this.chunks.values()) {
            this.scene.remove(c.group);
            c.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
        }
        this.chunks.clear();
        for (const g of this.gantries.values()) this.scene.remove(g);
        this.scene.remove(this.start);
        this.builder.dispose();
    }
}
