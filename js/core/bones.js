// Skeleton helpers shared by the aiming pose (IK) and the ragdoll.
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qp = new THREE.Quaternion();
// Rotate `bone` (in world space) so the direction towards `child` matches `dir`.
export function pointBone(bone, child, dir) {
    bone.updateWorldMatrix(true, true);
    bone.getWorldPosition(_a); child.getWorldPosition(_b);
    _d.subVectors(_b, _a).normalize();
    _qa.setFromUnitVectors(_d, dir);
    bone.getWorldQuaternion(_qb);
    _qb.premultiply(_qa);
    bone.parent.getWorldQuaternion(_qp);
    bone.quaternion.copy(_qp.invert().multiply(_qb));
    bone.updateWorldMatrix(false, true);
}

// Two-bone IK: place `hand` at `target` bending the elbow downwards.
const _s = new THREE.Vector3(), _e = new THREE.Vector3(), _h = new THREE.Vector3(), _axis = new THREE.Vector3(), _dn = new THREE.Vector3(0, -1, 0);
export function twoBoneIK(upper, fore, hand, tgt) {
    const target = tgt.clone();   // pointBone() reuses the scratch vectors
    upper.updateWorldMatrix(true, true);
    upper.getWorldPosition(_s); fore.getWorldPosition(_e); hand.getWorldPosition(_h);
    const a = _s.distanceTo(_e), b = _e.distanceTo(_h);
    const toT = _c.subVectors(target, _s);
    const d = Math.min(toT.length(), a + b - 1e-3);
    toT.normalize();
    const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
    _axis.crossVectors(toT, _dn);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    const upDir = _d.copy(toT).applyAxisAngle(_axis, -Math.acos(cosA));
    pointBone(upper, fore, upDir.clone());
    fore.getWorldPosition(_e);
    pointBone(fore, hand, _c.subVectors(target, _e).normalize().clone());
}

