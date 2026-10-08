// Loads the glTF car models and turns them into drivable "rigs":
// normalised orientation (front = -Z, ground at y = 0), wheel pivots for spin and
// steering, a steering-wheel pivot for the cockpit view, and paint/light materials.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const CARS = {
    ferrari: {
        id: 'ferrari',
        name: 'Ferrari 458 Italia',
        blurb: 'Mid-engine V8, 570 hp, rear-wheel drive. Sharp, fast, demands respect.',
        file: 'assets/models/ferrari.glb',
        lod: 'assets/models/ferrari_lod.glb',
        ao: 'assets/models/ferrari_ao.png',
        wheels: { fl: 'wheel_fl', fr: 'wheel_fr', rl: 'wheel_rl', rr: 'wheel_rr' },
        steeringWheel: 'steering_wheel',
        paint: /^Body_Color$/,
        glass: /^Glass_Gray$/,
        tail: /^Taillight_Glass$/,
        head: /^Projector_Glass$/,
        hide: [],
        eye: { up: 0.04, back: 0.58 },
        defaultColor: '#b0101a',
        engine: 'rear',
        mirror: { pos: [-0.03, 1.16, -0.4], size: [0.21, 0.062], rot: [-0.1, -0.33, 0] },
        stats: { power: 0.95, speed: 0.95, handling: 0.8 },
        physics: {
            mass: 1480, inertia: 2350, a: 1.50, b: 1.15, cgHeight: 0.46,
            mu: 1.22, frontGrip: 0.95, csF: 18, csR: 24,
            idle: 1000, redline: 9000,
            torque: [[1000, 320], [2500, 410], [4000, 480], [6000, 540], [7500, 525], [8500, 480], [9000, 440]],
            gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], reverse: 2.9, final: 4.44, efficiency: 0.86,
            cdA: 0.78, clA: 0.8, brake: 1.25, maxSteer: 0.58, cylinders: 8, sound: 'v8',
        },
    },
    concept: {
        id: 'concept',
        name: 'Concept GT',
        blurb: 'Lightweight electric-styled grand tourer. Forgiving and agile.',
        file: 'assets/models/concept.glb',
        lod: 'assets/models/concept_lod.glb',
        ao: null,
        wheels: { fl: 'WheelFrontL', fr: 'WheelFrontR', rl: 'WheelRearL', rr: 'WheelRearR' },
        steeringWheel: 'InteriorSteeringCylinder',
        paint: /^Paint 1/,
        glass: /^Glass$/,
        tail: /^Brakelight$/,
        head: /^Headlight$/,
        hide: ['License Plate', 'InteriorSteeringEmblem'],
        eye: { pos: [0, 0.99, -0.3] },
        steeringAxis: [0, 0.4, 0.92],     // centre-seat layout; PCA on this node is unreliable
        defaultColor: '#1d5fd1',
        engine: 'front',
        stats: { power: 0.72, speed: 0.78, handling: 0.95 },
        physics: {
            mass: 1290, inertia: 1900, a: 1.40, b: 1.40, cgHeight: 0.48,
            mu: 1.18, frontGrip: 0.96, csF: 18, csR: 23,
            idle: 900, redline: 7800,
            torque: [[900, 300], [2000, 380], [3500, 430], [5500, 440], [7000, 400], [7800, 350]],
            gears: [3.25, 2.25, 1.68, 1.32, 1.06, 0.87], reverse: 3.0, final: 4.1, efficiency: 0.88,
            cdA: 0.72, clA: 0.55, brake: 1.15, maxSteer: 0.6, cylinders: 6, sound: 'v6',
        },
    },
};

export const PAINTS = ['#b0101a', '#f2b705', '#1d5fd1', '#111214', '#e8e8e6', '#1f7a3a', '#ff5a00', '#6b2fb3', '#8a8f96'];
export const TRAFFIC_PAINTS = ['#e9e9e7', '#d8d9db', '#1a1b1e', '#2a2c30', '#8b9097', '#5d636b', '#22355e', '#7d1418', '#3a4a3a', '#b9ab8e', '#f0c419', '#efefef', '#4a5560', '#5a1e2e'];

