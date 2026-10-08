// City environment: avenues lined with procedurally generated buildings,
// sidewalks, street lights, trees, cross streets with crosswalks and signals.
import * as THREE from 'three';
import { Rng, Simplex, hashSeed, clamp } from '../core/rng.js';
import { MultiBuilder, GeoBuilder, ribbon } from '../meshBuilder.js';
import { facadeTextures, roofTexture, sidewalkTexture, concreteTexture, glowTexture, crosswalkTexture, neonTexture, FACADE_BAYS, FACADE_FLOORS, roadTexture } from '../textures.js';
import { roadSurface, roadMaterial, instanced, mergeGeos, M4, CHUNK_SAMPLES } from './common.js';

const BAY = 3.0, FLOOR = 3.4;
const NEON = [['HOTEL', '#ff3b6b'], ['DINER', '#38e8ff'], ['BAR', '#ff9d1c'], ['CLUB', '#c04bff'], ['24/7', '#46ff7a'], ['PIZZA', '#ff5a2a'], ['MOTEL', '#ff3b3b'], ['CAFE', '#ffd84a'], ['GARAGE', '#4ab0ff']];

export class CityBuilder {
    constructor(road, scene, night, seed) {
        this.road = road;
        this.scene = scene;
        this.night = night;
        this.noise = new Simplex(seed ^ 0xbeef);
        this.cursor = { '-1': 30, '1': 30 };
        this.seed = seed;
        this._materials();
        this._props();

        // flat ground that follows the player
        const tex = concreteTexture().clone();
        tex.repeat.set(160, 160);
        tex.needsUpdate = true;
        this.groundTex = tex;
        this.ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, color: 0x8a8a88 }));
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = -0.06;
        this.ground.receiveShadow = true;
        scene.add(this.ground);
    }

    _materials() {
        const n = this.night;
        const em = n ? 0.8 : 0.0;
        const facade = (style, rough, metal) => {
            const { map, emissive } = facadeTextures(style);
            return new THREE.MeshStandardMaterial({
                map, emissiveMap: emissive, emissive: n ? 0xffffff : 0x000000, emissiveIntensity: em,
                roughness: rough, metalness: metal, envMapIntensity: style === 'glass' ? 1.4 : 0.6,
            });
        };
        const sw = sidewalkTexture();
        this.mat = {
            road: roadMaterial('city'),
            glass: facade('glass', 0.18, 0.55),
            office: facade('office', 0.7, 0.1),
            stone: facade('stone', 0.85, 0.0),
            brick: facade('brick', 0.9, 0.0),
            roof: new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.95 }),
            sidewalk: new THREE.MeshStandardMaterial({ map: sw, roughness: 0.92 }),
            curb: new THREE.MeshStandardMaterial({ color: 0x9a9894, roughness: 0.85 }),
            pole: new THREE.MeshStandardMaterial({ color: 0x3b3f44, metalness: 0.75, roughness: 0.45 }),
            lampHead: new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffd9a0, emissiveIntensity: n ? 3.0 : 0.0, roughness: 0.4 }),
            trunk: new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95 }),
            leaves: new THREE.MeshStandardMaterial({ color: 0x3f6b2d, roughness: 0.9, flatShading: true }),
            barrier: new THREE.MeshStandardMaterial({ map: this._barrierTexture(), roughness: 0.7 }),
            crosswalk: new THREE.MeshStandardMaterial({ map: crosswalkTexture(), transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
            crossRoad: new THREE.MeshStandardMaterial({ map: roadTexture('mountain'), roughness: 0.9 }),
            signal: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5 }),
            green: new THREE.MeshStandardMaterial({ color: 0x103010, emissive: 0x30ff60, emissiveIntensity: 2.0 }),
            red: new THREE.MeshStandardMaterial({ color: 0x301010, emissive: 0xff2a1a, emissiveIntensity: 2.0 }),
            pool: new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(1.5, 1.0, 0.55), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
            glowPts: new THREE.PointsMaterial({ map: glowTexture(), color: 0xffd9a0, size: 3.4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }),
        };
        this.neonMats = NEON.map(([t, c]) => {
            const tex = neonTexture(t, c);
            return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: n ? 2.2 : 0.4, roughness: 0.5 });
        });
    }

    _barrierTexture() {
        const c = document.createElement('canvas'); c.width = 256; c.height = 64;
        const ctx = c.getContext('2d');
        for (let x = -64; x < 256; x += 32) {
            ctx.fillStyle = (x / 32) % 2 ? '#e8e8e8' : '#d0251b';
            ctx.beginPath(); ctx.moveTo(x, 64); ctx.lineTo(x + 32, 64); ctx.lineTo(x + 64, 0); ctx.lineTo(x + 32, 0); ctx.fill();
        }
        const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
        return t;
    }

    _props() {
        // street lamp: pole + arm + head, local X towards road
        const pole = new THREE.CylinderGeometry(0.09, 0.14, 9, 8);
        const arm = new THREE.BoxGeometry(2.6, 0.12, 0.12);
        const head = new THREE.BoxGeometry(0.9, 0.18, 0.38);
        this.lampGeo = mergeGeos([
            { geo: pole, matrix: M4(0, 4.5, 0) },
            { geo: arm, matrix: M4(1.25, 8.9, 0, 0, 0, 0.06) },
        ]);
        this.lampHeadGeo = mergeGeos([{ geo: head, matrix: M4(2.45, 8.95, 0) }]);
        this.trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 3.2, 6).translate(0, 1.6, 0);
        const crown = new THREE.IcosahedronGeometry(2.1, 1);
        const p = crown.attributes.position;
        const rnd = new Rng(3);
        for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rnd.range(0.85, 1.15), p.getY(i) * rnd.range(0.75, 1.05), p.getZ(i) * rnd.range(0.85, 1.15));
        crown.computeVertexNormals();
        this.crownGeo = crown.translate(0, 4.6, 0);
        this.barrierGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
        this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
        this.sigPole = new THREE.CylinderGeometry(0.12, 0.15, 6.2, 8);
        this.sigArm = new THREE.BoxGeometry(6.5, 0.16, 0.16);
        this.sigBox = new THREE.BoxGeometry(0.35, 1.05, 0.35);
        this.sigLamp = new THREE.SphereGeometry(0.11, 8, 6);
        for (const g of [this.lampGeo, this.lampHeadGeo, this.trunkGeo, this.crownGeo, this.barrierGeo, this.boxGeo]) g.userData.shared = true;
    }

    update(playerPos) {
        this.ground.position.x = playerPos.x;
        this.ground.position.z = playerPos.z;
        this.groundTex.offset.set(playerPos.x / 25, -playerPos.z / 25);
    }

    // --- one 100 m chunk ---
    build(ci) {
        const road = this.road, P = road.p;
        const i0 = ci * CHUNK_SAMPLES, i1 = (ci + 1) * CHUNK_SAMPLES;
        const s0 = i0 * 2, s1 = i1 * 2;
        const rng = new Rng(hashSeed(this.seed, ci));
        const group = new THREE.Group();
        const colliders = [];
        const mb = new MultiBuilder();

        // road + sidewalks
        const surface = roadSurface(road, i0, i1, 'city');
        const skip = (a, b) => !!(road.inIntersection(a, -0.5) || road.inIntersection(b, -0.5));
        const sw = mb.get('sidewalk'), curb = mb.get('curb');
        const H = P.curbHeight, out = P.sidewalkOuter;
        ribbon(sw, road, i0, i1, P.roadHalf, out, H, H, { uMode: 'm', uScale: 1 / 3, vPeriod: 3, skip });
        ribbon(sw, road, i0, i1, -out, -P.roadHalf, H, H, { uMode: 'm', uScale: 1 / 3, vPeriod: 3, skip });
        ribbon(curb, road, i0, i1, P.roadHalf, P.roadHalf, 0, H, { uMode: 'm', vPeriod: 4, skip });
        ribbon(curb, road, i0, i1, -P.roadHalf, -P.roadHalf, 0, H, { uMode: 'm', vPeriod: 4, skip, flip: true });
        ribbon(curb, road, i0, i1, out, out, -0.2, H, { uMode: 'm', vPeriod: 4, skip, flip: true });
        ribbon(curb, road, i0, i1, -out, -out, -0.2, H, { uMode: 'm', vPeriod: 4, skip });
        mb.map.set('road', surface);

        // street furniture
        const lamps = [], heads = [], trunks = [], crowns = [], pools = [], glows = [];
        const firstLamp = Math.ceil(s0 / 32) * 32;
        for (let s = firstLamp; s < s1; s += 32) {
            for (const side of [-1, 1]) {
                const ss = s + (side > 0 ? 16 : 0);
                if (ss >= s1 || road.inIntersection(ss, 3)) continue;
                const p = road.pointAt(ss, side * (P.roadHalf + 0.75));
                // local +X of the lamp points at the road centre
                const dirx = p.sn * side, diry = -p.c * side; // 2D vector towards road centre
                const phi = Math.atan2(diry, dirx); // 2D angle; three yaw = phi
                lamps.push({ x: p.px, y: p.pz + H, z: -p.py, ry: phi });
                const hx = p.px + dirx * 2.45, hy = p.py + diry * 2.45;
                colliders.push({ x: p.px, y: p.py, r: 0.25 });
                if (this.night) {
                    pools.push({ x: hx, y: p.z + 0.03, z: -hy });
                    glows.push(new THREE.Vector3(hx, p.z + 8.75, -hy));
                }
                // tree between lamps
                const ts = ss + 16 * (rng.chance(0.5) ? 0.5 : -0.5);
                if (rng.chance(0.55) && !road.inIntersection(ts, 4) && ts > s0 && ts < s1) {
                    const tp = road.pointAt(ts, side * (P.roadHalf + 2.6));
                    const sc = rng.range(0.8, 1.2);
                    trunks.push({ x: tp.px, y: tp.pz + H, z: -tp.py, s: sc, ry: rng.range(0, 6) });
                    crowns.push({ x: tp.px, y: tp.pz + H, z: -tp.py, s: sc, ry: rng.range(0, 6) });
                    colliders.push({ x: tp.px, y: tp.py, r: 0.35 });
                }
            }
        }
        const add = (m) => { if (m) group.add(m); };
        add(instanced(this.lampGeo, this.mat.pole, lamps));
        add(instanced(this.lampHeadGeo, this.mat.lampHead, lamps, { castShadow: false }));
        add(instanced(this.trunkGeo, this.mat.trunk, trunks));
        add(instanced(this.crownGeo, this.mat.leaves, crowns));
        if (pools.length) {
            const pg = new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2);
            add(instanced(pg, this.mat.pool, pools, { castShadow: false }));
            const gg = new THREE.BufferGeometry().setFromPoints(glows);
            const pts = new THREE.Points(gg, this.mat.glowPts);
            group.add(pts);
        }

        // intersections in this chunk
        for (const it of road.intersections) {
            if (it.s < s0 || it.s >= s1) continue;
            this._intersection(it, mb, group, colliders, rng);
        }

        // buildings on both sides
        for (const side of [-1, 1]) this._buildingsSide(side, s0, s1, mb, group, rng);

        const meshes = mb.meshes({
            road: this.mat.road, sidewalk: this.mat.sidewalk, curb: this.mat.curb, roof: this.mat.roof,
            glass: this.mat.glass, office: this.mat.office, stone: this.mat.stone, brick: this.mat.brick,
            crosswalk: this.mat.crosswalk, crossRoad: this.mat.crossRoad, barrier: this.mat.barrier,
        }, { castShadow: true, receiveShadow: true });
        for (const m of meshes) {
            if (m.material === this.mat.road || m.material === this.mat.sidewalk || m.material === this.mat.crosswalk || m.material === this.mat.crossRoad) m.castShadow = false;
            if (m.material === this.mat.road || m.material === this.mat.sidewalk || m.material === this.mat.curb || m.material === this.mat.crossRoad) {
                // road surfaces need smooth normals from the ribbon
                m.geometry.computeVertexNormals();
            }
            group.add(m);
        }
        return { group, colliders };
    }

    _intersection(it, mb, group, colliders, rng) {
        const road = this.road, P = road.p;
        const f = road.frameAt(it.s);
        const w = it.width;
        const lx = -f.sn, ly = f.c;          // left normal
        const tx = f.c, ty = f.sn;           // tangent
        const z = f.z;
        const cr = mb.get('crossRoad');
        const len = 95;
        for (const side of [-1, 1]) {
            // cross street asphalt from road edge outwards
            const dA = side * P.roadHalf, dB = side * (P.roadHalf + len);
            const corners = [[-w / 2, dA], [w / 2, dA], [w / 2, dB], [-w / 2, dB]].map(([ds, dd]) => {
                const x = f.x + tx * ds + lx * dd, y = f.y + ty * ds + ly * dd;
                return [x, z + 0.005, -y, (ds + w / 2) / w, dd / 12];
            });
            const ids = corners.map(c => cr.vertex(c[0], c[1], c[2], c[3], c[4]));
            if (side > 0) cr.quad(ids[0], ids[1], ids[2], ids[3]); else cr.quad(ids[0], ids[3], ids[2], ids[1]);

            // barrier across the opening at the building line
            const bd = side * (P.sidewalkOuter + 0.6);
            const bx = f.x + lx * bd, by = f.y + ly * bd;
            const bar = mb.get('barrier');
            bar.box(bx, z, -by, w - 1, 1.0, 0.45, f.th, { uScale: 1 / 4, vScale: 1, top: true });

            // lined buildings deeper down the cross street + end cap
            for (const cs of [-1, 1]) {
                let d = P.sidewalkOuter + 36;
                while (d < len - 8) {
                    const bw = rng.range(14, 24);
                    const depth = rng.range(12, 22);
                    const h = rng.range(10, 45);
                    const off = cs * (w / 2 + 3 + depth / 2);
                    const dc = side * (d + bw / 2);
                    const cx = f.x + tx * off + lx * dc, cy = f.y + ty * off + ly * dc;
                    this._addBuilding(mb, group, cx, cy, z, f.th + Math.PI / 2, bw, depth, h, rng);
                    d += bw + rng.range(0, 2);
                }
            }
            const capD = side * (len + 6);
            const cx = f.x + lx * capD, cy = f.y + ly * capD;
            this._addBuilding(mb, group, cx, cy, z, f.th, w + 30, 12, rng.range(15, 50), rng);
        }
        // crosswalks on the main road
        const cw = mb.get('crosswalk');
        for (const ds of [-w / 2 - 2, w / 2 + 2]) {
            const pts = [[ds - 1.5, -P.roadHalf], [ds + 1.5, -P.roadHalf], [ds + 1.5, P.roadHalf], [ds - 1.5, P.roadHalf]].map(([a, d]) => {
                const x = f.x + tx * a + lx * d, y = f.y + ty * a + ly * d;
                return [x, z + 0.012, -y];
            });
            const uv = [[0, 0], [0, 1], [1, 1], [1, 0]];
            const ids = pts.map((p, k) => cw.vertex(p[0], p[1], p[2], uv[k][0], uv[k][1]));
            cw.quad(ids[0], ids[1], ids[2], ids[3]);
        }
        // traffic signals on the corners (decorative), merged into a few meshes
        const parts = { pole: [], signal: [], green: [], red: [] };
        for (const side of [-1, 1]) {
            const ds = -side * (w / 2 + 3.5);
            const dd = side * (P.roadHalf + 1.0);
            const x = f.x + tx * ds + lx * dd, y = f.y + ty * ds + ly * dd;
            const dirx = -lx * side, diry = -ly * side;
            const base = M4(x, z + P.curbHeight, -y, 0, Math.atan2(diry, dirx), 0);
            const at = (px, py, pz) => base.clone().multiply(M4(px, py, pz));
            parts.pole.push({ geo: this.sigPole, matrix: at(0, 3.1, 0) }, { geo: this.sigArm, matrix: at(3.2, 6.0, 0) });
            for (const ax of [3.0, 6.2]) {
                parts.signal.push({ geo: this.sigBox, matrix: at(ax, 5.35, 0) });
                parts[side > 0 ? 'green' : 'red'].push({ geo: this.sigLamp, matrix: at(ax, side > 0 ? 5.05 : 5.65, -0.18 * side) });
            }
            colliders.push({ x, y, r: 0.3 });
        }
        for (const [k, list] of Object.entries(parts)) {
            const m = new THREE.Mesh(mergeGeos(list), this.mat[k]);
            m.castShadow = k === 'pole';
            group.add(m);
        }
    }

    _buildingsSide(side, s0, s1, mb, group, rng) {
        const road = this.road, P = road.p;
        const key = String(side);
        if (this.cursor[key] < s0 - 60) this.cursor[key] = s0;
        while (this.cursor[key] < s1) {
            let s = this.cursor[key];
            const w = rng.range(14, 36);
            const blocked = road.intersections.find(it => s + w + 3 > it.s - it.width / 2 && s - 3 < it.s + it.width / 2);
            if (blocked) { this.cursor[key] = blocked.s + blocked.width / 2 + 3; continue; }
            const gap = rng.chance(0.15) ? rng.range(4, 8) : rng.range(0, 1.5);
            const depth = rng.range(16, 30);
            const setback = P.sidewalkOuter + 0.6 + rng.range(0, 1.2);
            const mid = s + w / 2;
            const f = road.pointAt(mid, side * (setback + depth / 2));
            // footprint clearance against all nearby road
            const tx = f.c, ty = f.sn, lx = -f.sn, ly = f.c;
            let ok = true;
            for (const [a, b] of [[-w / 2, -depth / 2], [w / 2, -depth / 2], [w / 2, depth / 2], [-w / 2, depth / 2], [0, -depth / 2], [-w / 4, -depth / 2], [w / 4, -depth / 2]]) {
                const x = f.px + tx * a + lx * side * b, y = f.py + ty * a + ly * side * b;
                if (road.clearance(x, y) < P.sidewalkOuter + 0.4) { ok = false; break; }
            }
            if (ok) {
                const zone = 0.5 + 0.5 * this.noise.noise(mid / 900, this.seed % 97);
                const hMax = 16 + 150 * Math.pow(clamp(zone, 0, 1), 1.7);
                const h = Math.max(8, rng.range(0.35, 1) * hMax);
                this._addBuilding(mb, group, f.px, f.py, f.z, f.th, w, depth, h, rng, side);
            }
            this.cursor[key] = s + (ok ? w : 6) + gap;
        }
    }

    // Box building with facade textures in metres; th = 2D heading of local X
    _addBuilding(mb, group, x, y, z, th, w, depth, h, rng, frontSide = 0) {
        let style;
        if (h > 48) style = rng.chance(0.7) ? 'glass' : 'office';
        else if (h > 20) style = rng.pick(['office', 'stone', 'glass', 'brick']);
        else style = rng.pick(['brick', 'stone', 'brick', 'office']);
        const facade = mb.get(style), roof = mb.get('roof');
        const uS = 1 / (BAY * FACADE_BAYS), vS = 1 / (FLOOR * FACADE_FLOORS);
        const uOff = rng.int(0, 7) / FACADE_BAYS, vOff = 0;
        const base = z - 0.3;
        const tiers = h > 60 && rng.chance(0.55) ? 2 : 1;
        if (tiers === 1) {
            facade.box(x, base, -y, w, h, depth, th, { uScale: uS, vScale: vS, top: false, uOffset: uOff, vOffset: vOff });
            roof.box(x, base, -y, w, h, depth, th, { sides: false });
        } else {
            const h1 = h * rng.range(0.55, 0.7);
            facade.box(x, base, -y, w, h1, depth, th, { uScale: uS, vScale: vS, top: false, uOffset: uOff });
            roof.box(x, base, -y, w, h1, depth, th, { sides: false });
            const w2 = w * rng.range(0.6, 0.8), d2 = depth * rng.range(0.6, 0.8);
            facade.box(x, base + h1, -y, w2, h - h1, d2, th, { uScale: uS, vScale: vS, top: false, uOffset: uOff, vOffset: h1 * vS });
            roof.box(x, base + h1, -y, w2, h - h1, d2, th, { sides: false });
        }
        // roof clutter
        const c = Math.cos(th), s = Math.sin(th);
        const n = rng.int(1, 3);
        const topH = tiers === 1 ? h : h;
        for (let i = 0; i < n; i++) {
            const a = rng.range(-w / 3, w / 3), b = rng.range(-depth / 3, depth / 3);
            const bx = x + c * a - s * b, by = y + s * a + c * b;
            const sx = rng.range(1.5, 4), sz = rng.range(1.5, 4), sy = rng.range(1, 2.5);
            if (tiers === 1) roof.box(bx, base + topH, -by, sx, sy, sz, th);
        }
        if (style === 'glass' && h > 90 && rng.chance(0.6)) {
            roof.box(x, base + h, -y, 0.5, rng.range(8, 20), 0.5, th);
        }
        // neon sign on low-rise fronts
        if (frontSide && h < 30 && rng.chance(0.3)) {
            const mat = rng.pick(this.neonMats);
            const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), mat);
            // front face is towards the road: offset -frontSide * depth/2 along left normal
            const lx = -s, ly = c;
            const fx = x - lx * frontSide * (depth / 2 + 0.06), fy = y - ly * frontSide * (depth / 2 + 0.06);
            sign.position.set(fx, base + rng.range(4.5, 6.5), -fy);
            const dirx = -lx * frontSide, diry = -ly * frontSide;
            sign.rotation.y = Math.atan2(dirx, -diry);
            group.add(sign);
        }
    }

    dispose() {
        this.scene.remove(this.ground);
    }
}
