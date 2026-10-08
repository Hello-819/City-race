// Synthesised engine, tyre, wind and impact sounds (Web Audio, no samples needed).
export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.volume = 0.7;
        this.enabled = true;
    }

    init() {
        if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = this.ctx = new AC();
        this.master = ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = ctx.createDynamicsCompressor();
        this.master.connect(comp); comp.connect(ctx.destination);

        // engine: two detuned saws + sub square through a resonant lowpass and soft clip
        this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
        this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.Q.value = 3;
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.2); }
        shaper.curve = curve;
        this.osc = [];
        const mk = (type, gain) => {
            const o = ctx.createOscillator(); o.type = type;
            const g = ctx.createGain(); g.gain.value = gain;
            o.connect(g); g.connect(shaper); o.start();
            this.osc.push(o);
            return o;
        };
        this.o1 = mk('sawtooth', 0.35); this.o2 = mk('sawtooth', 0.25); this.o3 = mk('square', 0.22);
        this.o4 = mk('triangle', 0.18);
        shaper.connect(this.engFilter); this.engFilter.connect(this.engGain); this.engGain.connect(this.master);

        // noise source shared by tyres / wind / intake
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const noise = () => { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.start(); return n; };
        this.noiseBuf = buf;

        this.tyreGain = ctx.createGain(); this.tyreGain.gain.value = 0;
        const tf = ctx.createBiquadFilter(); tf.type = 'bandpass'; tf.frequency.value = 1100; tf.Q.value = 6;
        this.tyreFilter = tf;
        noise().connect(tf); tf.connect(this.tyreGain); this.tyreGain.connect(this.master);

        this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
        const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 500;
        this.windFilter = wf;
        noise().connect(wf); wf.connect(this.windGain); this.windGain.connect(this.master);

        this.intakeGain = ctx.createGain(); this.intakeGain.gain.value = 0;
        const inf = ctx.createBiquadFilter(); inf.type = 'bandpass'; inf.frequency.value = 400; inf.Q.value = 1.2;
        this.intakeFilter = inf;
        noise().connect(inf); inf.connect(this.intakeGain); this.intakeGain.connect(this.engFilter);
    }

    setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

    update(state) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const on = this.enabled && state.active;
        // firing frequency: rpm/60 * cylinders/2
        const f = state.rpm / 60 * (state.cylinders / 2);
        const set = (p, v, tc = 0.03) => p.setTargetAtTime(v, t, tc);
        set(this.o1.frequency, f);
        set(this.o2.frequency, f * 1.006 * 2);
        set(this.o3.frequency, f * 0.5);
        set(this.o4.frequency, f * 3.01);
        const load = state.throttle;
        set(this.engFilter.frequency, 280 + f * (2.0 + 3.5 * load) + (state.limiter ? 400 : 0));
        set(this.engGain.gain, on ? (0.10 + 0.22 * load + 0.08 * (state.rpm / state.redline)) * (state.inside ? 0.8 : 1) : 0, 0.05);
        set(this.intakeGain.gain, on ? 0.5 * load * (state.rpm / state.redline) : 0);
        set(this.intakeFilter.frequency, 300 + f * 1.5);
        set(this.tyreGain.gain, on ? Math.min(0.5, state.skid * 0.45) : 0, 0.05);
        set(this.tyreFilter.frequency, 800 + 600 * Math.min(1, state.speed / 40));
        const w = Math.min(1, state.speed / 80);
        set(this.windGain.gain, on ? w * w * (state.inside ? 0.12 : 0.35) : 0, 0.1);
        set(this.windFilter.frequency, 300 + w * 1400);
    }

    impact(strength) {
        if (!this.ctx || !this.enabled) return;
        const ctx = this.ctx, t = ctx.currentTime;
        const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300 + strength * 60;
        const g = ctx.createGain();
        const v = Math.min(1, 0.15 + strength / 25);
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35 + strength * 0.02);
        src.connect(f); f.connect(g); g.connect(this.master);
        src.start(t, Math.random()); src.stop(t + 1);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
        const og = ctx.createGain(); og.gain.setValueAtTime(v * 0.8, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(og); og.connect(this.master); o.start(t); o.stop(t + 0.4);
    }

    blip(freq = 880, dur = 0.12, type = 'square', vol = 0.15) {
        if (!this.ctx || !this.enabled) return;
        const ctx = this.ctx, t = ctx.currentTime;
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
        const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
    }

    horn() {
        if (!this.ctx || !this.enabled) return;
        const ctx = this.ctx, t = ctx.currentTime;
        for (const fr of [392, 494]) {
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr;
            const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.06, t + 0.03); g.gain.setValueAtTime(0.06, t + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
            o.connect(f); f.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.65);
        }
    }

    suspend() { if (this.ctx) this.ctx.suspend(); }
    resume() { if (this.ctx) this.ctx.resume(); }
}
