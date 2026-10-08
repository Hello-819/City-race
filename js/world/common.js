// Pieces shared by both environments: road surface, gantries, materials.
import * as THREE from 'three';
import { ribbon, GeoBuilder } from '../meshBuilder.js';
import { bannerTexture, roadTexture } from '../textures.js';

export const CHUNK_SAMPLES = 50;   // 100 m per chunk

export function roadSurface(road, i0, i1, kind) {
    const b = new GeoBuilder();
    const half = road.p.roadHalf;
    ribbon(b, road, i0, i1, -half, half, 0, 0, { vPeriod: 12 });
    return b;
}

export function roadMaterial(kind) {
    return new THREE.MeshStandardMaterial({ map: roadTexture(kind), roughness: 0.88, metalness: 0.0 });
}

// Gantry across the road (checkpoint / start line)
export function makeGantry(road, s, text, sub, color, span) {
    const g = new THREE.Group();
    const f = road.frameAt(s);
    g.position.set(f.x, f.z, -f.y);
    g.rotation.y = f.th - Math.PI / 2;   // local X across road
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.7, roughness: 0.4 });
    const h = 7.2;
    for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, 0.6), metal);
        pole.position.set(side * span, h / 2, 0);
        pole.castShadow = true;
        g.add(pole);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 1.6, 0.5), metal);
    beam.position.y = h; beam.castShadow = true;
    g.add(beam);
    const tex = bannerTexture(text, sub, color);
    const bannerMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.6 });
    for (const z of [0.27, -0.27]) {
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, 1.4), bannerMat);
        banner.position.set(0, h, z);
        if (z < 0) banner.rotation.y = Math.PI;
        g.add(banner);
    }
    return g;
}

// Instanced helper: returns an InstancedMesh with per-instance matrices
export function instanced(geometry, material, transforms, { castShadow = true, receiveShadow = false } = {}) {
    if (!transforms.length) return null;
    const m = new THREE.InstancedMesh(geometry, material, transforms.length);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    transforms.forEach((t, i) => {
        p.set(t.x, t.y, t.z);
        e.set(t.rx || 0, t.ry || 0, t.rz || 0);
        q.setFromEuler(e);
        sc.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1);
        mat.compose(p, q, sc);
        m.setMatrixAt(i, mat);
    });
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    m.computeBoundingSphere();
    return m;
}

export function mergeGeos(list) {
    // tiny merge for prop geometries (position/normal/uv, all non-indexed or indexed)
    const out = new GeoBuilder();
    for (const { geo, matrix } of list) {
        const g = geo.index ? geo.toNonIndexed() : geo;
        const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
        const v = new THREE.Vector3(), n = new THREE.Vector3();
        const nm = new THREE.Matrix3().getNormalMatrix(matrix);
        for (let i = 0; i < pos.count; i += 3) {
            const ids = [];
            for (let k = 0; k < 3; k++) {
                v.fromBufferAttribute(pos, i + k).applyMatrix4(matrix);
                n.fromBufferAttribute(nor, i + k).applyMatrix3(nm).normalize();
                ids.push(out.vertex(v.x, v.y, v.z, uv ? uv.getX(i + k) : 0, uv ? uv.getY(i + k) : 0, n.x, n.y, n.z));
            }
            out.tri(ids[0], ids[1], ids[2]);
        }
    }
    return out.build();
}

export const M4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
