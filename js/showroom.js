// Menu background: the selected car on a turntable in a lit studio.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createCar } from './assets.js';

export class Showroom {
    constructor(renderer) {
        this.renderer = renderer;
        const scene = this.scene = new THREE.Scene();
        scene.background = new THREE.Color(0x07090d);
        scene.fog = new THREE.Fog(0x07090d, 14, 40);
        const pmrem = new THREE.PMREMGenerator(renderer);
        this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = this.env;
        this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);

        const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x0d0f13, roughness: 0.35, metalness: 0.4 }));
        floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
        scene.add(floor);
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.08, 64), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.25, metalness: 0.8 }));
        disc.position.y = 0.04; disc.receiveShadow = true;
        scene.add(disc);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.02, 8, 128), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.085;
        scene.add(ring);

        const key = new THREE.SpotLight(0xffffff, 300, 30, 0.6, 0.6, 1.5);
        key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0005;
        scene.add(key);
        const rim = new THREE.SpotLight(0xff6a50, 160, 30, 0.7, 0.8, 1.5);
        rim.position.set(-6, 4, -6);
        scene.add(rim);
        scene.add(new THREE.HemisphereLight(0x8090a0, 0x101010, 0.6));

        this.turntable = new THREE.Group();
        this.turntable.position.y = 0.08;
        scene.add(this.turntable);
        this.car = null;
        this.angle = 0.6;
        this.time = 0;
    }

    setCar(id, color) {
        if (this.car && this.car.id === id) { this.car.setColor(color); return; }
        if (this.car) this.turntable.remove(this.car.root);
        this.car = createCar(id, { color });
        this.turntable.add(this.car.root);
    }

    resize(w, h) {
        this.camera.aspect = w / h;
        // keep the car right of the menu panel on wide screens
        this.camera.setViewOffset(w, h, w > 900 ? -w * 0.14 : 0, 0, w, h);
        this.camera.updateProjectionMatrix();
    }

    update(dt) {
        this.time += dt;
        this.turntable.rotation.y += dt * 0.25;
        const r = 8.2;
        const a = this.angle + Math.sin(this.time * 0.1) * 0.15;
        this.camera.position.set(Math.cos(a) * r, 1.9 + Math.sin(this.time * 0.13) * 0.2, Math.sin(a) * r);
        this.camera.lookAt(0, 0.55, 0);
    }
}
