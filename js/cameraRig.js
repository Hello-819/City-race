// Camera modes: chase, far chase, cockpit (interior), hood and bumper.
import * as THREE from 'three';
import { clamp, damp } from './core/rng.js';

export const CAMERA_MODES = [
    { id: 'chase', label: 'Chase cam' },
    { id: 'far', label: 'Far chase cam' },
    { id: 'cockpit', label: 'Cockpit view' },
    { id: 'hood', label: 'Hood cam' },
    { id: 'bumper', label: 'Bumper cam' },
];

export class CameraRig {
    constructor(camera) {
        this.camera = camera;
        this.mode = 0;
        this.pos = new THREE.Vector3();
        this.look = new THREE.Vector3();
        this.vel = new THREE.Vector3();
        this.shake = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.initialized = false;
        this.tmp = new THREE.Vector3();
        this.tmp2 = new THREE.Vector3();
        this.q = new THREE.Quaternion();
        this.yawSmooth = 0;
    }

    get current() { return CAMERA_MODES[this.mode].id; }
    get inside() { return this.current === 'cockpit'; }
    cycle() { this.mode = (this.mode + 1) % CAMERA_MODES.length; this.initialized = false; return CAMERA_MODES[this.mode].label; }

    reset() { this.initialized = false; }

    // rig: car rig (root & body Object3D); veh: Vehicle (for speed / heading)
    update(dt, rig, veh, input) {
        const cam = this.camera;
        const speed = veh.speed;
        const lookBack = input.down('KeyB', 'PadLook');
        const mode = this.current;
        const body = rig.body;
        rig.root.updateMatrixWorld(true);

        let fov = 60;
        if (mode === 'chase' || mode === 'far') {
            const dist = mode === 'chase' ? 6.2 : 9.5;
            const height = mode === 'chase' ? 1.95 : 3.1;
            // follow heading of the velocity a little (shows slides), smoothed
            const carYaw = veh.th;
            let velYaw = Math.atan2(veh.vy, veh.vx);
            let diff = velYaw - carYaw;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            if (speed < 3 || veh.forwardSpeed < 0) diff = 0;
            const targetYaw = carYaw + clamp(diff, -0.5, 0.5) * 0.45 + (lookBack ? Math.PI : 0) + input.lookX;
            if (!this.initialized) this.yawSmooth = targetYaw;
            let dy = targetYaw - this.yawSmooth; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
            this.yawSmooth += dy * (lookBack ? 1 : 1 - Math.exp(-6 * dt));
            const yaw = this.yawSmooth;
            const ox = -Math.cos(yaw) * dist, oy = -Math.sin(yaw) * dist;
            const target = this.tmp.set(rig.root.position.x + ox, rig.root.position.y + height, rig.root.position.z - oy);
            const lookAt = this.tmp2.set(rig.root.position.x + Math.cos(yaw) * 4, rig.root.position.y + 1.0, rig.root.position.z - Math.sin(yaw) * 4);
            if (!this.initialized) { this.pos.copy(target); this.look.copy(lookAt); this.initialized = true; }
            // height follows quickly (hills), lateral spring
            this.pos.x = damp(this.pos.x, target.x, 14, dt);
            this.pos.z = damp(this.pos.z, target.z, 14, dt);
            this.pos.y = damp(this.pos.y, target.y, 10, dt);
            this.look.lerp(lookAt, 1 - Math.exp(-20 * dt));
            cam.position.copy(this.pos);
            cam.up.set(0, 1, 0);
            cam.lookAt(this.look);
            fov = 58 + clamp(speed * 0.28, 0, 22);
            cam.near = 0.1;
        } else {
            // attached views: compose in body space
            let local;
            if (mode === 'cockpit') local = rig.eye ? rig.eye.clone() : new THREE.Vector3(-0.35, 1.05, 0.1);
            else if (mode === 'hood') local = new THREE.Vector3(0, rig.dims.y * 0.8, -rig.dims.z * 0.3);
            else local = new THREE.Vector3(0, 0.55, -rig.dims.z / 2 - 0.05);
            // head motion: lean against lateral g, look into corners
            const lean = clamp(-veh.ay * 0.004, -0.04, 0.04);
            if (mode === 'cockpit') local.x += lean;
            const intoCorner = clamp(-veh.steer * 0.6, -0.35, 0.35);
            this.headYaw = damp(this.headYaw, (lookBack ? Math.PI * 0.95 : 0) + input.lookX + (mode === 'cockpit' ? intoCorner * 0.6 : 0), lookBack ? 30 : 6, dt);
            this.headPitch = damp(this.headPitch, -input.lookY - (mode === 'cockpit' ? 0.06 : 0.02), 6, dt);
            const src = mode === 'cockpit' ? body : rig.root;
            src.updateMatrixWorld(true);
            const world = local.clone().applyMatrix4(src.matrixWorld);
            cam.position.copy(world);
            src.getWorldQuaternion(this.q);
            cam.quaternion.copy(this.q);
            cam.rotateY(-this.headYaw);
            cam.rotateX(this.headPitch);
            fov = mode === 'cockpit' ? 66 + clamp(speed * 0.12, 0, 10) : 64 + clamp(speed * 0.22, 0, 16);
            cam.near = mode === 'cockpit' ? 0.03 : 0.08;
            this.initialized = false;
        }
        // shake (speed rumble + impacts)
        this.shake = Math.max(0, this.shake - dt * 2.5);
        const rumble = clamp((speed - 30) / 60, 0, 1) * (mode === 'cockpit' ? 0.0025 : 0.012) + this.shake * 0.08;
        if (rumble > 0) {
            cam.position.x += (Math.random() - 0.5) * rumble;
            cam.position.y += (Math.random() - 0.5) * rumble;
        }
        if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = damp(cam.fov, fov, 4, dt); }
        cam.updateProjectionMatrix();
    }
}