const loaded = {};
export const TRAFFIC_EXTRA = [];   // raw manifest entries from assets/models/traffic/manifest.json
const EXTRA_SPECS = {};            // id -> car spec for user-supplied traffic models
export const TRAFFIC_IDS = ['ferrari', 'concept'];
const specOf = (id) => CARS[id] || EXTRA_SPECS[id];

export async function loadAssets(onProgress) {
    const draco = new DRACOLoader();
    draco.setDecoderPath('vendor/three/examples/jsm/libs/draco/gltf/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const texLoader = new THREE.TextureLoader();

    const jobs = [];
    for (const car of Object.values(CARS)) {
        jobs.push(['model:' + car.id, car.file]);
        jobs.push(['lod:' + car.id, car.lod]);
        if (car.ao) jobs.push(['ao:' + car.id, car.ao]);
    }
    jobs.push(['person:michelle', 'assets/models/people/michelle.glb'], ['person:man', 'assets/models/people/man.glb'], ['anims', 'assets/models/people/anims.glb']);
    // optional user-supplied traffic cars: assets/models/traffic/manifest.json
    try {
        const res = await fetch('assets/models/traffic/manifest.json');
        if (res.ok) {
            const list = await res.json();
            for (const t of list) {
                TRAFFIC_EXTRA.push(t);
                jobs.push(['extra:' + t.file, 'assets/models/traffic/' + t.file]);
            }
        }
    } catch { /* no extra traffic models */ }
    let done = 0;
    const progress = new Map();
    const report = () => {
        let sum = 0; for (const v of progress.values()) sum += v;
        onProgress && onProgress(sum / jobs.length);
    };
    await Promise.all(jobs.map(([key, url]) => new Promise((resolve, reject) => {
        const onProg = (e) => { if (e.total) { progress.set(key, e.loaded / e.total); report(); } };
        const ok = (res) => { progress.set(key, 1); done++; report(); loaded[key] = res; resolve(); };
        if (key.startsWith('ao:')) texLoader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; ok(t); }, onProg, reject);
        else if (key === 'anims') loader.load(url, (g) => ok({ clips: g.animations, scene: g.scene }), onProg, reject);
        else if (key.startsWith('extra:')) loader.load(url, (g) => ok(g.scene), onProg, () => { progress.set(key, 1); resolve(); });
        else loader.load(url, (g) => ok(key.startsWith('lod:') ? bakeLod(g.scene, CARS[key.slice(4)]) : g.scene), onProg, reject);
    })));
    // register user-supplied traffic models
    for (const t of TRAFFIC_EXTRA) {
        const scene = loaded['extra:' + t.file];
        if (!scene || !t.wheels) continue;
        const id = 'x_' + t.file.replace(/\W/g, '_');
        const rx = (v, d) => new RegExp(v || d, 'i');
        EXTRA_SPECS[id] = {
            id, name: t.name || t.file, wheels: t.wheels, hide: t.hide || [],
            paint: rx(t.paint, 'paint|body|carpaint'), glass: rx(t.glass, 'glass|window'),
            tail: rx(t.tail, 'tail|brake|rear_?light'), head: rx(t.head, 'head_?light|headlight'),
            physics: CARS.concept.physics, eye: { up: 0.1, back: 0.5 }, defaultColor: '#888888',
        };
        loaded['model:' + id] = scene;
        try { loaded['lod:' + id] = bakeLod(scene.clone(true), EXTRA_SPECS[id]); TRAFFIC_IDS.push(id); }
        catch (e) { console.warn('Could not use traffic model', t.file, e); }
    }
}

