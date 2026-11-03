// Entry point: renderer, title menu (Start / Options / Quit), pause, and the
// main loop. All gameplay lives in game/game.js.
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { setMaxAnisotropy } from './textures.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { Environment } from './world/environment.js';
import { Game } from './game/game.js';
import { CONFIG } from './config.js';
import { loadSave, deleteSave } from './game/save.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas');

const store = {
    get(k, d) { try { const v = localStorage.getItem('cityrace.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cityrace.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Player options only. There are no game modes: one persistent world.
const settings = Object.assign({ quality: 'medium', units: 'kmh', volume: 0.7, sensitivity: 1, invertY: 'off' }, store.get('settings', {}));

let renderer;
try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
    $('loading').classList.remove('active');
    $('error').classList.add('active');
    $('error').textContent = 'WebGL is not available in this browser. Harbor Heat needs WebGL to run.';
    throw e;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const input = new Input(canvas);
const audio = new AudioEngine();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 6000);
const env = new Environment(renderer, scene);
env.fogNear = CONFIG.time.fogNear; env.fogFar = CONFIG.time.fogFar;

let state = 'loading';      // loading | menu | playing | paused
let game = null;

function applyQuality() {
    const q = settings.quality;
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.25) : 0.8);
    renderer.shadowMap.enabled = q !== 'low';
    env.sunLight.castShadow = q !== 'low';
    const size = q === 'high' ? 4096 : 2048;
    if (env.sunLight.shadow.mapSize.x !== size) {
        env.sunLight.shadow.mapSize.set(size, size);
        if (env.sunLight.shadow.map) { env.sunLight.shadow.map.dispose(); env.sunLight.shadow.map = null; }
    }
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    resize();
}
function applyOptions() {
    if (game) {
        game.hud.units = settings.units;
        game.cam.sensitivity = settings.sensitivity;
        game.cam.invertY = settings.invertY === 'on';
    }
    audio.setVolume(settings.volume);
}

function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// --------------------------------------------------------------- menus
function show(id, on = true) { $(id).classList.toggle('active', on); }
function saveSettings() { store.set('settings', settings); }

function bindOptions() {
    document.querySelectorAll('.seg').forEach((seg) => {
        const key = seg.dataset.key;
        seg.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('on', String(settings[key]) === b.dataset.value);
            b.onclick = () => {
                settings[key] = b.dataset.value; saveSettings(); bindOptions();
                if (key === 'quality') applyQuality();
                applyOptions();
            };
        });
    });
}
$('volume').value = settings.volume;
$('volume').oninput = (e) => { settings.volume = +e.target.value; saveSettings(); applyOptions(); };
$('sensitivity').value = settings.sensitivity;
$('sensitivity').oninput = (e) => { settings.sensitivity = +e.target.value; saveSettings(); applyOptions(); };
$('btn-settings').onclick = () => show('settings');
$('btn-controls').onclick = () => show('controls');
$('btn-menu-controls').onclick = () => show('controls');
$('btn-pause-controls').onclick = () => show('controls');
$('btn-pause-settings').onclick = () => show('settings');
document.querySelectorAll('.modal .close').forEach((b) => b.onclick = () => {
    b.closest('.modal').classList.remove('active');
    if (helpOverlay && b.closest('#controls')) { helpOverlay = false; resume(); }
});
$('btn-quit-game').onclick = () => { show('menu', false); show('quit-screen'); try { window.close(); } catch { /* browsers may refuse */ } };
$('btn-unquit').onclick = () => { show('quit-screen', false); show('menu'); };
$('btn-reset-save').onclick = () => {
    if (!confirm('Delete your saved game (money, weapons, cars, position)?')) return;
    deleteSave();
    if (game) { game.dispose(); game = null; }
    updateSaveInfo();
    show('settings', false);
    if (state === 'paused') toMenu(false);
};
$('btn-start').onclick = () => startGame();
$('btn-resume').onclick = () => resume();
$('btn-quit').onclick = () => toMenu(true);

function updateSaveInfo() {
    const s = loadSave();
    $('save-info').textContent = s ? `Saved game: $${Math.floor(s.money).toLocaleString()}` : 'New game';
    $('btn-start').textContent = s ? 'Continue' : 'Start';
}

