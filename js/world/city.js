// City environment: avenues lined with procedurally generated buildings,
// sidewalks, street lights, trees, cross streets with crosswalks and signals.
import * as THREE from 'three';
import { Rng, Simplex, hashSeed, clamp } from '../core/rng.js';
import { MultiBuilder, GeoBuilder, ribbon } from '../meshBuilder.js';
import { facadeTextures, roofTexture, sidewalkTexture, concreteTexture, glowTexture, crosswalkTexture, neonTexture, FACADE_BAYS, FACADE_FLOORS, roadTexture, shopTextures, houseTextures, grassTexture } from '../textures.js';
import { createCar, TRAFFIC_PAINTS } from '../assets.js';
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

        // river level: land is built per chunk, water shows wherever there is no land
        this.ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: night ? 0x061018 : 0x24505e, roughness: 0.08, metalness: 0.1 }));
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = -3.2;
        this.ground.receiveShadow = true;
        scene.add(this.ground);
        this.zones = [];
        this.zoneRng = new Rng(seed ^ 0x2017);
    }

    _materials() {
        const n = this.night;
        const night = n;
        const em = n ? 0.8 : 0.0;
        const facade = (style, rough, metal) => {
            const { map, emissive } = facadeTextures(style);
            return new THREE.MeshStandardMaterial({
                map, emissiveMap: emissive, emissive: n ? 0xffffff : 0x000000, emissiveIntensity: em,
                roughness: rough, metalness: metal, envMapIntensity: style === 'glass' ? 1.4 : 0.6,
            });
        };
        const sw = sidewalkTexture();
        const shop = shopTextures();
        const houseMats = [0, 1, 2, 3, 4, 5].map((v) => { const t = houseTextures(v); return new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissive, emissive: n ? 0xffffff : 0, emissiveIntensity: n ? 0.9 : 0, roughness: 0.85 }); });
        this.houseMats = houseMats;
        const gt = grassTexture(), ct = concreteTexture();
        this.mat = {
            house0: houseMats[0], house1: houseMats[1], house2: houseMats[2], house3: houseMats[3], house4: houseMats[4], house5: houseMats[5],
            shop: new THREE.MeshStandardMaterial({ map: shop.map, emissiveMap: shop.emissive, emissive: n ? 0xffffff : 0, emissiveIntensity: n ? 1.2 : 0, roughness: 0.6 }),
            awning: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: false }),
            houseRoof: new THREE.MeshStandardMaterial({ color: 0x5a3b30, roughness: 0.9, side: THREE.DoubleSide }),
            grass: new THREE.MeshStandardMaterial({ map: gt, roughness: 1, color: 0xbfd0a8 }),
            land: new THREE.MeshStandardMaterial({ map: ct, roughness: 0.95, color: 0x8a8a88 }),
            water: new THREE.MeshStandardMaterial({ color: 0x1d3f4c, roughness: 0.05, metalness: 0.1 }),
            fence: new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.8 }),
            bench: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.8 }),
            railing: new THREE.MeshStandardMaterial({ color: 0x2f3338, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }),
            steel: new THREE.MeshStandardMaterial({ color: 0x8b2b20, metalness: 0.5, roughness: 0.5 }),
            deck: new THREE.MeshStandardMaterial({ color: 0x8c8880, roughness: 0.9, side: THREE.DoubleSide }),
            awn0: new THREE.MeshStandardMaterial({ color: 0x8b1e1e, roughness: 0.8 }), awn1: new THREE.MeshStandardMaterial({ color: 0x1e5a3a, roughness: 0.8 }),
            awn2: new THREE.MeshStandardMaterial({ color: 0x1e3a6b, roughness: 0.8 }), awn3: new THREE.MeshStandardMaterial({ color: 0xc8a030, roughness: 0.8 }),
            cable: new THREE.LineBasicMaterial({ color: 0x333333 }),
            pond: new THREE.MeshStandardMaterial({ color: night ? 0x061018 : 0x2a5866, roughness: 0.05, metalness: 0.1 }),
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
    }

    // District along the road; each side can differ (e.g. waterfront on one side)
    zoneAt(s) {
        const r = this.zoneRng;
        while (!this.zones.length || this.zones[this.zones.length - 1].s1 <= s) {
            const prev = this.zones[this.zones.length - 1];
            const s0 = prev ? prev.s1 : 0;
            let type;
            if (!prev) type = 'downtown';
            else {
                const roll = r.float();
                type = roll < 0.24 ? 'downtown' : roll < 0.48 ? 'midtown' : roll < 0.66 ? 'residential' : roll < 0.8 ? 'park' : roll < 0.92 ? 'waterfront' : 'bridge';
                if (type === prev.type) type = 'midtown';
            }
            const len = type === 'bridge' ? r.range(260, 420) : r.range(320, 650);
            const sides = {
                '-1': type === 'waterfront' ? (r.chance(0.5) ? 'water' : 'midtown') : type === 'bridge' ? 'water' : type,
                '1': type === 'bridge' ? 'water' : type,
            };
            if (type === 'waterfront' && sides['-1'] !== 'water') sides['1'] = 'water';
            this.zones.push({ s0, s1: s0 + len, type, sides });
        }
        for (let i = this.zones.length - 1; i >= 0; i--) if (this.zones[i].s0 <= s) return this.zones[i];
        return this.zones[0];
    }
    sideZone(s, side) { return this.zoneAt(s).sides[String(side)]; }

    // --- one 100 m chunk ---
    build(ci) {
        const road = this.road, P = road.p;
        const i0 = ci * CHUNK_SAMPLES, i1 = (ci + 1) * CHUNK_SAMPLES;
        const s0 = i0 * 2, s1 = i1 * 2;
        const rng = new Rng(hashSeed(this.seed, ci));
        const group = new THREE.Group();
        const colliders = [];
        const mb = new MultiBuilder();
        // no cross streets into parks, rivers or onto bridges
        road.intersections = road.intersections.filter(it => it.s < s0 - 20 || it.s > s1 + 400 || this.zoneAt(it.s).type === 'downtown' || this.zoneAt(it.s).type === 'midtown' || this.zoneAt(it.s).type === 'residential');

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

        // land / water either side, by district
        const zoneIs = (side, types) => (a, b) => !types.includes(this.sideZone(a, side)) || !types.includes(this.sideZone(b, side));
        for (const side of [-1, 1]) {
            const [dA, dB] = side > 0 ? [out, 450] : [-450, -out];
            ribbon(mb.get('grass'), road, i0, i1, dA, dB, -0.06, -0.06, { uMode: 'world', uScale: 1 / 12, skip: zoneIs(side, ['park', 'residential']) });
            ribbon(mb.get('land'), road, i0, i1, dA, dB, -0.06, -0.06, { uMode: 'world', uScale: 1 / 25, skip: zoneIs(side, ['downtown', 'midtown']) });
            const notWater = zoneIs(side, ['water']);
            ribbon(mb.get('curb'), road, i0, i1, side * out, side * out, -3.4, -0.2, { uMode: 'm', vPeriod: 4, skip: notWater, flip: side > 0 });
            ribbon(mb.get('railing'), road, i0, i1, side * (out - 0.15), side * (out - 0.15), H + 0.55, H + 1.05, { uMode: 'm', vPeriod: 4, skip: notWater });
            ribbon(mb.get('railing'), road, i0, i1, side * (out - 0.15), side * (out - 0.15), H + 0.2, H + 0.28, { uMode: 'm', vPeriod: 4, skip: notWater });
        }
        this._districtDecor(s0, s1, mb, group, rng, colliders);

        // buildings on both sides
        for (const side of [-1, 1]) this._buildingsSide(side, s0, s1, mb, group, rng);

        const meshes = mb.meshes({
            road: this.mat.road, sidewalk: this.mat.sidewalk, curb: this.mat.curb, roof: this.mat.roof,
            glass: this.mat.glass, office: this.mat.office, stone: this.mat.stone, brick: this.mat.brick,
            crosswalk: this.mat.crosswalk, crossRoad: this.mat.crossRoad, barrier: this.mat.barrier,
            grass: this.mat.grass, land: this.mat.land, railing: this.mat.railing, deck: this.mat.deck, steel: this.mat.steel,
            shop: this.mat.shop, houseRoof: this.mat.houseRoof, fence: this.mat.fence, bench: this.mat.bench, pond: this.mat.pond,
            awn0: this.mat.awn0, awn1: this.mat.awn1, awn2: this.mat.awn2, awn3: this.mat.awn3,
            house0: this.mat.house0, house1: this.mat.house1, house2: this.mat.house2, house3: this.mat.house3, house4: this.mat.house4, house5: this.mat.house5,
        }, { castShadow: true, receiveShadow: true });
        for (const m of meshes) {
            const flat = [this.mat.road, this.mat.sidewalk, this.mat.crosswalk, this.mat.crossRoad, this.mat.grass, this.mat.land, this.mat.pond];
            if (flat.includes(m.material)) m.castShadow = false;
            if ([this.mat.road, this.mat.sidewalk, this.mat.curb, this.mat.crossRoad, this.mat.railing, this.mat.grass, this.mat.land, this.mat.deck].includes(m.material)) {
                // road surfaces need smooth normals from the ribbon
                m.geometry.computeVertexNormals();
            }
            group.add(m);
        }
        return { group, colliders };
    }

    // Parks, plazas, bridges, overpasses
    _districtDecor(s0, s1, mb, group, rng, colliders) {
        const road = this.road, P = road.p, out = P.sidewalkOuter;
        const deck = mb.get('deck'), steel = mb.get('steel'), bench = mb.get('bench');
        const trunks = [], crowns = [];
        // bridge deck underside + piers
        for (let s = Math.ceil(s0 / 2) * 2; s < s1; s += 2) {
            const z = this.zoneAt(s);
            if (z.type !== 'bridge') continue;
            const f = road.frameAt(s);
            if (s % 32 === 0) deck.box(f.x, -3.6, -f.y, 3, 2.5, out * 2 - 1, f.th);
            // suspension towers near both ends
            for (const ts of [z.s0 + 40, z.s1 - 40]) {
                if (Math.abs(s - ts) > 1) continue;
                for (const side of [-1, 1]) {
                    const p = road.pointAt(s, side * (out + 1.2));
                    steel.box(p.px, -3.4, -p.py, 2.2, 52, 2.2, f.th);
                    colliders.push({ x: p.px, y: p.py, r: 1.3 });
                }
                const p0 = road.pointAt(s, 0);
                steel.box(p0.px, 44, -p0.py, 1.6, 2.4, out * 2 + 4.6, f.th);
            }
        }
        // cables for a bridge whose first tower lies in this chunk
        for (const z of this.zones) {
            if (z.type !== 'bridge') continue;
            const ts = z.s0 + 40, te = z.s1 - 40;
            if (ts < s0 || ts >= s1 || te > road.frontS - 4) continue;
            for (const side of [-1, 1]) {
                const pts = [];
                const n = 48;
                for (let k = 0; k <= n; k++) {
                    const t = k / n, s = ts + (te - ts) * t;
                    const p = road.pointAt(s, side * (out + 1.2));
                    const sag = 47 - 40 * (1 - Math.pow(2 * t - 1, 2));
                    pts.push(new THREE.Vector3(p.px, p.pz + sag, -p.py));
                }
                // main cable + hangers
                const hangers = [];
                for (let k = 1; k < n; k++) { hangers.push(pts[k], new THREE.Vector3(pts[k].x, road.pointAt(ts + (te - ts) * k / n, 0).pz + 1, pts[k].z)); }
                group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.mat.cable));
                group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(hangers), this.mat.cable));
            }
        }
        // parks: trees, benches, ponds
        for (const side of [-1, 1]) {
            for (let s = Math.ceil(s0 / 9) * 9; s < s1; s += 9) {
                if (this.sideZone(s, side) !== 'park') continue;
                if (s % 27 === 0 && !road.inIntersection(s, 3)) {
                    const p = road.pointAt(s, side * (out - 0.8));
                    bench.box(p.px, p.pz + P.curbHeight, -p.py, 1.8, 0.45, 0.6, p.th);
                }
                for (let k = 0; k < 3; k++) {
                    const d = side * (out + 4 + rng.range(0, 60));
                    const p = road.pointAt(s + rng.range(-4, 4), d);
                    if (road.clearance(p.px, p.py) < out + 2) continue;
                    const sc = rng.range(0.8, 1.6);
                    trunks.push({ x: p.px, y: p.pz - 0.06, z: -p.py, s: sc, ry: rng.range(0, 6) });
                    crowns.push({ x: p.px, y: p.pz - 0.06, z: -p.py, s: sc, ry: rng.range(0, 6) });
                }
            }
            const mid = (s0 + s1) / 2;
            if (this.sideZone(mid, side) === 'park' && rng.chance(0.35)) {
                const d = side * (out + 30 + rng.range(0, 20));
                const p = road.pointAt(mid, d);
                if (road.clearance(p.px, p.py) > out + 22) {
                    const pond = new THREE.Mesh(new THREE.CircleGeometry(rng.range(12, 20), 24).rotateX(-Math.PI / 2), this.mat.pond);
                    pond.position.set(p.px, p.pz - 0.02, -p.py);
                    pond.scale.z = rng.range(0.6, 1);
                    group.add(pond);
                }
            }
        }
        if (trunks.length) {
            group.add(instanced(this.trunkGeo, this.mat.trunk, trunks));
            group.add(instanced(this.crownGeo, this.mat.leaves, crowns));
        }
        // elevated railway crossing over the avenue
        const sMid = s0 + 50;
        const z = this.zoneAt(sMid);
        if ((z.type === 'downtown' || z.type === 'midtown') && Math.abs(road.frameAt(sMid).k) < 0.002 && !road.inIntersection(sMid, 25) && rng.chance(0.14)) {
            const f = road.frameAt(sMid);
            const span = out + 60;
            deck.box(f.x, 8.5, -f.y, 7, 1.8, span * 2, f.th);
            steel.box(f.x - f.sn * 0, 10.3, -f.y, 0.25, 1.1, span * 2, f.th + 0);
            for (const side of [-1, 1]) {
                for (const off of [out + 3, out + 30, out + 55]) {
                    const p = road.pointAt(sMid, side * off);
                    deck.box(p.px, -0.1, -p.py, 2.2, 8.7, 2.2, f.th);
                }
            }
            this.overpasses = this.overpasses || [];
            this.overpasses.push({ s: sMid, width: 12 });
        }
    }

    _house(mb, group, x, y, z, th, w, depth, rng, side) {
        const v = rng.int(0, 5);
        const h = rng.range(5.6, 7);
        mb.get('house' + v).box(x, z - 0.2, -y, w, h, depth, th, { uScale: 1 / 8, vScale: 1 / 6, top: false });
        mb.get('houseRoof').gable(x, z - 0.2 + h, -y, w + 0.8, depth + 0.8, rng.range(2.2, 3.4), th);
        // fence along the front yard
        const lx = -Math.sin(th), ly = Math.cos(th);
        const fd = depth / 2 + rng.range(4, 6);
        const fx = x - lx * side * fd, fy = y - ly * side * fd;
        if (rng.chance(0.7)) mb.get('fence').box(fx, z, -fy, w, 0.9, 0.08, th);
        // car parked on the driveway
        if (rng.chance(0.35) && this.parked < 4) {
            this.parked++;
            const id = rng.chance(0.5) ? 'ferrari' : 'concept';
            const rig = createCar(id, { lod: true, color: rng.pick(TRAFFIC_PAINTS) });
            const dx = x + Math.cos(th) * (w / 2 + 1.8) - lx * side * (depth / 2 + 1.5);
            const dy = y + Math.sin(th) * (w / 2 + 1.8) - ly * side * (depth / 2 + 1.5);
            rig.root.position.set(dx, z, -dy);
            rig.root.rotation.y = th + (side > 0 ? 0 : Math.PI);
            group.add(rig.root);
        }
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
        this.parked = 0;
        while (this.cursor[key] < s1) {
            let s = this.cursor[key];
            const zone = this.sideZone(s, side);
            if (zone === 'water' || zone === 'park') { this.cursor[key] = s + 8; continue; }
            const resi = zone === 'residential';
            const w = resi ? rng.range(10, 14) : rng.range(14, 36);
            const blocked = [...road.intersections, ...(this.overpasses || [])].find(it => s + w + 3 > it.s - it.width / 2 && s - 3 < it.s + it.width / 2);
            if (blocked) { this.cursor[key] = blocked.s + blocked.width / 2 + 3; continue; }
            if (this.sideZone(s + w, side) !== zone) { this.cursor[key] = s + 6; continue; }
            if (resi) {
                const depth = rng.range(9, 12), setback = P.sidewalkOuter + rng.range(6, 9);
                const f = road.pointAt(s + w / 2, side * (setback + depth / 2));
                if (road.clearance(f.px, f.py) > P.sidewalkOuter + 3) this._house(mb, group, f.px, f.py, f.z, f.th, w, depth, rng, side);
                this.cursor[key] = s + w + rng.range(3, 7);
                continue;
            }
            // midtown: sometimes leave an open plaza
            if (zone === 'midtown' && rng.chance(0.1)) {
                const p = road.pointAt(s + 18, side * (P.sidewalkOuter + 14));
                const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.4, 0.7, 24), this.mat.curb);
                base.position.set(p.px, p.pz + 0.3, -p.py); group.add(base);
                const water = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.1, 24), this.mat.pond);
                water.position.set(p.px, p.pz + 0.68, -p.py); group.add(water);
                const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3, 10), this.mat.curb);
                col.position.set(p.px, p.pz + 2, -p.py); group.add(col);
                this.cursor[key] = s + 36;
                continue;
            }
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
                const n = clamp(0.5 + 0.5 * this.noise.noise(mid / 900, this.seed % 97), 0, 1);
                const hMax = zone === 'downtown' ? 60 + 130 * Math.pow(n, 1.4) : 14 + 34 * n;
                const h = Math.max(8, rng.range(0.4, 1) * hMax);
                this._addBuilding(mb, group, f.px, f.py, f.z, f.th, w, depth, h, rng, side, zone === 'midtown' || (zone === 'downtown' && h < 70));
            }
            this.cursor[key] = s + (ok ? w : 6) + gap;
        }
    }

    // Box building with facade textures in metres; th = 2D heading of local X
    _addBuilding(mb, group, x, y, z, th, w, depth, h, rng, frontSide = 0, shops = false) {
        let style;
        if (h > 48) style = rng.chance(0.7) ? 'glass' : 'office';
        else if (h > 20) style = rng.pick(['office', 'stone', 'glass', 'brick']);
        else style = rng.pick(['brick', 'stone', 'brick', 'office']);
        const facade = mb.get(style), roof = mb.get('roof');
        const uS = 1 / (BAY * FACADE_BAYS), vS = 1 / (FLOOR * FACADE_FLOORS);
        const uOff = rng.int(0, 7) / FACADE_BAYS, vOff = 0;
        let base = z - 0.3;
        if (shops && frontSide && style !== 'glass') {
            // ground-floor storefronts with awnings
            const sh = 4.5;
            mb.get('shop').box(x, base, -y, w, sh, depth, th, { uScale: 1 / 16, vScale: 1 / 4.5, top: false, uOffset: rng.int(0, 3) / 4 });
            const lx = -Math.sin(th), ly = Math.cos(th);
            const ax = x - lx * frontSide * (depth / 2 + 0.9), ay = y - ly * frontSide * (depth / 2 + 0.9);
            if (rng.chance(0.7)) mb.get('awn' + rng.int(0, 3)).box(ax, base + 3.3, -ay, w * 0.85, 0.14, 1.8, th);
            base += sh;
            h -= sh;
        }
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