// Merge a low-detail model into a handful of meshes so dozens of traffic cars stay
// cheap: paint / glass / lights keep their own materials (they change per car),
// everything else is baked into one vertex-coloured "trim" mesh per part.
function bakeLod(scene, spec) {
    scene.updateMatrixWorld(true);
    const wheelNodes = Object.values(spec.wheels).map(n => scene.getObjectByName(n)).filter(Boolean);
    const trim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35, name: 'lod_trim' });
    trim.userData.sharedTrim = true;
    const groups = new Map();   // owner -> Map(material -> geometries[])
    const meshes = [];
    scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const col = new THREE.Color();
    for (const m of meshes) {
        if (!m.visible || spec.hide.includes(m.name)) continue;
        let owner = scene, p = m.parent;
        while (p) { if (wheelNodes.includes(p)) { owner = p; break; } p = p.parent; }
        const inv = new THREE.Matrix4().copy(owner.matrixWorld).invert();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        // simplified meshes ship without normals: smooth them but keep hard creases
        if (!geo.attributes.normal) geo = toCreasedNormals(geo, Math.PI / 4.5);
        for (const name of Object.keys(geo.attributes)) if (!['position', 'normal'].includes(name)) geo.deleteAttribute(name);
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        const parts = mats.length > 1 && geo.groups.length ? geo.groups : [{ start: 0, count: geo.attributes.position.count, materialIndex: 0 }];
        for (const g of parts) {
            const src = mats[g.materialIndex] || mats[0];
            const nm = src.name || '';
            const keep = owner === scene && (spec.paint.test(nm) || spec.glass.test(nm) || spec.tail.test(nm) || spec.head.test(nm) || src.transmission > 0);
            const mat = keep ? src : trim;
            if (keep) {
                // merged geometry has no uvs: strip every texture from the kept material
                for (const k of Object.keys(src)) if (src[k] && src[k].isTexture) src[k] = null;
                src.needsUpdate = true;
            }
            const sub = parts.length > 1 ? sliceGeometry(geo, g.start, g.count) : geo.clone();
            sub.clearGroups();
            // bake the source colour so the shared trim material can draw it
            col.copy(src.color || col.set(0x888888));
            if (src.map && !keep) col.multiplyScalar(0.6);
            const n = sub.attributes.position.count;
            const ca = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) { ca[i * 3] = col.r; ca[i * 3 + 1] = col.g; ca[i * 3 + 2] = col.b; }
            sub.setAttribute('color', new THREE.BufferAttribute(ca, 3));
            if (!groups.has(owner)) groups.set(owner, new Map());
            const byMat = groups.get(owner);
            if (!byMat.has(mat)) byMat.set(mat, []);
            byMat.get(mat).push(sub);
        }
    }
    // replace original meshes with plain groups (they may parent other nodes, e.g. wheels)
    for (const m of meshes) {
        const parent = m.parent;
        if (!parent) continue;
        if (m.children.length) {
            const g = new THREE.Group();
            g.name = m.name;
            g.position.copy(m.position); g.quaternion.copy(m.quaternion); g.scale.copy(m.scale);
            while (m.children.length) g.add(m.children[0]);
            parent.add(g);
        }
        parent.remove(m);
    }
    scene.updateMatrixWorld(true);
    for (const [owner, byMat] of groups) {
        for (const [mat, geos] of byMat) {
            const merged = mergeGeometries(geos, false);
            if (!merged) continue;
            merged.computeBoundingSphere();
            merged.userData.shared = true;   // shared by every traffic clone: never dispose with a chunk
            const mesh = new THREE.Mesh(merged, mat);
            mesh.name = owner === scene ? 'body_' + mat.name : owner.name + '_' + mat.name;
            owner.add(mesh);
        }
    }
    return scene;
}

function sliceGeometry(geo, start, count) {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) {
        g.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize), attr.itemSize));
    }
    return g;
}

// ---------------------------------------------------------------------------
function makePaint(src, color) {
    const p = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(p, src);
    p.color.set(color);
    p.map = null;
    p.metalness = 0.55;
    p.roughness = 0.28;
    p.clearcoat = 1.0;
    p.clearcoatRoughness = 0.04;
    p.envMapIntensity = 1.2;
    p.name = 'paint';
    return p;
}

