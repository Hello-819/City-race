// Procedural vehicle models + physics for the whole catalog (CONFIG.vehicles).
// Each body type is a handful of merged boxes per material (cheap: ~8 draw
// calls per car), shared between all cars of that type. The returned "rig" has
// the same shape as the glTF rigs from assets.js, so VehicleEntity can drive
// either kind. Front of every model = -Z, ground at y = 0.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { CARS, createCar } from '../assets.js';

// Body dimensions (m). cab = [front, rear] of the glass cabin as fractions of
// the length measured from the front; belt = height of the window line.
const BODIES = {
    compact: { L: 3.5, W: 1.66, H: 1.5, r: 0.29, wb: 2.3, cab: [0.3, 0.92], belt: 0.86 },
    hatch: { L: 3.95, W: 1.74, H: 1.46, r: 0.31, wb: 2.5, cab: [0.33, 0.93], belt: 0.85 },
    saloon: { L: 4.7, W: 1.82, H: 1.45, r: 0.33, wb: 2.8, cab: [0.33, 0.78], belt: 0.86 },
    estate: { L: 4.75, W: 1.82, H: 1.5, r: 0.33, wb: 2.8, cab: [0.33, 0.95], belt: 0.86 },
    coupe: { L: 4.5, W: 1.84, H: 1.3, r: 0.33, wb: 2.65, cab: [0.38, 0.76], belt: 0.8 },
    suv: { L: 4.8, W: 1.95, H: 1.8, r: 0.39, wb: 2.85, cab: [0.3, 0.94], belt: 1.1 },
    pickup: { L: 5.3, W: 1.95, H: 1.85, r: 0.4, wb: 3.3, cab: [0.3, 0.56], belt: 1.12, bed: true },
    van: { L: 5.2, W: 1.98, H: 2.35, r: 0.36, wb: 3.3, cab: [0.12, 0.3], belt: 1.15, box: [0.3, 1.0] },
    minivan: { L: 4.9, W: 1.9, H: 1.75, r: 0.34, wb: 2.95, cab: [0.22, 0.95], belt: 1.0 },
    boxtruck: { L: 7.2, W: 2.3, H: 3.3, r: 0.48, wb: 4.3, cab: [0.06, 0.24], belt: 1.4, box: [0.27, 1.0], cabH: 2.6 },
    bus: { L: 11.5, W: 2.5, H: 3.1, r: 0.5, wb: 6.6, cab: [0.03, 0.97], belt: 1.25, busWindows: true },
    limo: { L: 6.6, W: 1.9, H: 1.45, r: 0.34, wb: 4.5, cab: [0.3, 0.8], belt: 0.88 },
    classic: { L: 4.3, W: 1.75, H: 1.25, r: 0.36, wb: 2.6, cab: [0.5, 0.8], belt: 0.82, open: true, chrome: true },
};

const geoCache = new Map();
const shared = {};
function sharedMats() {
    if (shared.glass) return shared;
    shared.glass = new THREE.MeshPhysicalMaterial({ color: 0x10161c, metalness: 0.3, roughness: 0.05, transparent: true, opacity: 0.55, envMapIntensity: 1.5 });
    shared.trim = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.7, metalness: 0.2 });
    shared.chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
    shared.cargo = new THREE.MeshStandardMaterial({ color: 0xe6e6e2, roughness: 0.7 });
    shared.tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
    shared.hub = new THREE.MeshStandardMaterial({ color: 0xb0b4b8, roughness: 0.3, metalness: 0.8 });
    shared.taxiSign = new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0xffc400, emissiveIntensity: 0.6 });
    return shared;
}

// box helper: centre (x, y, z) in model space (front = -Z), size (w, h, l)
const B = (list, x, y, z, w, h, l) => { const g = new THREE.BoxGeometry(w, h, l); g.translate(x, y, z); list.push(g); };

