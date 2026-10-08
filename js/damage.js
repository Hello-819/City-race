// Visual damage: dents the actual car body mesh around an impact point.
import * as THREE from 'three';

export class Deformer {
    constructor(rig) {
        this.parts = [];
        const skip = new Set();
        for (const w of rig.wheels) w.steer.traverse(o => skip.add(o));
        if (rig.steering) rig.steering.pivot.traverse(o => skip.add(o));
        rig.root.updateMatrixWorld(true);
        const bodyInv = new THREE.Matrix4().copy(rig.body.matrixWorld).invert();
        rig.body.traverse((o) => {
            if (!o.isMesh || skip.has(o) || !o.geometry.attributes.position) return;
            o.geometry = o.geometry.clone();          // own copy: other cars share the original
            const M = new THREE.Matrix4().multiplyMatrices(bodyInv, o.matrixWorld);
            const Minv = M.clone().invert();
            o.geometry.computeBoundingSphere();
            const sphere = o.geometry.boundingSphere.clone().applyMatrix4(M);
            this.parts.push({ mesh: o, M, Minv, sphere });
        });
        this.p = new THREE.Vector3(); this.d = new THREE.Vector3(); this.v = new THREE.Vector3();
    }

    // point & dir in body space; dir points into the car
    dent(point, dir, depth, radius) {
        for (const part of this.parts) {
            if (part.sphere.center.distanceTo(point) > part.sphere.radius + radius) continue;
            const lp = this.p.copy(point).applyMatrix4(part.Minv);
            const ld = this.d.copy(dir).transformDirection(part.Minv);
            // local radius / depth scale (meshes may be scaled)
            const scale = new THREE.Vector3().setFromMatrixScale(part.Minv).x;
            const r = radius * scale, dd = depth * scale;
            const pos = part.mesh.geometry.attributes.position;
            let touched = false;
            for (let i = 0; i < pos.count; i++) {
                const x = pos.getX(i) - lp.x, y = pos.getY(i) - lp.y, z = pos.getZ(i) - lp.z;
                const d2 = x * x + y * y + z * z;
                if (d2 > r * r) continue;
                const f = 1 - Math.sqrt(d2) / r;
                const k = dd * f * f * (0.7 + 0.3 * Math.sin(i * 12.9898));
                pos.setXYZ(i, pos.getX(i) + ld.x * k, pos.getY(i) + ld.y * k, pos.getZ(i) + ld.z * k);
                touched = true;
            }
            if (touched) {
                pos.needsUpdate = true;
                part.mesh.geometry.computeVertexNormals();
            }
        }
    }
}