function makeGlass() {
    return new THREE.MeshPhysicalMaterial({
        color: 0x0c1014, metalness: 0.2, roughness: 0.02, transparent: true, opacity: 0.32,
        envMapIntensity: 1.6, depthWrite: false, name: 'glass',
    });
}

function eigenSmallest(points, center) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of points) {
        const d = [p.x - center.x, p.y - center.y, p.z - center.z];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
    }
    const mul = (M, v) => [0, 1, 2].map(i => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
    const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
    let v = [0.3, 0.5, 0.8];
    for (let k = 0; k < 60; k++) v = norm(mul(C, v));
    const lmax = Math.hypot(...mul(C, v));
    const M = C.map((row, i) => row.map((x, j) => (i === j ? lmax : 0) - x));
    let w = [0.6, 0.3, 0.7];
    for (let k = 0; k < 200; k++) w = norm(mul(M, w));
    return new THREE.Vector3(...w);
}

function collectPoints(obj, root, max = 4000) {
    const pts = [];
    const v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    obj.traverse((o) => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        const step = Math.max(1, Math.floor(pos.count / max));
        const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
        for (let i = 0; i < pos.count; i += step) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
    });
    return pts;
}

function boxIn(obj, root) {
    const box = new THREE.Box3();
    for (const p of collectPoints(obj, root, 1500)) box.expandByPoint(p);
    return box;
}

let blobTexture = null;
function getBlobTexture() {
    if (blobTexture) return blobTexture;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 128, 256);
    ctx.filter = 'blur(14px)';
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.roundRect(26, 30, 76, 196, 30);
    ctx.fill();
    blobTexture = new THREE.CanvasTexture(c);
    blobTexture.colorSpace = THREE.SRGBColorSpace;
    return blobTexture;
}

