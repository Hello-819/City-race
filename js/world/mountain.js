// Mountain environment: heightfield terrain tiles blended into the road (cuts and
// embankments), pine forests, rocks, a lake level, guardrails and curve signs.
import * as THREE from 'three';
import { Rng, Simplex, hashSeed, clamp, lerp, smoothstep } from '../core/rng.js';
import { GeoBuilder, MultiBuilder, ribbon } from '../meshBuilder.js';
import { gravelTexture, chevronTexture, detailTexture } from '../textures.js';
import { roadSurface, roadMaterial, instanced, mergeGeos, M4, CHUNK_SAMPLES } from './common.js';

export const TILE = 128;

export class MountainTerrain {
    constructor(seed) {
        this.n = new Simplex(seed);
        this.n2 = new Simplex(seed + 17);
        this.water = -32;
        this.snow = 165;
    }
    height(x, y) {
        const n = this.n, n2 = this.n2;
        const big = n.fbm(x / 1400, y / 1400, 3) * 95;
        const ridge = n2.ridged(x / 520 + 31.7, y / 520 - 11.3, 4) * 150;
        const detail = n.fbm(x / 70 + 5, y / 70, 2) * 3.5;
        return big + ridge - 55 + detail;
    }
}

export class MountainBuilder {
    constructor(road, scene, night, seed, terrain) {
        this.road = road;
        this.scene = scene;
        this.night = night;
        this.terrain = terrain;
        this.seed = seed;
        this.tiles = new Map();
        this.queue = [];
        this.forest = new Simplex(seed ^ 0x5151);

        const det = detailTexture().clone();
        det.repeat.set(1, 1); det.needsUpdate = true;
        this.mat = {
            road: roadMaterial('mountain'),
            gravel: new THREE.MeshStandardMaterial({ map: gravelTexture(), roughness: 1 }),
            terrain: new THREE.MeshStandardMaterial({ vertexColors: true, map: det, roughness: 0.95, metalness: 0 }),
            rail: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide }),
            post: new THREE.MeshStandardMaterial({ color: 0x6d7075, metalness: 0.6, roughness: 0.5 }),
            trunk: new THREE.MeshStandardMaterial({ color: 0x4b3726, roughness: 1 }),
            pine: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }),
            rock: new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.95, flatShading: true }),
            sign: new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.5, emissive: 0xffffff, emissiveMap: chevronTexture(), emissiveIntensity: night ? 0.25 : 0.05 }),
            signPost: new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.5, roughness: 0.6 }),
            reflector: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff8800, emissiveIntensity: night ? 1.5 : 0.1 }),
        };
        // terrain detail texture repeats every 8 m in world space
        this.mat.terrain.onBeforeCompile = (sh) => {
            sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = (modelMatrix * vec4(position,1.0)).xz / 8.0;\n#endif');
        };

        // pine geometry: trunk + 3 stacked cones
        this.trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 2.4, 6).translate(0, 1.2, 0);
        this.pineGeo = mergeGeos([
            { geo: new THREE.ConeGeometry(2.6, 4.8, 7), matrix: M4(0, 4.0, 0) },
            { geo: new THREE.ConeGeometry(2.0, 4.0, 7), matrix: M4(0, 6.4, 0, 0, 0.4) },
            { geo: new THREE.ConeGeometry(1.3, 3.2, 7), matrix: M4(0, 8.6, 0, 0, 0.9) },
        ]);
        const rock = new THREE.IcosahedronGeometry(1, 0);
        const rp = rock.attributes.position, rr = new Rng(9);
        for (let i = 0; i < rp.count; i++) rp.setXYZ(i, rp.getX(i) * rr.range(0.7, 1.3), rp.getY(i) * rr.range(0.5, 0.9), rp.getZ(i) * rr.range(0.7, 1.3));
        rock.computeVertexNormals();
        this.rockGeo = rock;
        for (const g of [this.trunkGeo, this.pineGeo, this.rockGeo]) g.userData.shared = true;

        // lake surface
        this.water = new THREE.Mesh(
            new THREE.PlaneGeometry(6000, 6000),
            new THREE.MeshStandardMaterial({ color: night ? 0x05101a : 0x1d4a5a, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.88 }),
        );
        this.water.rotation.x = -Math.PI / 2;
        this.water.position.y = terrain.water;
        this.water.receiveShadow = true;
        scene.add(this.water);

        this.ring = this._distantRange();
        scene.add(this.ring);
    }

    _distantRange() {
        const N = 256, R0 = 2300, R1 = 2900;
        const pos = [], col = [], idx = [];
        const n = new Simplex(this.seed + 99);
        const haze = new THREE.Color(this.night ? 0x0b1220 : 0x8fa6bd);
        const dark = new THREE.Color(this.night ? 0x070b14 : 0x4f6274);
        const snow = new THREE.Color(this.night ? 0x1a2236 : 0xe8eef5);
        for (let i = 0; i <= N; i++) {
            const a = i / N * Math.PI * 2;
            const h = 180 + 420 * Math.pow(0.5 + 0.5 * n.fbm(Math.cos(a) * 3, Math.sin(a) * 3, 4), 1.6);
            const ca = Math.cos(a), sa = Math.sin(a);
            pos.push(ca * R0, -60, sa * R0); col.push(haze.r, haze.g, haze.b);
            pos.push(ca * R1, h * 0.75, sa * R1); col.push(dark.r, dark.g, dark.b);
            const top = h > 420 ? snow : dark.clone().lerp(haze, 0.25);
            pos.push(ca * (R1 + 50), h, sa * (R1 + 50)); col.push(top.r, top.g, top.b);
            if (i < N) {
                const b = i * 3;
                idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 4, b + 1, b + 4, b + 2, b + 2, b + 4, b + 5);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
        m.frustumCulled = false;
        m.renderOrder = -5;
        return m;
    }

    update(playerPos, player2D, budgetMs = 6) {
        this.water.position.x = playerPos.x; this.water.position.z = playerPos.z;
        this.ring.position.x = playerPos.x; this.ring.position.z = playerPos.z;
        const R = 950;
        const road = this.road;
        const frontY = road.sample(road.totalSamples - 1).y;
        const ptx = Math.floor(player2D.x / TILE), pty = Math.floor(player2D.y / TILE);
        const span = Math.ceil(R / TILE);
        const want = [];
        for (let ix = ptx - span; ix <= ptx + span; ix++) {
            for (let iy = pty - span; iy <= pty + span; iy++) {
                const cx = (ix + 0.5) * TILE, cy = (iy + 0.5) * TILE;
                const dist = Math.hypot(cx - player2D.x, cy - player2D.y);
                if (dist > R) continue;
                if ((iy + 1) * TILE + 70 > frontY) continue;   // road there not generated yet
                const lod = dist < 260 ? 0 : dist < 560 ? 1 : 2;
                const key = ix + ',' + iy;
                const t = this.tiles.get(key);
                if (!t || t.lod > lod) want.push({ key, ix, iy, lod, dist });
            }
        }
        want.sort((a, b) => a.dist - b.dist);
        const t0 = performance.now();
        for (const w of want) {
            if (performance.now() - t0 > budgetMs) break;
            const old = this.tiles.get(w.key);
            if (old) this._disposeTile(old);
            this.tiles.set(w.key, this._buildTile(w.ix, w.iy, w.lod));
        }
        for (const [key, t] of this.tiles) {
            const cx = (t.ix + 0.5) * TILE, cy = (t.iy + 0.5) * TILE;
            if (Math.hypot(cx - player2D.x, cy - player2D.y) > R + 200) { this._disposeTile(t); this.tiles.delete(key); }
        }
    }

    // Terrain height including the road blend; returns {h, dist}
    groundAt(x, y, near) {
        const T = this.terrain;
        let h = T.height(x, y);
        const n = this.road.nearest(x, y, near);
        if (!n) return { h, dist: Infinity };
        const P = this.road.p;
        const dist = n.dist;
        const flat = P.guardrail + 1.0;
        const bw = 16 + 14 * (0.5 + 0.5 * this.forest.noise(x / 90, y / 90));
        const roadH = n.z - 0.32;
        const t = smoothstep(flat, flat + bw, dist);
        // keep the road deck clear: terrain under / beside the road sits just below it
        h = lerp(roadH, h, t);
        if (dist < flat) h = Math.min(h, roadH);
        return { h, dist };
    }

    _buildTile(ix, iy, lod) {
        const res = [2, 4, 8][lod];
        const N = TILE / res;
        const x0 = ix * TILE, y0 = iy * TILE;
        const G = N + 3;                      // grid with a 1-vertex border for normals
        const H = new Float32Array(G * G), D = new Float32Array(G * G);
        const near = {};
        for (let j = 0; j < G; j++) {
            for (let i = 0; i < G; i++) {
                const x = x0 + (i - 1) * res, y = y0 + (j - 1) * res;
                const g = this.groundAt(x, y, near);
                H[j * G + i] = g.h; D[j * G + i] = g.dist;
            }
        }
        const T = this.terrain;
        const b = new GeoBuilder(true);
        const cGrass = new THREE.Color(0x4d6b2f), cGrass2 = new THREE.Color(0x6b7a3a), cRock = new THREE.Color(0x77726c),
            cRock2 = new THREE.Color(0x5b5651), cSnow = new THREE.Color(0xf2f5f8), cDirt = new THREE.Color(0x6a5a45), cSand = new THREE.Color(0x9c8f72);
        const col = new THREE.Color();
        const normals = [];
        for (let j = 1; j <= N + 1; j++) {
            for (let i = 1; i <= N + 1; i++) {
                const h = H[j * G + i];
                const dx = (H[j * G + i + 1] - H[j * G + i - 1]) / (2 * res);
                const dy = (H[(j + 1) * G + i] - H[(j - 1) * G + i]) / (2 * res);
                // map frame normal (-dx, -dy, 1) -> three (x, z, -y)
                let nx = -dx, ny = 1, nz = dy;
                const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
                const x = x0 + (i - 1) * res, y = y0 + (j - 1) * res;
                const slope = ny;
                const v = 0.5 + 0.5 * this.forest.noise(x / 40, y / 40);
                col.copy(cGrass).lerp(cGrass2, v);
                const rockT = smoothstep(0.86, 0.66, slope);
                col.lerp(v > 0.5 ? cRock : cRock2, rockT);
                if (h > T.snow - 25 * v && slope > 0.55) col.lerp(cSnow, smoothstep(T.snow - 25 * v, T.snow + 20, h));
                if (h < T.water + 2.5) col.lerp(cSand, smoothstep(T.water + 2.5, T.water + 0.5, h));
                const d = D[j * G + i];
                if (d < this.road.p.guardrail + 4) col.lerp(cDirt, 0.65 * smoothstep(this.road.p.guardrail + 4, this.road.p.guardrail, d));
                b.vertex(x, h, -y, 0, 0, nx, ny, nz, col.r, col.g, col.b);
            }
        }
        const W = N + 1;
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const a = j * W + i, bb = a + 1, c = a + W, d = c + 1;
                // map frame CCW -> faces up
                b.quad(a, bb, d, c);
            }
        }
        const mesh = new THREE.Mesh(b.build(), this.mat.terrain);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        const group = new THREE.Group();
        group.add(mesh);

        // forest + rocks
        if (lod < 2) {
            const rng = new Rng(hashSeed(this.seed, ix, iy));
            const trunks = [], pines = [], rocks = [];
            const step = lod === 0 ? 6.5 : 9;
            for (let y = y0; y < y0 + TILE; y += step) {
                for (let x = x0; x < x0 + TILE; x += step) {
                    const px = x + rng.range(0, step), py = y + rng.range(0, step);
                    const fi = Math.floor((px - x0) / res) + 1, fj = Math.floor((py - y0) / res) + 1;
                    const h = H[fj * G + fi], d = D[fj * G + fi];
                    const dx = (H[fj * G + fi + 1] - H[fj * G + fi - 1]) / (2 * res);
                    const dy = (H[(fj + 1) * G + fi] - H[(fj - 1) * G + fi]) / (2 * res);
                    const slope = 1 / Math.sqrt(1 + dx * dx + dy * dy);
                    if (d < this.road.p.guardrail + 3.5) continue;
                    if (h < T.water + 1.5) continue;
                    const dens = this.forest.fbm(px / 260, py / 260, 2) * 0.6 + 0.35 - (h > T.snow - 50 ? 0.5 : 0);
                    if (slope > 0.78 && rng.float() < dens) {
                        const s = rng.range(0.75, 1.45);
                        trunks.push({ x: px, y: h - 0.3, z: -py, s, ry: rng.range(0, 6.28) });
                        pines.push({ x: px, y: h - 0.3, z: -py, s, ry: rng.range(0, 6.28) });
                    } else if (rng.float() < (slope < 0.8 ? 0.05 : 0.012)) {
                        const s = rng.range(0.6, 2.6);
                        rocks.push({ x: px, y: h - 0.2 * s, z: -py, sx: s * rng.range(0.8, 1.6), sy: s, sz: s * rng.range(0.8, 1.4), ry: rng.range(0, 6.28) });
                    }
                }
            }
            const shadows = lod === 0;
            const tr = instanced(this.trunkGeo, this.mat.trunk, trunks, { castShadow: shadows });
            const pi = instanced(this.pineGeo, this.mat.pine, pines, { castShadow: shadows });
            if (pi) {
                const c = new THREE.Color();
                for (let k = 0; k < pines.length; k++) {
                    c.setHSL(0.30 + rng.range(-0.04, 0.05), rng.range(0.45, 0.65), rng.range(0.07, 0.13));
                    if (this.night) c.multiplyScalar(0.7);
                    pi.setColorAt(k, c);
                }
                pi.instanceColor.needsUpdate = true;
            }
            const ro = instanced(this.rockGeo, this.mat.rock, rocks, { castShadow: shadows, receiveShadow: true });
            for (const m of [tr, pi, ro]) if (m) group.add(m);
        }
        this.scene.add(group);
        return { ix, iy, lod, group };
    }

    _disposeTile(t) {
        this.scene.remove(t.group);
        t.group.traverse((o) => { if (o.isMesh && o.geometry !== this.trunkGeo && o.geometry !== this.pineGeo && o.geometry !== this.rockGeo) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    }

    // --- one 100 m road chunk ---
    build(ci) {
        const road = this.road, P = road.p;
        const i0 = ci * CHUNK_SAMPLES, i1 = (ci + 1) * CHUNK_SAMPLES;
        const s0 = i0 * 2, s1 = i1 * 2;
        const group = new THREE.Group();
        const mb = new MultiBuilder();
        mb.map.set('road', roadSurface(road, i0, i1, 'mountain'));
        const gr = mb.get('gravel');
        ribbon(gr, road, i0, i1, P.roadHalf, P.shoulderOuter + 0.8, 0, -0.12, { uMode: 'm', uScale: 1 / 2, vPeriod: 2 });
        ribbon(gr, road, i0, i1, -P.shoulderOuter - 0.8, -P.roadHalf, -0.12, 0, { uMode: 'm', uScale: 1 / 2, vPeriod: 2 });
        const rail = mb.get('rail');
        for (const side of [-1, 1]) {
            const d = side * P.guardrail;
            ribbon(rail, road, i0, i1, d, d, 0.42, 0.78, { uMode: 'm', vPeriod: 4, flip: side < 0 });
        }
        const meshes = mb.meshes({ road: this.mat.road, gravel: this.mat.gravel, rail: this.mat.rail }, { castShadow: false, receiveShadow: true, computeNormals: true });
        meshes.forEach(m => group.add(m));

        const posts = [], reflectors = [];
        for (let s = Math.ceil(s0 / 4) * 4; s < s1; s += 4) {
            for (const side of [-1, 1]) {
                const p = road.pointAt(s, side * (P.guardrail + 0.08));
                posts.push({ x: p.px, y: p.pz - 0.25, z: -p.py, ry: p.th, sx: 0.12, sy: 1.05, sz: 0.16 });
                if (s % 24 === 0) reflectors.push({ x: p.px, y: p.pz + 0.6, z: -p.py, ry: p.th, sx: 0.06, sy: 0.12, sz: 0.2 });
            }
        }
        const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
        const add = (m) => m && group.add(m);
        add(instanced(box, this.mat.post, posts, { castShadow: true }));
        add(instanced(box, this.mat.reflector, reflectors, { castShadow: false }));

        for (const sg of road.signs) {
            if (sg.s < s0 || sg.s >= s1) continue;
            const p = road.pointAt(sg.s, sg.side * (P.guardrail + 0.7));
            const g = new THREE.Group();
            g.position.set(p.px, p.pz, -p.py);
            // face oncoming traffic: plane normal = -tangent
            g.rotation.y = Math.atan2(-p.c, p.sn);
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), this.mat.signPost);
            post.position.y = 0.7; g.add(post);
            const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), this.mat.sign);
            sign.position.set(0, 1.55, 0.05);
            if (sg.side < 0) sign.scale.x = -1;  // outer side right => left-hand bend arrow
            g.add(sign);
            group.add(g);
        }
        return { group, colliders: [] };
    }

    dispose() {
        for (const t of this.tiles.values()) this._disposeTile(t);
        this.tiles.clear();
        this.scene.remove(this.water, this.ring);
    }
}
