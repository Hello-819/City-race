// Third-person cameras.
//   On foot: mouse-orbit camera over the shoulder, pulled in when aiming,
//            kept out of buildings and above the ground.
//   In a vehicle: the chase / hood / cockpit rig from cameraRig.js; the mouse
//            swings it around and it recentres behind the car after a while.
import * as THREE from 'three';
import { CameraRig, CAMERA_MODES } from '../cameraRig.js';
import { CONFIG } from '../config.js';
import { clamp, damp, lerp } from '../core/rng.js';

const CC = CONFIG.camera;
const _cols = { boxes: [], circles: [] };
const _s = {};

export class GameCamera {
    constructor(camera) {
        this.camera = camera;
        this.rig = new CameraRig(camera);
        this.yaw = Math.PI / 2;      // map-frame direction the camera looks along
        this.pitch = 0.18;           // + looks down
        this.aimT = 0;               // 0..1 aim zoom blend
        this.dist = CC.footDistance;
        this.lookYaw = 0; this.lookPitch = 0; this.idle = 0;
        this.sensitivity = 1;
        this.invertY = false;
        this.pos = new THREE.Vector3();
        this.fwd = new THREE.Vector3();
        this.shake = 0;
        this.recoil = 0;
    }

    // mouse look (both modes)
    look(input, scale = 1) {
        const k = CC.mouseSensitivity * this.sensitivity * scale;
        const dx = input.mouseDX * k, dy = input.mouseDY * k * (this.invertY ? -1 : 1);
        this.yaw -= dx;
        this.pitch = clamp(this.pitch + dy, -1.1, 1.25);
        this.lookYaw -= dx * 1.3; this.lookPitch = clamp(this.lookPitch + dy, -0.5, 0.6);
        if (dx || dy) this.idle = 0;
    }

    // cycle the vehicle camera (skip cockpit for cars without an interior)
    cycle(rig) {
        let label;
        do { label = this.rig.cycle(); } while (CAMERA_MODES[this.rig.mode].id === 'cockpit' && !rig.eye);
        return label;
    }

    updateFoot(dt, player, map, aiming) {
        const cam = this.camera;
        this.aimT = damp(this.aimT, aiming ? 1 : 0, 12, dt);
        const D = lerp(CC.footDistance, CC.aimDistance, this.aimT);
        const shoulder = lerp(CC.shoulder * 0.6, CC.shoulder, this.aimT);
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const fx = Math.cos(this.yaw) * cp, fy = Math.sin(this.yaw) * cp, fz = -sp;
        const rx = Math.sin(this.yaw), ry = -Math.cos(this.yaw);
        const tx = player.x + rx * shoulder, ty = player.y + ry * shoulder;
        const tz = player.z + CC.footHeight - (player.swimming ? 0.9 : 0);
        // pull the camera in front of walls
        let d = D;
        map.collidersNear(tx, ty, D + 1, _cols);
        for (let k = 0.4; k <= D; k += 0.2) {
            const px = tx - fx * k, py = ty - fy * k, pz = tz - fz * k;
            let hit = false;
            for (const b of _cols.boxes) {
                if (px > b.x0 - 0.25 && px < b.x1 + 0.25 && py > b.y0 - 0.25 && py < b.y1 + 0.25 && !(b.zMin !== undefined && pz < b.zMin)) {
                    if (b.top === undefined) b.top = map.heightAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) + b.h + (b.tier ? b.tier.h : 0) + 3;
                    if (pz < b.top) { hit = true; break; }
                }
            }
            if (hit) { d = Math.max(0.3, k - 0.25); break; }
        }
        this.dist = d < this.dist ? d : damp(this.dist, d, 5, dt);
        let cx = tx - fx * this.dist, cy = ty - fy * this.dist, cz = tz - fz * this.dist;
        const g = map.surfaceAt(cx, cy, _s, player.z + 0.5).h + 0.3;
        if (cz < g) cz = g;
        cam.position.set(cx, cz, -cy);
        this.fwd.set(fx, fz, -fy);
        cam.up.set(0, 1, 0);
        cam.lookAt(cx + fx * 10, cz + fz * 10, -(cy + fy * 10));
        this._finish(dt, lerp(CC.fov, CC.aimFov * (aiming && aiming.zoom ? aiming.zoom : 1), this.aimT));
        this.rig.reset();
    }

    updateVehicle(dt, vehicle, input) {
        this.idle += dt;
        if (this.idle > CC.vehicleRecenter) { this.lookYaw = damp(this.lookYaw, 0, 3, dt); this.lookPitch = damp(this.lookPitch, 0, 3, dt); }
        this.lookYaw = Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw));
        // chase cams orbit (+ = left), attached cams turn the head (+ = right)
        const attached = this.rig.current !== 'chase' && this.rig.current !== 'far';
        const adapter = { lookX: attached ? -this.lookYaw : this.lookYaw, lookY: this.lookPitch, down: () => input.act('lookBack') };
        this.rig.update(dt, vehicle.rig, vehicle.veh, adapter);
        // keep foot camera aligned with where we are looking, for a smooth exit
        const dir = this.camera.getWorldDirection(this.fwd);
        this.yaw = Math.atan2(-dir.z, dir.x);
        this.pitch = 0.18;
        this.dist = CC.footDistance;
        this._finish(dt, null);
    }

    _finish(dt, fov) {
        const cam = this.camera;
        this.shake = Math.max(0, this.shake - dt * 2.5);
        this.recoil = damp(this.recoil, 0, 10, dt);
        if (this.shake > 0) {
            cam.position.x += (Math.random() - 0.5) * this.shake * 0.12;
            cam.position.y += (Math.random() - 0.5) * this.shake * 0.12;
        }
        if (fov != null) {
            cam.fov = damp(cam.fov, fov, 10, dt);
            cam.near = 0.08;
            cam.updateProjectionMatrix();
        }
    }

    // world-space ray from the screen centre (for aiming), map-frame values
    aimRay() {
        const cam = this.camera;
        const d = cam.getWorldDirection(this.fwd);
        return { ox: cam.position.x, oy: -cam.position.z, oz: cam.position.y, dx: d.x, dy: -d.z, dz: d.y };
    }
}