// ----------------------------------------------------------- lifecycle
function startGame() {
    audio.init();
    show('menu', false);
    if (!game) {
        $('loading').classList.add('active');
        $('load-text').textContent = 'Building the island…';
        // let the browser paint the loading screen before the heavy work
        requestAnimationFrame(() => setTimeout(() => {
            game = new Game({ scene, camera, renderer, env, input, audio });
            applyOptions();
            game.start();
            show('loading', false);
            enterPlay();
        }, 30));
        return;
    }
    enterPlay();
}

function enterPlay() {
    state = 'playing';
    game.hud.show(true);
    input.wantLock = true;
    input.requestLock();
    audio.resume();
}

function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    input.wantLock = false;
    input.exitLock();
    show('pause');
    audio.suspend();
    if (game) game.snapshot();
}

function resume() {
    if (state !== 'paused') return;
    show('pause', false); show('settings', false); show('controls', false);
    enterPlay();
}

function toMenu(saveFirst) {
    if (game && saveFirst) game.snapshot();
    show('pause', false);
    if (game) game.hud.show(false);
    input.wantLock = false;
    input.exitLock();
    state = 'menu';
    updateSaveInfo();
    show('menu');
    audio.update({ active: false, rpm: 1000, cylinders: 8, throttle: 0, redline: 8000, skid: 0, speed: 0 });
}

// Losing the mouse (Esc) pauses, unless an in-game UI asked for the cursor.
input.onUnlock = () => { if (state === 'playing' && game && !game.wantsCursor) pause(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ------------------------------------------------------------- loop
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, saveTimer = 0;
let helpOverlay = false;      // controls opened with F1: closing it resumes play
function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    input.update(dt);
    if (state === 'playing' && game) {
        if (input.actHit('controls') && !game.wantsCursor) { pause(); show('pause', false); show('controls'); helpOverlay = true; }
        else if (input.actHit('pause') && !game.mapOpen && !game.wantsCursor) pause();
        else {
            game.update(dt);
            $('fullmap').classList.toggle('active', game.mapOpen);
            saveTimer += dt;
            if (saveTimer > 20) { saveTimer = 0; game.snapshot(); }
        }
        renderer.render(game.activeScene, camera);
    } else if (state === 'paused' && helpOverlay && input.hit('F1', 'Escape')) {
        helpOverlay = false; show('controls', false); resume();
    } else if ((state === 'menu' || state === 'paused') && game) {
        renderer.render(game.activeScene, camera);
    }
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 1) { window.__fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    input.endFrame();
}

window.addEventListener('beforeunload', () => { if (game) game.snapshot(); });

// ------------------------------------------------------------- boot
async function boot() {
    resize();
    try {
        await loadAssets((p) => { $('load-bar').style.width = Math.round(p * 100) + '%'; });
    } catch (e) {
        console.error(e);
        $('load-text').textContent = 'Failed to load assets. Serve the folder over HTTP (e.g. "npx serve" or "python3 -m http.server") instead of opening index.html directly.';
        return;
    }
    applyQuality();
    bindOptions();
    updateSaveInfo();
    show('loading', false);
    state = 'menu';
    show('menu');
    requestAnimationFrame(frame);
}

// Test hook: run the simulation with a fixed step (no rendering).
function simulate(seconds, keys = [], mouse = null) {
    for (const k of keys) input.keys.add(k);
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n && state === 'playing'; i++) {
        input.update(1 / 60);
        if (mouse) { input.mouseDX += mouse.dx || 0; input.mouseDY += mouse.dy || 0; if (mouse.right) input.mouse.right = true; if (mouse.left) input.mouse.left = true; }
        game.update(1 / 60);
        input.endFrame();
    }
    for (const k of keys) input.keys.delete(k);
    if (mouse) { input.mouse.right = false; input.mouse.left = false; }
}
function press(code) { input.keys.add(code); input.pressed.add(code); }
function release(code) { input.keys.delete(code); input.released.add(code); }
window.__game = {
    get game() { return game; }, get state() { return state; }, env, input, renderer, scene, camera, settings,
    startGame, simulate, press, release, render: () => renderer.render(game ? game.activeScene : scene, camera),
};
boot();
