// Working rear-view mirror: a rear-facing camera rendered into a texture that is
// shown on the car's interior mirror (cockpit view) or as a HUD mirror.
import * as THREE from 'three';

export class RearMirror {
    constructor(renderer) {
        this.renderer = renderer;
        this.rt = new THREE.WebGLRenderTarget(512, 168, { samples: 2 });
        this.rt.texture.colorSpace = THREE.SRGBColorSpace;
        this.camera = new THREE.PerspectiveCamera(42, 512 / 168, 0.3, 700);
        // texture mirrored horizontally like a real mirror
        const tex = this.rt.texture;
        tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1; tex.offset.x = 1;
        this.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
        // HUD overlay
        this.hudScene = new THREE.Scene();
        this.hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x111111 }));
        this.hudPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
        this.hudFrame = frame;
        this.hudScene.add(frame, this.hudPlane);
        this.cockpitPlane = null;
        this.enabled = true;
    }

    // attach a mirror surface to a car rig in body space
    attach(rig) {
        if (this.cockpitPlane) this.cockpitPlane.parent.remove(this.cockpitPlane);
        this.cockpitPlane = null;
        const m = rig.spec.mirror;
        if (!m) return;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(m.size[0], m.size[1]), this.material);
        plane.position.set(...m.pos);
        plane.rotation.set(m.rot[0], m.rot[1], m.rot[2], 'YXZ');
        rig.body.add(plane);
        this.cockpitPlane = plane;
    }

    // render the rear view from the car
    update(scene, rig) {
        if (!this.enabled) return;
        const cam = this.camera;
        rig.root.updateMatrixWorld(true);
        const eye = new THREE.Vector3(0, rig.dims.y + 0.15, rig.dims.z * 0.2).applyMatrix4(rig.root.matrixWorld);
        const back = new THREE.Vector3(0, rig.dims.y * 0.6, rig.dims.z * 0.5 + 40).applyMatrix4(rig.root.matrixWorld);
        cam.position.copy(eye);
        cam.lookAt(back);
        const r = this.renderer;
        const prevRT = r.getRenderTarget();
        const shadowAuto = r.shadowMap.autoUpdate;
        r.shadowMap.autoUpdate = false;           // reuse the main pass shadow map
        rig.root.visible = false;
        r.setRenderTarget(this.rt);
        r.render(scene, cam);
        r.setRenderTarget(prevRT);
        rig.root.visible = true;
        r.shadowMap.autoUpdate = shadowAuto;
    }

    // draw the HUD mirror over the frame (top centre)
    drawHud(width, height) {
        const w = Math.min(420, width * 0.32), h = w / (512 / 168);
        const r = this.renderer;
        const x = (width - w) / 2, y = height - h - 14;
        r.autoClear = false;
        r.setViewport(x - 4, y - 4, w + 8, h + 8);
        r.setScissor(x - 4, y - 4, w + 8, h + 8);
        r.setScissorTest(true);
        this.hudPlane.visible = false; this.hudFrame.visible = true;
        this.hudFrame.scale.set(2, 2, 1);
        r.render(this.hudScene, this.hudCam);
        r.setViewport(x, y, w, h); r.setScissor(x, y, w, h);
        this.hudFrame.visible = false; this.hudPlane.visible = true;
        this.hudPlane.scale.set(2, 2, 1);
        r.render(this.hudScene, this.hudCam);
        r.setScissorTest(false);
        r.setViewport(0, 0, width, height);
        r.autoClear = true;
    }
}