function buildGeometry(body, livery) {
    const key = body + ':' + (livery || '');
    if (geoCache.has(key)) return geoCache.get(key);
    const d = BODIES[body];
    const P = { paint: [], glass: [], trim: [], head: [], tail: [], chrome: [], cargo: [], extra: [], red: [], blue: [] };
    const { L, W, H, r } = d;
    const zf = -L / 2;                       // front
    const zAt = (f) => zf + f * L;           // fraction from front -> z
    const base = r * 0.55, belt = d.belt;
    // lower body
    B(P.paint, 0, (base + belt) / 2, 0, W, belt - base, L);
    // bumpers
    B(d.chrome ? P.chrome : P.trim, 0, base + 0.12, zf - 0.04, W * 0.98, 0.22, 0.14);
    B(d.chrome ? P.chrome : P.trim, 0, base + 0.12, -zf + 0.04, W * 0.98, 0.22, 0.14);
    // wheel arches (dark) so the wheels read well
    for (const zc of [-d.wb / 2, d.wb / 2]) for (const s of [-1, 1]) B(P.trim, s * (W / 2 + 0.005), base + r * 0.35, zc, 0.02, r * 1.1, r * 2.2);
    const cabH = d.cabH || H;
    if (d.box) {
        // cab + cargo box (van / truck)
        const c0 = zAt(0), c1 = zAt(d.cab[1]);
        B(P.paint, 0, (belt + cabH) / 2, (zAt(d.cab[0]) + c1) / 2 + 0.05, W * 0.96, cabH - belt, c1 - zAt(d.cab[0]));
        B(P.glass, 0, (belt + cabH * 0.92) / 2 + 0.02, zAt(d.cab[0]) - 0.02, W * 0.9, cabH * 0.92 - belt - 0.1, 0.06);
        B(P.glass, 0, (belt + cabH * 0.92) / 2, (zAt(d.cab[0]) + c1) / 2, W * 0.97, cabH * 0.92 - belt - 0.15, (c1 - zAt(d.cab[0])) * 0.7);
        void c0;
        const b0 = zAt(d.box[0]), b1 = zAt(d.box[1]);
        B(body === 'van' ? P.paint : P.cargo, 0, (belt + H) / 2, (b0 + b1) / 2, W, H - belt, b1 - b0);
        if (body === 'boxtruck') B(P.paint, 0, belt - 0.05, (b0 + b1) / 2, W * 0.6, 0.1, b1 - b0);
    } else {
        const c0 = zAt(d.cab[0]), c1 = zAt(d.cab[1]);
        const roofT = 0.07;
        if (d.open) {
            // roadster: windscreen only
            B(P.glass, 0, belt + 0.22, c0 + 0.1, W * 0.86, 0.42, 0.05);
            B(P.trim, 0, belt + 0.02, (c0 + c1) / 2, W * 0.8, 0.06, c1 - c0);
        } else {
            B(P.glass, 0, (belt + H - roofT) / 2, (c0 + c1) / 2, W * 0.92, H - roofT - belt, c1 - c0);
            B(P.paint, 0, H - roofT / 2, (c0 + c1) / 2 + 0.04, W * 0.88, roofT, (c1 - c0) * 0.86);
            // pillars
            for (const s of [-1, 1]) {
                B(P.paint, s * W * 0.45, (belt + H) / 2, c0 + 0.08, 0.08, H - belt, 0.12);
                B(P.paint, s * W * 0.45, (belt + H) / 2, c1 - 0.08, 0.08, H - belt, 0.14);
            }
            if (d.busWindows) for (let z = c0 + 1; z < c1 - 0.5; z += 1.3) for (const s of [-1, 1]) B(P.paint, s * W * 0.465, (belt + H) / 2, z, 0.06, H - belt, 0.12);
        }
        if (d.bed) {
            const b0 = c1, b1 = -zf;
            for (const s of [-1, 1]) B(P.paint, s * (W / 2 - 0.05), belt + 0.22, (b0 + b1) / 2, 0.1, 0.44, b1 - b0);
            B(P.paint, 0, belt + 0.22, b1 - 0.05, W, 0.44, 0.1);
        }
    }
    // lights: heads at the front, tails at the back
    const lh = Math.min(belt - 0.12, base + 0.45);
    for (const s of [-1, 1]) {
        B(P.head, s * W * 0.34, lh, zf - 0.005, W * 0.2, 0.13, 0.04);
        B(P.tail, s * W * 0.37, lh + (d.box ? 0.2 : 0.05), -zf + 0.005, W * 0.16, 0.14, 0.04);
    }
    if (d.chrome) { B(P.chrome, 0, lh, zf - 0.02, W * 0.3, 0.25, 0.04); }
    // liveries
    if (livery === 'taxi') { B(P.extra, 0, H + 0.12, zAt(0.55), 0.6, 0.22, 0.25); B(P.trim, 0, (base + belt) / 2, 0, W + 0.01, 0.12, L * 0.6); }
    if (livery === 'police') {
        B(P.trim, 0, H + 0.04, zAt(0.52), 1.2, 0.08, 0.3);
        B(P.red, -0.33, H + 0.13, zAt(0.52), 0.5, 0.11, 0.24);
        B(P.blue, 0.33, H + 0.13, zAt(0.52), 0.5, 0.11, 0.24);
        B(P.trim, 0, (base + belt) / 2 + 0.05, -0.1, W + 0.01, (belt - base) * 0.55, L * 0.5);   // black doors
    }
    const out = {};
    for (const [k, list] of Object.entries(P)) if (list.length) out[k] = mergeGeometries(list.map(g => g.toNonIndexed()), false);
    out.dims = new THREE.Vector3(W, H, L);
    geoCache.set(key, out);
    return out;
}

const WHEEL_GEO = {};
function wheelGeo(r, w) {
    const k = r.toFixed(2) + w.toFixed(2);
    if (!WHEEL_GEO[k]) {
        const t = new THREE.CylinderGeometry(r, r, w, 16); t.rotateZ(Math.PI / 2);
        const h = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 10); h.rotateZ(Math.PI / 2);
        WHEEL_GEO[k] = { tyre: t, hub: h };
    }
    return WHEEL_GEO[k];
}