// Build a rig from a loaded scene. `lod` = cheap traffic version.
export function createCar(id, { lod = false, color = null } = {}) {
    const spec = specOf(id);
    const src = loaded[(lod ? 'lod:' : 'model:') + id];
    const scene = src.clone(true);
    const holder = new THREE.Group();
    const body = new THREE.Group();     // visual body (gets pitch / roll)
    const inner = new THREE.Group();
    holder.add(body); body.add(inner); inner.add(scene);
    holder.name = spec.name;

    for (const n of spec.hide) { const o = scene.getObjectByName(n); if (o) o.visible = false; }

    // --- materials ---
    const mats = { paint: [], tail: [], head: [] };
    const paintColor = color || spec.defaultColor;
    const shared = new Map();
    scene.traverse((o) => {
        if (!o.isMesh) return;
        if (lod && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.castShadow = true;
        o.receiveShadow = !lod;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        const out = list.map((m) => {
            if (shared.has(m)) return shared.get(m);
            let r = m;
            const nm = m.name || '';
            if (spec.paint.test(nm)) { r = makePaint(m, paintColor); mats.paint.push(r); }
            else if (spec.glass.test(nm)) r = makeGlass();
            else if (spec.tail.test(nm)) {
                r = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a10, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.1, name: 'tail' });
                mats.tail.push(r);
            } else if (spec.head.test(nm)) {
                r = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, emissive: 0xfff4e0, emissiveIntensity: 0, roughness: 0.05, metalness: 0.6, name: 'head' });
                mats.head.push(r);
            } else if (m.transmission > 0) {
                r = makeGlass();
            } else if (!lod && /leather|interior|carpet|plastic|dashboard|panel|floormat/i.test(nm)) {
                r = m.clone();
                r.color.multiplyScalar(0.55);
                r.envMapIntensity = 0.35;
                r.roughness = Math.max(r.roughness, 0.6);
            } else if (lod) {
                r = m.userData.sharedTrim ? m : m.clone();
            }
            if (r.isMeshStandardMaterial && r !== m && !mats.paint.includes(r)) r.envMapIntensity = r.envMapIntensity ?? 1;
            shared.set(m, r);
            return r;
        });
        o.material = Array.isArray(o.material) ? out : out[0];
    });

    // --- orientation: front = -Z ---
    holder.updateMatrixWorld(true);
    const wheelBoxes = {};
    for (const [k, name] of Object.entries(spec.wheels)) {
        const node = scene.getObjectByName(name);
        wheelBoxes[k] = node ? boxIn(node, holder) : null;
    }
    const ctr = (k) => wheelBoxes[k].getCenter(new THREE.Vector3());
    const front = ctr('fl').add(ctr('fr')).multiplyScalar(0.5);
    const rear = ctr('rl').add(ctr('rr')).multiplyScalar(0.5);
    const fwd = front.clone().sub(rear);
    inner.rotation.y = Math.PI - Math.atan2(fwd.x, fwd.z);
    holder.updateMatrixWorld(true);

    // centre on wheels, wheel bottoms on the ground
    const wb = {}; let minY = Infinity; const all = new THREE.Box3();
    for (const [k, name] of Object.entries(spec.wheels)) {
        wb[k] = boxIn(scene.getObjectByName(name), holder);
        minY = Math.min(minY, wb[k].min.y);
        all.union(wb[k]);
    }
    const c = all.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -minY, -c.z);
    holder.updateMatrixWorld(true);

    // --- wheel pivots ---
    const wheels = [];
    for (const [k, name] of Object.entries(spec.wheels)) {
        const node = scene.getObjectByName(name);
        const box = boxIn(node, holder);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const steer = new THREE.Group();
        steer.position.copy(center);
        body.add(steer);
        const spin = new THREE.Group();
        steer.add(spin);
        holder.updateMatrixWorld(true);
        spin.attach(node);
        wheels.push({ key: k, steer, spin, front: k[0] === 'f', radius: size.y / 2, center, left: center.x < 0 });
    }
    // wheels move with suspension, not the body: re-parent pivots to holder
    for (const w of wheels) holder.attach(w.steer);

    const bodyBox = boxIn(scene, holder);
    const dims = bodyBox.getSize(new THREE.Vector3());
    const wheelbase = Math.abs(wheels.find(w => w.key === 'fl').center.z - wheels.find(w => w.key === 'rl').center.z);
    const track = Math.abs(wheels.find(w => w.key === 'fl').center.x - wheels.find(w => w.key === 'fr').center.x);

    // --- steering wheel + driver eye (full model only) ---
    let steering = null, eye = null;
    if (!lod && spec.steeringWheel) {
        const node = scene.getObjectByName(spec.steeringWheel);
        if (node) {
            const pts = collectPoints(node, holder);
            const box = new THREE.Box3().setFromPoints(pts);
            const center = box.getCenter(new THREE.Vector3());
            const axis = spec.steeringAxis ? new THREE.Vector3(...spec.steeringAxis).normalize() : eigenSmallest(pts, center);
            if (axis.z < 0) axis.negate();      // point towards the driver (rear)
            const pivot = new THREE.Group();
            pivot.position.copy(center);
            body.add(pivot);
            holder.updateMatrixWorld(true);
            pivot.attach(node);
            steering = { pivot, axis, base: pivot.quaternion.clone() };
            eye = spec.eye.pos ? new THREE.Vector3(...spec.eye.pos)
                : center.clone().addScaledVector(axis, spec.eye.back).add(new THREE.Vector3(0, spec.eye.up, 0));
        }
    }

    // --- contact shadow ---
    let shadowTex, sw, sl;
    if (!lod && spec.ao && loaded['ao:' + id]) { shadowTex = loaded['ao:' + id]; sw = 0.655 * 4; sl = 1.3 * 4; }
    else { shadowTex = getBlobTexture(); sw = dims.x * 1.25; sl = dims.z * 1.15; }
    const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(sw, sl),
        new THREE.MeshBasicMaterial({ map: shadowTex, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, depthWrite: false, premultipliedAlpha: true }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.renderOrder = 2;
    holder.add(shadow);

    return {
        id, spec, root: holder, body, wheels, steering, eye, mats, dims, wheelbase, track, shadow,
        setColor(col) { for (const m of mats.paint) m.color.set(col); },
    };
}


