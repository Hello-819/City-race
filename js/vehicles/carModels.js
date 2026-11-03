// Vehicle models for the whole catalog (CONFIG.vehicles).
//
// Bodies are real 3D models: Kenney's "Car Kit" (CC0) for everyday traffic,
// plus the Ferrari 458 and Concept GT glTFs for the rarest cars. Kenney
// models are scaled to real-world size (assets.js) and get:
//   - see-through tinted glass with a modelled interior behind it (seats,
//     dashboard, steering wheel, door cards, floor) and a seated driver figure
//     shown whenever someone is driving,
//   - a cockpit camera position (driver's eye) and a turning steering wheel,
//   - physics derived from the catalog's horsepower / mass and the model's
//     real wheelbase.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { CARS, createCar } from '../assets.js';

const specCache = new Map();
let M = null;
function mats() {
    if (M) return M;
    M = {
        seat: new THREE.MeshStandardMaterial({ color: 0x2a2624, roughness: 0.85 }),
        seatAccent: new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.8 }),
        dash: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.6 }),
        trim: new THREE.MeshStandardMaterial({ color: 0x302e2c, roughness: 0.9, side: THREE.DoubleSide }),
        wheel: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }),
        gauge: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x66ccff, emissiveIntensity: 0.6 }),
        skin: new THREE.MeshStandardMaterial({ color: 0xc8956d, roughness: 0.7 }),
        shirt: new THREE.MeshStandardMaterial({ color: 0x3b4a66, roughness: 0.8 }),
    };
    return M;
}

// Physics spec derived from horsepower, mass and the model's real size.
export function physicsFor(info, d) {
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
        cylinders: heavy ? 6 : hp > 300 ? 8 : 4, sound: 'i4',
    };
}

// Interior + driver figure inside the glass of a Kenney body.
function addInterior(rig) {
    const m = mats();
    rig.root.updateMatrixWorld(true);
    // cabin = bounding box of the window meshes (holder space, front = -Z)
    const cab = new THREE.Box3();
    // (window meshes share the body's vertex buffer, so walk only their indices)
    const v = new THREE.Vector3();
    rig.root.traverse((o) => {
        if (!o.isMesh || !o.material || o.material.name !== 'glass') return;
        const pos = o.geometry.attributes.position, idx = o.geometry.index;
        const n = idx ? idx.count : pos.count;
        for (let i = 0; i < n; i++) cab.expandByPoint(v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld));
    });
    if (cab.isEmpty()) return;
    const W = cab.max.x - cab.min.x, L = cab.max.z - cab.min.z;
    const belt = cab.min.y, roof = cab.max.y;
    const floor = Math.max(rig.wheels[0].radius * 0.9, belt - 0.75);
    const g = new THREE.Group();
    g.name = 'interior';
    const box = (w, h, d, x, y, z, mat) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); g.add(b); return b; };
    const zf = cab.min.z, cx = (cab.min.x + cab.max.x) / 2;
    // floor tub and door cards
    box(W * 0.94, 0.04, L * 0.95, cx, floor, (cab.min.z + cab.max.z) / 2, m.trim);
    for (const s of [-1, 1]) box(0.03, belt - floor + 0.05, L * 0.9, cx + s * W * 0.46, (belt + floor) / 2, (cab.min.z + cab.max.z) / 2, m.trim);
    // dashboard + gauges
    const dashZ = zf + Math.min(0.35, L * 0.12);
    box(W * 0.92, 0.22, 0.4, cx, belt - 0.05, dashZ, m.dash);
    const driverX = cx - W * 0.24;
    box(0.28, 0.08, 0.02, driverX, belt + 0.04, dashZ + 0.19, m.gauge);
    // steering wheel (pivot so it can turn)
    const pivot = new THREE.Group();
    pivot.position.set(driverX, belt + 0.02, dashZ + 0.32);
    pivot.rotation.x = -0.45;
    const spin = new THREE.Group();          // turns with the steering, inside the tilted pivot
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 6, 16), m.wheel);
    spin.add(ring, new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.02), m.wheel));
    pivot.add(spin);
    g.add(pivot);
    // seats: two in front, a bench behind if there is room
    const seatZ = dashZ + Math.min(0.95, L * 0.4);
    const seat = (x, z, w, back = 0.6) => {
        box(w, 0.14, 0.5, x, floor + 0.32, z, m.seat);
        box(w, back, 0.12, x, floor + 0.35 + back / 2, z + 0.28, m.seatAccent).rotation.x = -0.12;
        if (back > 0.5) box(w * 0.5, 0.16, 0.1, x, floor + 0.42 + back, z + 0.31, m.seat);
    };
    seat(driverX, seatZ, Math.min(0.5, W * 0.4));
    seat(cx + W * 0.24, seatZ, Math.min(0.5, W * 0.4));
    // rear bench only where the cabin is long enough to hold it
    if (seatZ + 1.35 < cab.max.z) seat(cx, seatZ + 0.95, W * 0.86, 0.42);
    // seated driver figure (visible whenever someone is at the wheel)
    const driver = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.55, 0.24), m.shirt);
    torso.position.set(0, floor + 0.68, seatZ + 0.08);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), m.skin);
    head.position.set(0, floor + 1.08, seatZ + 0.04);
    driver.add(torso, head);
    driver.position.x = driverX;
    driver.visible = false;
    g.add(driver);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    rig.body.add(g);
    rig.driverFigure = driver;
    rig.steering = { pivot: spin, axis: new THREE.Vector3(0, 0, 1) };
    rig.eye = new THREE.Vector3(driverX, Math.min(roof - 0.12, floor + 1.12), seatZ + 0.05);
}

// Returns a rig (same shape as assets.createCar rigs) for a catalog model.
export function createVehicleRig(model, color = null) {
    const info = CONFIG.vehicles[model];
    if (!info) throw new Error('Unknown vehicle model ' + model);
    if (info.body === 'ferrari' || info.body === 'concept') {
        const rig = createCar(info.body, { lod: true, color: color || CARS[info.body].defaultColor });
        rig.model = model;
        return rig;
    }
    const id = 'k_' + info.body;
    const rig = createCar(id, {
        lod: true,
        color: info.fixedColor ? null : color,
        paintOnly: info.paintMaterial ? new RegExp('^' + info.paintMaterial + '$') : null,
    });
    rig.model = model;
    // physics from the catalog + the model's real dimensions
    if (!specCache.has(model)) {
        const d = { L: rig.dims.z, W: rig.dims.x, H: rig.dims.y, wb: rig.wheelbase };
        specCache.set(model, { ...rig.spec, id: model, name: info.name, physics: physicsFor(info, d) });
    }
    rig.spec = specCache.get(model);
    addInterior(rig);
    if (rig.mats.siren.length) rig.siren = { lights: rig.mats.siren, tail: rig.mats.tail };
    if (info.fixedColor) rig.setColor = () => {};
    return rig;
}

export const CIVILIAN_COLORS = ['#e9e9e7', '#c9cacc', '#1a1b1e', '#2a2c30', '#8b9097', '#5d636b', '#22355e', '#7d1418', '#3a4a3a', '#b9ab8e', '#4a5560', '#5a1e2e', '#2f5d8a', '#6b4a2a'];
export const RARE_COLORS = { sports: '#ff6a00', supercar: '#d4001a', classic: '#1f8f8a', prototype: '#8e24aa' };
