// On-screen touch controls: steering on the left, pedals on the right.
export class TouchControls {
    constructor(input) {
        this.input = input;
        this.el = document.getElementById('touch');
        this.enabled = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
        if (!this.enabled) return;
        document.body.classList.add('touch');
        for (const b of this.el.querySelectorAll('[data-key]')) {
            const code = b.dataset.key;
            const down = (e) => {
                e.preventDefault();
                b.setPointerCapture?.(e.pointerId);
                b.classList.add('down');
                if (!input.keys.has(code)) input.pressed.add(code);
                input.keys.add(code);
                if (navigator.vibrate && b.dataset.buzz) navigator.vibrate(10);
            };
            const up = (e) => { e.preventDefault(); b.classList.remove('down'); input.keys.delete(code); };
            b.addEventListener('pointerdown', down);
            b.addEventListener('pointerup', up);
            b.addEventListener('pointercancel', up);
            b.addEventListener('lostpointercapture', up);
            b.addEventListener('contextmenu', (e) => e.preventDefault());
        }
    }
    show(v) { if (this.enabled) this.el.classList.toggle('active', v); }
}
