// Post-processing: speed blur + speed lines, vignette, damage pulse and police flash.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const SpeedShader = {
    uniforms: {
        tDiffuse: { value: null }, amount: { value: 0 }, lines: { value: 0 }, time: { value: 0 },
        damage: { value: 0 }, police: { value: 0 }, flash: { value: 0 }, aspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float amount, lines, time, damage, police, flash, aspect;
        varying vec2 vUv;
        float hash(float n){ return fract(sin(n) * 43758.5453); }
        void main(){
            vec2 c = vec2(0.5, 0.52);
            vec2 dir = vUv - c;
            float r = length(dir * vec2(aspect, 1.0));
            // radial blur grows towards the edges
            vec4 col = vec4(0.0);
            float k = amount * smoothstep(0.12, 0.75, r);
            for (int i = 0; i < 8; i++) {
                float t = float(i) / 7.0;
                col += texture2D(tDiffuse, vUv - dir * k * t);
            }
            col /= 8.0;
            // slight chromatic fringe at speed
            float ca = amount * 0.25 * r;
            col.r = mix(col.r, texture2D(tDiffuse, vUv - dir * (k + ca)).r, 0.5);
            // speed lines: thin bright streaks at the edges
            if (lines > 0.0) {
                float a = atan(dir.y, dir.x);
                float id = floor(a * 60.0);
                float h = hash(id + floor(time * 12.0) * 7.0);
                float streak = step(0.93, h) * smoothstep(0.35, 0.85, r) * lines;
                col.rgb += vec3(streak * 0.35);
            }
            // vignette
            float vig = smoothstep(0.95, 0.35, r);
            col.rgb *= mix(1.0, vig, 0.35 + amount * 2.0);
            // damage pulse (red edges) and police flash (red / blue edges)
            float edge = smoothstep(0.35, 0.9, r);
            col.rgb = mix(col.rgb, vec3(0.8, 0.0, 0.0), edge * damage * 0.6);
            vec3 pol = flash > 0.5 ? vec3(1.0, 0.05, 0.05) : vec3(0.1, 0.25, 1.0);
            col.rgb += pol * edge * police * 0.35;
            gl_FragColor = col;
        }`,
};

export class PostFX {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(renderer, rt);
        this.renderPass = new RenderPass(scene, camera);
        this.speed = new ShaderPass(SpeedShader);
        this.composer.addPass(this.renderPass);
        this.composer.addPass(this.speed);
        this.composer.addPass(new OutputPass());
        this.enabled = true;
        this.time = 0;
    }

    setSize(w, h) {
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(w, h);
        this.speed.uniforms.aspect.value = w / h;
    }

    render(scene, camera, dt, { speed = 0, damage = 0, police = 0 } = {}) {
        if (!this.enabled) { this.renderer.render(scene, camera); return; }
        this.time += dt;
        this.renderPass.scene = scene; this.renderPass.camera = camera;
        const u = this.speed.uniforms;
        u.amount.value = THREE.MathUtils.clamp((speed - 28) / 70, 0, 1) * 0.045;
        u.lines.value = THREE.MathUtils.clamp((speed - 45) / 30, 0, 1);
        u.time.value = this.time;
        u.damage.value = damage;
        u.police.value = police;
        u.flash.value = Math.sin(this.time * 18) > 0 ? 1 : 0;
        this.composer.render(dt);
    }
}