// Physics spec derived from horsepower and mass (based on the Concept GT).
function physicsFor(info, d) {
    const base = CARS.concept.physics;
    const hp = info.hp || 150, mass = info.mass || 1400;
    const scale = hp / 340;
    const heavy = mass > 3000;
    return {
        ...base,
        mass, inertia: mass * (d.L * d.L + d.W * d.W) / 12 * 0.9,
        a: d.wb * 0.48, b: d.wb * 0.52, cgHeight: d.H * 0.34,
        mu: heavy ? 0.95 : 1.05, frontGrip: 0.95,
        idle: 800, redline: heavy ? 3200 : 6500,
        torque: base.torque.map(([rpm, t]) => [rpm * (heavy ? 0.41 : 0.83), t * scale * (heavy ? 2.4 : 1.2)]),
        gears: heavy ? [6.5, 4.2, 2.8, 1.9, 1.35, 1.0] : base.gears, final: heavy ? 3.4 : base.final,
        cdA: d.W * d.H * 0.38, clA: 0.1, brake: heavy ? 0.7 : 1.0, maxSteer: d.L > 7 ? 0.62 : 0.6,
        cylinders: heavy ? 6 : 4, sound: 'i4',
    };
}

// Returns a rig compatible with assets.createCar rigs.
export function createVehicleRig(model, color = null) {
    const info = CONFIG.vehicles[model];
    if (!info) throw new Error('Unknown vehicle model ' + model);
    if (info.body === 'ferrari' || info.body === 'concept') {
        const rig = createCar(info.body, { lod: true, color: color || CARS[info.body].defaultColor });
        rig.model = model;
        return rig;
    }
    const d = BODIES[info.body];
    const geo = buildGeometry(info.body, info.livery);
    const S = sharedMats();
    const paintCol = info.livery === 'taxi' ? '#f2c40f' : info.livery === 'police' ? '#f4f4f4' : (color || '#888888');
    const paint = new THREE.MeshPhysicalMaterial({ color: paintCol, metalness: 0.45, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.1 });
    const head = new THREE.MeshStandardMaterial({ color: 0xd8dce0, emissive: 0xfff4e0, emissiveIntensity: 0 });
    const tail = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a10, emissiveIntensity: 0.3 });
    const red = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2020, emissiveIntensity: 0.2 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x000a55, emissive: 0x2050ff, emissiveIntensity: 0.2 });
    const mats = { paint: S.glass, glass: S.glass, trim: S.trim, head, tail, chrome: S.chrome, cargo: S.cargo, extra: S.taxiSign, red, blue };
    mats.paint = paint;
    const holder = new THREE.Group();
    const body = new THREE.Group();
    holder.add(body);
    for (const [k, g] of Object.entries(geo)) {
        if (k === 'dims') continue;
        const m = new THREE.Mesh(g, mats[k]);
        m.castShadow = k !== 'glass';
        body.add(m);
    }
    const wheels = [];
    const wg = wheelGeo(d.r, d.r > 0.45 ? 0.36 : 0.24);
    for (const [key, zc, xs] of [['fl', -d.wb / 2, -1], ['fr', -d.wb / 2, 1], ['rl', d.wb / 2, -1], ['rr', d.wb / 2, 1]]) {
        const center = new THREE.Vector3(xs * (d.W / 2 - 0.16), d.r, zc);
        const steer = new THREE.Group(); steer.position.copy(center);
        const spin = new THREE.Group(); steer.add(spin);
        const t = new THREE.Mesh(wg.tyre, S.tyre); t.castShadow = true;
        spin.add(t, new THREE.Mesh(wg.hub, S.hub));
        holder.add(steer);
        wheels.push({ key, steer, spin, front: key[0] === 'f', radius: d.r, center, left: xs < 0 });
    }
    // blob contact shadow
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(d.W * 1.2, d.L * 1.1), BLOB());
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.renderOrder = 2;
    holder.add(shadow);
    const spec = { id: model, name: info.name, physics: physicsFor(info, d) };
    return {
        id: model, model, spec, root: holder, body, wheels, steering: null, eye: null,
        mats: { paint: [paint], tail: [tail], head: [head] }, siren: info.livery === 'police' ? { red, blue } : null,
        dims: geo.dims.clone(), wheelbase: d.wb, track: d.W - 0.32, shadow, procedural: true,
        setColor(c) { paint.color.set(c); },
    };
}

let _blob = null;
function BLOB() {
    if (_blob) return _blob;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    _blob = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
    return _blob;
}

export const CIVILIAN_COLORS = ['#e9e9e7', '#c9cacc', '#1a1b1e', '#2a2c30', '#8b9097', '#5d636b', '#22355e', '#7d1418', '#3a4a3a', '#b9ab8e', '#4a5560', '#5a1e2e', '#2f5d8a', '#6b4a2a'];
export const RARE_COLORS = { sports: '#ff6a00', supercar: '#d4001a', classic: '#1f8f8a' };
