// ============================================================================
// Ragdoll physics for any of the skinned characters.
//
// On death the animation stops and the body becomes a Verlet particle
// skeleton: one particle per major joint (hips, chest, head, shoulders,
// elbows, hands, knees, feet...), stick constraints between them (plus a few
// cross braces so the torso stays rigid), gravity, ground collision with
// friction, and an initial impulse from whatever killed them (bullet, car,
// explosion). Every frame the real bones are rotated to point along the
// simulated limbs, so the actual character mesh flops, tumbles and settles.
// The simulation goes to sleep once the body has come to rest.
// ============================================================================
import * as THREE from 'three';
import { pointBone } from '../core/bones.js';

// joint name -> bone key (keys as stored in person.bones, Mixamo style)
const JOINTS = ['Hips', 'Chest', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const STICKS = [
    ['Hips', 'Chest'], ['Chest', 'Head'],
    ['Chest', 'LeftArm'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
    ['Chest', 'RightArm'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
    ['Hips', 'LeftUpLeg'], ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'],
    ['Hips', 'RightUpLeg'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
    // braces: keep shoulders / hips / torso from collapsing
    ['LeftArm', 'RightArm'], ['LeftUpLeg', 'RightUpLeg'], ['LeftArm', 'Hips'], ['RightArm', 'Hips'],
    ['LeftUpLeg', 'Chest'], ['RightUpLeg', 'Chest'], ['Head', 'LeftArm'], ['Head', 'RightArm'],
];
// which bone is pointed at which joint each frame
const DRIVE = [
    ['Hips', 'Chest'], ['Chest', 'Head'],
    ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
    ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
];
const G = 9.81;
const _v = new THREE.Vector3(), _d = new THREE.Vector3();

export class Ragdoll {
    // person: from createPerson (needs .bones); impulse: three.js world vector (m/s)
    // groundAt(x, z) -> ground height at a three.js position
    // map (optional): anything with collidersNear() so limbs stop at walls
    constructor(person, impulse, groundAt, map = null) {
        this.map = map;
        this._cols = { boxes: [], circles: [] };
        this.person = person;
        this.groundAt = groundAt;
        this.bones = {};
        this.p = {};
        this.sleep = false;
        this.t = 0;
        const B = person.bones;
        const bone = (k) => B[k] || (k === 'Chest' ? (B.Spine2 || B.Spine1 || B.Spine) : null);
        person.root.updateMatrixWorld(true);
        for (const j of JOINTS) {
            const b = bone(j);
            if (!b) continue;
            this.bones[j] = b;
            const pos = b.getWorldPosition(new THREE.Vector3());
            // torso takes most of the hit, limbs flail a bit at random
            const k = j === 'Hips' || j === 'Chest' ? 1 : 0.7 + Math.random() * 0.5;
            const vel = impulse.clone().multiplyScalar(k).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 1.2, (Math.random() - 0.5) * 1.5));
            this.p[j] = { pos, prev: pos.clone().addScaledVector(vel, -1 / 60) };
        }
        this.sticks = STICKS.filter(([a, b]) => this.p[a] && this.p[b]).map(([a, b]) => [a, b, this.p[a].pos.distanceTo(this.p[b].pos)]);
        this.ok = !!(this.p.Hips && this.p.Chest);
    }

    update(dt) {
        if (!this.ok || this.sleep) return;
        dt = Math.min(dt, 1 / 30);
        this.t += dt;
        const P = this.p;
        let motion = 0;
        // integrate
        for (const q of Object.values(P)) {
            _v.subVectors(q.pos, q.prev).multiplyScalar(0.99);
            q.prev.copy(q.pos);
            q.pos.add(_v);
            q.pos.y -= G * dt * dt;
            motion += _v.lengthSq();
        }
        // walls near the body (fetched once per step)
        const boxes = this.map ? this.map.collidersNear(P.Hips.pos.x, -P.Hips.pos.z, 3, this._cols).boxes : [];
        // constraints + ground (several relaxation passes)
        for (let it = 0; it < 8; it++) {
            for (const [a, b, len] of this.sticks) {
                const pa = P[a].pos, pb = P[b].pos;
                _d.subVectors(pb, pa);
                const d = _d.length() || 1e-6;
                _d.multiplyScalar((d - len) / d * 0.5);
                pa.add(_d); pb.sub(_d);
            }
            for (const q of Object.values(P)) {
                const g = this.groundAt(q.pos.x, q.pos.z) + 0.07;
                // buildings: push the joint out through the nearest wall
                for (const b of boxes) {
                    const mx = q.pos.x, my = -q.pos.z;
                    if (mx <= b.x0 || mx >= b.x1 || my <= b.y0 || my >= b.y1) continue;
                    const o = [[mx - b.x0, -1, 0], [b.x1 - mx, 1, 0], [my - b.y0, 0, -1], [b.y1 - my, 0, 1]].sort((u, w) => u[0] - w[0])[0];
                    q.pos.x += o[1] * (o[0] + 0.02); q.pos.z -= o[2] * (o[0] + 0.02);
                    q.prev.x = q.pos.x; q.prev.z = q.pos.z;
                }
                if (q.pos.y < g) {
                    q.pos.y = g;
                    // friction: kill most horizontal motion on contact
                    q.prev.x = q.pos.x - (q.pos.x - q.prev.x) * 0.6;
                    q.prev.z = q.pos.z - (q.pos.z - q.prev.z) * 0.6;
                    if (q.prev.y < q.pos.y) q.prev.y = q.pos.y;
                }
            }
        }
        this._pose();
        if (this.t > 1.5 && motion < 1e-6) this.sleep = true;
        if (this.t > 8) this.sleep = true;
    }

    // Move the character so its hips sit on the hips particle, then point
    // every limb bone along its simulated segment.
    _pose() {
        const root = this.person.root, P = this.p, B = this.bones;
        root.updateMatrixWorld(true);
        B.Hips.getWorldPosition(_v);
        root.position.add(_d.subVectors(P.Hips.pos, _v));
        root.updateMatrixWorld(true);
        for (const [a, b] of DRIVE) {
            if (!B[a] || !B[b] || !P[a] || !P[b]) continue;
            _d.subVectors(P[b].pos, P[a].pos);
            if (_d.lengthSq() < 1e-8) continue;
            pointBone(B[a], B[b], _d.normalize().clone());
        }
    }

    // map-frame position of the body (for pickups, despawning...)
    get hips() { return this.p.Hips ? this.p.Hips.pos : null; }
}
