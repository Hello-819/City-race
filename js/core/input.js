// Keyboard + gamepad input with smoothed analogue-style axes.
import { clamp } from './rng.js';

export class Input {
    constructor() {
        this.keys = new Set();
        this.pressed = new Set();   // edge-triggered this frame
        this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0;
        this.lookX = 0; this.lookY = 0;
        this.usingPad = false;
        window.addEventListener('keydown', (e) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
            if (!this.keys.has(e.code)) this.pressed.add(e.code);
            this.keys.add(e.code);
            this.usingPad = false;
        });
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
        this.padPrev = [];
        this.mouseDown = false;
        window.addEventListener('mousedown', (e) => { if (e.target.tagName === 'CANVAS') this.mouseDown = true; });
        window.addEventListener('mouseup', () => { this.mouseDown = false; });
        window.addEventListener('mousemove', (e) => {
            if (this.mouseDown) { this.lookX += e.movementX * 0.005; this.lookY += e.movementY * 0.004; }
        });
    }

    down(...codes) { return codes.some(c => this.keys.has(c)); }
    hit(...codes) { return codes.some(c => this.pressed.has(c)); }

    update(dt) {
        const kLeft = this.down('ArrowLeft', 'KeyA'), kRight = this.down('ArrowRight', 'KeyD');
        const kUp = this.down('ArrowUp', 'KeyW'), kDown = this.down('ArrowDown', 'KeyS');
        let steerT = (kRight ? 1 : 0) - (kLeft ? 1 : 0);
        let thr = kUp ? 1 : 0, brk = kDown ? 1 : 0, hb = this.down('Space') ? 1 : 0;

        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const pad = pads && [...pads].find(p => p && p.connected);
        if (pad) {
            const ax = pad.axes[0] || 0;
            const dz = Math.abs(ax) < 0.08 ? 0 : (ax - Math.sign(ax) * 0.08) / 0.92;
            const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
            const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
            if (Math.abs(dz) > 0.02 || rt > 0.05 || lt > 0.05) this.usingPad = true;
            if (this.usingPad) {
                steerT = Math.sign(dz) * Math.pow(Math.abs(dz), 1.5);
                thr = Math.max(thr, rt); brk = Math.max(brk, lt);
                if (pad.buttons[0] && pad.buttons[0].pressed) hb = 1;
                this.lookX = (pad.axes[2] || 0) * 1.6;
            }
            const map = { 3: 'KeyC', 1: 'KeyB', 9: 'Escape', 5: 'KeyE', 4: 'KeyQ', 2: 'KeyR' };
            pad.buttons.forEach((b, i) => {
                if (b.pressed && !this.padPrev[i] && map[i]) this.pressed.add(map[i]);
                if (i === 1) { if (b.pressed) this.keys.add('PadLook'); else this.keys.delete('PadLook'); }
                this.padPrev[i] = b.pressed;
            });
        }

        if (this.usingPad) this.steer = steerT;
        else {
            // keyboard: ramp towards target, return to centre faster
            const rate = steerT === 0 ? 6 : (Math.sign(steerT) !== Math.sign(this.steer) && this.steer !== 0 ? 9 : 3.2);
            this.steer += clamp(steerT - this.steer, -rate * dt, rate * dt);
        }
        this.throttle += clamp(thr - this.throttle, -8 * dt, 5 * dt);
        this.brake += clamp(brk - this.brake, -10 * dt, 7 * dt);
        this.handbrake = hb;
        if (!this.mouseDown && !this.usingPad) { this.lookX *= Math.exp(-4 * dt); this.lookY *= Math.exp(-4 * dt); }
        this.lookX = clamp(this.lookX, -2.2, 2.2); this.lookY = clamp(this.lookY, -0.6, 0.6);
    }

    endFrame() { this.pressed.clear(); }
}