// ---------------------------------------------------------------------------
// Pedestrians: skinned humans sharing Mixamo walk / run / idle clips.
// Retarget the Mixamo clips onto each character in world space, so different
// rest poses (T-pose vs A-pose, rotated armatures) still produce a clean walk.
const clipCache = {};
const boneKey = (n) => n.replace('mixamorig', '').replace(':', '');
// Bone world rotations in the reference pose. Target: the skin bind pose (what
// the mesh looks like undeformed). Source: its TPose clip.
function skeletonInfo(root, tposeClip) {
    root.updateMatrixWorld(true);
    const info = new Map();
    const bind = new Map();
    root.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        o.skeleton.bones.forEach((b, i) => {
            if (bind.has(b)) return;
            const m = new THREE.Matrix4().multiplyMatrices(o.bindMatrix, new THREE.Matrix4().copy(o.skeleton.boneInverses[i]).invert());
            bind.set(b, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)));
        });
    });
    const tpose = new Map();
    if (tposeClip) for (const t of tposeClip.tracks) if (t.name.endsWith('.quaternion')) tpose.set(boneKey(t.name.slice(0, -11)), new THREE.Quaternion().fromArray(t.values, 0));
    const bones = [];
    root.traverse((o) => { if (o.isBone) bones.push(o); });
    for (const o of bones) {
        const parent = o.parent && o.parent.isBone ? boneKey(o.parent.name) : null;
        const parentWorldRest = o.parent && !o.parent.isBone ? o.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        info.set(boneKey(o.name), { name: o.name, parent, parentWorldRest, armatureWorld: parentWorldRest.clone(), node: o });
    }
    // world reference rotations
    const world = (key) => {
        const b = info.get(key);
        if (b.worldRest) return b.worldRest;
        if (tposeClip) {
            const pw = b.parent && info.has(b.parent) ? world(b.parent) : b.parentWorldRest;
            b.worldRest = pw.clone().multiply(tpose.get(key) || b.node.quaternion);
        } else {
            b.worldRest = bind.get(b.node) || b.node.getWorldQuaternion(new THREE.Quaternion());
        }
        // parent world for bones whose parent is bone: filled by world(parent)
        return b.worldRest;
    };
    for (const k of info.keys()) world(k);
    for (const b of info.values()) if (b.parent && info.has(b.parent)) b.parentWorldRest = info.get(b.parent).worldRest;
    return info;
}
function personClips(kind) {
    if (clipCache[kind]) return clipCache[kind];
    const src = loaded.anims;
    const S = skeletonInfo(src.scene, src.clips.find(c => c.name === 'TPose'));
    const T = skeletonInfo(loaded['person:' + kind]);
    // bones in hierarchy order (parents first)
    const order = [];
    const visit = (key) => { if (order.includes(key)) return; const b = T.get(key); if (b.parent && T.has(b.parent)) visit(b.parent); order.push(key); };
    for (const k of T.keys()) visit(k);
    // the two rigs may face different directions: find the yaw between them from the left arm
    const leftDir = (info) => { const v = new THREE.Vector3(0, 1, 0).applyQuaternion(info.get('LeftArm').worldRest); v.y = 0; return v.normalize(); };
    const ls = leftDir(S), lt = leftDir(T);
    const yaw = Math.atan2(ls.x, ls.z) - Math.atan2(lt.x, lt.z);
    const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), Rinv = R.clone().invert();
    const out = {};
    for (const clip of src.clips) {
        if (clip.name === 'TPose') continue;
        const interps = new Map();
        for (const t of clip.tracks) if (t.name.endsWith('.quaternion')) interps.set(boneKey(t.name.slice(0, -11)), t.createInterpolant());
        const fps = 30, frames = Math.max(2, Math.round(clip.duration * fps) + 1);
        const times = new Float32Array(frames);
        const values = new Map(order.map(k => [k, new Float32Array(frames * 4)]));
        const srcWorld = new Map(), tgtWorld = new Map();
        const q = new THREE.Quaternion(), d = new THREE.Quaternion(), inv = new THREE.Quaternion();
        for (let f = 0; f < frames; f++) {
            const time = Math.min(clip.duration, f / fps);
            times[f] = time;
            srcWorld.clear(); tgtWorld.clear();
            // source world rotations
            const srcW = (key) => {
                if (srcWorld.has(key)) return srcWorld.get(key);
                const b = S.get(key);
                const parentW = b.parent && S.has(b.parent) ? srcW(b.parent) : b.armatureWorld;
                const local = interps.has(key) ? new THREE.Quaternion().fromArray(interps.get(key).evaluate(time)) : null;
                const w = local ? parentW.clone().multiply(local) : b.worldRest.clone();
                srcWorld.set(key, w);
                return w;
            };
            for (const key of order) {
                const tb = T.get(key);
                let w;
                if (S.has(key)) {
                    // world delta from rest, applied to the target rest
                    d.copy(srcW(key)).multiply(inv.copy(S.get(key).worldRest).invert());
                    d.premultiply(R).multiply(Rinv);    // express the delta in the target's facing
                    w = d.clone().multiply(tb.worldRest);
                } else {
                    const pw = tb.parent && tgtWorld.has(tb.parent) ? tgtWorld.get(tb.parent) : tb.parentWorldRest;
                    w = pw.clone().multiply(inv.copy(tb.parentWorldRest).invert().multiply(tb.worldRest));
                }
                tgtWorld.set(key, w);
                const pw = tb.parent && tgtWorld.has(tb.parent) ? tgtWorld.get(tb.parent) : tb.armatureWorld;
                q.copy(pw).invert().multiply(w);
                q.toArray(values.get(key), f * 4);
            }
        }
        const tracks = order.filter(k => S.has(k)).map(k => new THREE.QuaternionKeyframeTrack(T.get(k).name + '.quaternion', times, values.get(k)));
        out[clip.name] = new THREE.AnimationClip(clip.name, clip.duration, tracks);
    }
    clipCache[kind] = out;
    return out;
}

