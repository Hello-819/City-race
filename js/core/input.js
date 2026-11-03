// Input: keyboard, mouse (pointer lock, buttons, wheel) and gamepad.
//
//   input.act('sprint')      held          (named actions from CONFIG.keys)
//   input.actHit('enterExit') pressed this frame
//   input.actUp('weaponWheel') released this frame
//   input.down('KeyW') / hit('KeyW')        raw key codes
//   input.mouse.left/right, mouseHit(0|2), mouseDX/DY, wheel
// Driving axes (steer, throttle, brake, handbrake) are smoothed like before.
import { clamp } from './rng.js';
import { CONFIG } from '../config.js';

export class Input {
    constructor(canvas) {
        this.canvas = canvas;
        this.keys = new Set();
        this.pressed = new Set();    // edge-triggered this frame
        this.released = new Set();
        this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0;
        this.moveX = 0; this.moveY = 0;   // on-foot movement (-1..1), y = forward
        this.lookX = 0; this.lookY = 0;
        this.usingPad = false;
        this.mouse = { left: false, right: false };
        this.mousePressed = new Set();
        this.mouseReleased = new Set();
        this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
        this.locked = false;
        this.wantLock = false;       // set by the game while playing
        this.blockKeys = false;      // true while a UI form has focus

        window.addEventListener('keydown', (e) => {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'F1'].includes(e.code)) e.preventDefault();
            if (!this.keys.has(e.code)) this.pressed.add(e.code);
            this.keys.add(e.code);
            this.usingPad = false;
        });
        window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.released.add(e.code); });
        window.addEventListener('blur', () => { for (const k of this.keys) this.released.add(k); this.keys.clear(); this.mouse.left = this.mouse.right = false; });
        canvas.addEventListener('mousedown', (e) => {
            if (this.wantLock && !this.locked) { this.requestLock(); return; }
            if (e.button === 0) this.mouse.left = true;
            if (e.button === 2) this.mouse.right = true;
            this.mousePressed.add(e.button);
        });
        window.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.mouse.left = false;
            if (e.button === 2) this.mouse.right = false;
            this.mouseReleased.add(e.button);
        });
        window.addEventListener('contextmenu', (e) => { if (e.target === canvas) e.preventDefault(); });
        window.addEventListener('mousemove', (e) => {
            if (this.locked) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
        });
        window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
        document.addEventListener('pointerlockchange', () => {
            this.locked = document.pointerLockElement === canvas;
            if (!this.locked) { this.mouse.left = this.mouse.right = false; if (this.onUnlock) this.onUnlock(); }
        });
        this.padPrev = [];
    }

    requestLock() {
        try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed */ }
    }
    exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

    down(...codes) { return codes.some(c => this.keys.has(c)); }
    hit(...codes) { return codes.some(c => this.pressed.has(c)); }
    up(...codes) { return codes.some(c => this.released.has(c)); }
    act(name) { return !this.blockKeys && this.down(...CONFIG.keys[name]); }
    actHit(name) { return !this.blockKeys && this.hit(...CONFIG.keys[name]); }
    actUp(name) { return this.up(...CONFIG.keys[name]); }
    mouseHit(b) { return this.mousePressed.has(b); }

    update(dt) {
        const kLeft = this.down('ArrowLeft', 'KeyA'), kRight = this.down('ArrowRight', 'KeyD');
        const kUp = this.down('ArrowUp', 'KeyW'), kDown = this.down('ArrowDown', 'KeyS');
        let steerT = (kRight ? 1 : 0) - (kLeft ? 1 : 0);
        let thr = kUp ? 1 : 0, brk = kDown ? 1 : 0, hb = this.down('Space') ? 1 : 0;
        this.moveX = steerT; this.moveY = (kUp ? 1 : 0) - (kDown ? 1 : 0);

        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const pad = pads && [...pads].find(p => p && p.connected);
        if (pad) {
            const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
            const dz = (v) => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
            const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
            const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
            if (Math.abs(dz(ax)) > 0.02 || Math.abs(dz(ay)) > 0.02 || rt > 0.05 || lt > 0.05) this.usingPad = true;
            if (this.usingPad) {
                steerT = Math.sign(dz(ax)) * Math.pow(Math.abs(dz(ax)), 1.5);
                thr = Math.max(thr, rt); brk = Math.max(brk, lt);
                if (pad.buttons[0] && pad.buttons[0].pressed) hb = 1;
                this.moveX = dz(ax); this.moveY = -dz(ay);
                this.mouseDX += dz(pad.axes[2] || 0) * 900 * dt;
                this.mouseDY += dz(pad.axes[3] || 0) * 600 * dt;
            }
            const map = { 3: 'KeyF', 9: 'Escape', 4: 'KeyQ', 2: 'KeyR', 8: 'KeyM' };
            pad.buttons.forEach((b, i) => {
                if (b.pressed && !this.padPrev[i] && map[i]) { this.pressed.add(map[i]); this.keys.add(map[i]); }
                if (!b.pressed && this.padPrev[i] && map[i]) { this.released.add(map[i]); this.keys.delete(map[i]); }
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
        if (this.blockKeys) { this.moveX = this.moveY = 0; this.throttle = this.brake = 0; this.steer = 0; }
    }

    endFrame() {
        this.pressed.clear(); this.released.clear();
        this.mousePressed.clear(); this.mouseReleased.clear();
        this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    }
}