const OUTFIT = ['#2b3a55', '#5a2b2b', '#2f4a32', '#6b6b6b', '#1f1f22', '#7a5a3a', '#3b5d8a', '#8a3b5d', '#c9b48a', '#e0e0e0', '#4a3b6b'];

export function createPerson(rng) {
    const kind = rng.chance(0.5) ? 'michelle' : 'man';
    const src = loaded['person:' + kind];
    const model = cloneSkinned(src);
    const root = new THREE.Group();
    root.add(model);
    // normalise height to ~1.6-1.85 m
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    const target = (kind === 'michelle' ? 1.68 : 1.8) * rng.range(0.94, 1.05);
    const sc = target / (h || 1);
    model.scale.multiplyScalar(sc);
    model.position.y = -box.min.y * sc;
    model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;
        const tint = (m) => {
            const c = m.clone();
            if (kind === 'man' && /Outfit_(Top|Bottom)/.test(m.name)) {
                // recolour clothing: keep the texture's shading, replace its hue
                c.color.set(rng.pick(OUTFIT)).multiplyScalar(1.5);
                c.onBeforeCompile = (sh) => {
                    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
                        '#include <map_fragment>\n diffuseColor.rgb = diffuse * vec3(dot(diffuseColor.rgb / max(diffuse, vec3(0.001)), vec3(0.299, 0.587, 0.114))) * 1.6;');
                };
                c.customProgramCacheKey = () => 'outfit';
            }
            else if (kind === 'michelle') c.color.multiplyScalar(rng.range(0.75, 1.05));
            return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
    });
    const mixer = new THREE.AnimationMixer(model);
    const set = personClips(kind);
    const actions = {};
    for (const name of ['Idle', 'Walk', 'Run']) {
        actions[name] = mixer.clipAction(set[name]);
        actions[name].play();
        actions[name].setEffectiveWeight(name === 'Walk' ? 1 : 0);
    }
    actions.Walk.time = rng.range(0, 1);
    return { root, model, mixer, actions, kind };
}
