// Entry point: renderer, menus, race lifecycle and the main loop.
import * as THREE from 'three';
import { loadAssets, createCar, CARS, PAINTS } from './assets.js';
import { setMaxAnisotropy } from './textures.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { Environment } from './world/environment.js';
import { World } from './world/world.js';
import { Traffic } from './traffic.js';
import { PlayerCar } from './playerCar.js';
import { CameraRig } from './cameraRig.js';
import { Hud, formatTime } from './hud.js';
import { GameRules } from './game.js';
import { Showroom } from './showroom.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas');

const store = {
    get(k, d) { try { const v = localStorage.getItem('cityrace.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cityrace.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = Object.assign({
    car: 'ferrari', color: CARS.ferrari.defaultColor, kind: 'city', time: 'day', mode: 'timeattack', traffic: '1',
    quality: 'medium', units: 'kmh', gearbox: 'auto', assists: 'on', volume: 0.7,
}, store.get('settings', {}));

let renderer;
try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
    $('loading').classList.remove('active');
    $('error').classList.add('active');
    $('error').textContent = 'WebGL is not available in this browser. City Race needs WebGL to run.';
    throw e;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const input = new Input();
const audio = new AudioEngine();
const hud = new Hud();
let showroom = null;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
const camRig = new CameraRig(camera);
const env = new Environment(renderer, scene);

let state = 'loading';
let race = null;      // { world, traffic, player, game, seed, ... }
let countdown = 0;
let simTime = 0;

function applyQuality() {
    const q = settings.quality;
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.25) : 0.85);
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

function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (showroom) showroom.resize(w, h);
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Menu
function show(id, on = true) { $(id).classList.toggle('active', on); }

function buildMenu() {
    const list = $('car-list');
    list.innerHTML = '';
    for (const car of Object.values(CARS)) {
        const b = document.createElement('button');
        b.className = 'card' + (settings.car === car.id ? ' on' : '');
        b.textContent = car.name;
        b.onclick = () => { settings.car = car.id; settings.color = car.defaultColor; saveSettings(); buildMenu(); };
        list.appendChild(b);
    }
    const car = CARS[settings.car];
    $('car-blurb').textContent = car.blurb;
    const P = car.physics;
    const hp = Math.round(Math.max(...P.torque.map(([r, t]) => r * t)) / 7121);
    $('car-stats').innerHTML = [['Power', car.stats.power, hp + ' hp'], ['Top speed', car.stats.speed], ['Handling', car.stats.handling]]
        .map(([n, v, extra]) => `<span>${n}${extra ? ' · ' + extra : ''}</span><div class="meter"><i style="width:${v * 100}%"></i></div>`).join('');
    const sw = $('paints');
    sw.innerHTML = '';
    for (const c of PAINTS) {
        const d = document.createElement('div');
        d.className = 'swatch' + (settings.color === c ? ' on' : '');
        d.style.background = c;
        d.onclick = () => { settings.color = c; saveSettings(); buildMenu(); };
        sw.appendChild(d);
    }
    document.querySelectorAll('.seg').forEach((seg) => {
        const key = seg.dataset.key;
        seg.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('on', String(settings[key]) === b.dataset.value);
            b.onclick = () => { settings[key] = b.dataset.value; saveSettings(); buildMenu(); onSettingChanged(key); };
        });
    });
    const best = store.get('best', {});
    const k = settings.kind + '-' + settings.mode;
    $('best').textContent = best[k] ? `Best ${settings.kind === 'city' ? 'City' : 'Mountain'} ${settings.mode === 'free' ? 'free roam' : 'time attack'} score: ${best[k].toLocaleString()}` : '';
    if (showroom) showroom.setCar(settings.car, settings.color);
}

function saveSettings() { store.set('settings', settings); }

function onSettingChanged(key) {
    if (key === 'quality') applyQuality();
    if (key === 'units') hud.units = settings.units;
    if (race && (key === 'gearbox' || key === 'assists')) applyAssists(race.player.veh);
}

function applyAssists(veh) {
    const on = settings.assists === 'on';
    veh.assists.tcs = on; veh.assists.esc = on; veh.assists.abs = on;
    veh.assists.auto = settings.gearbox === 'auto';
}

$('volume').value = settings.volume;
$('volume').oninput = (e) => { settings.volume = +e.target.value; audio.setVolume(settings.volume); saveSettings(); };
$('btn-settings').onclick = () => show('settings');
$('btn-controls').onclick = () => show('controls');
document.querySelectorAll('.modal .close').forEach((b) => b.onclick = () => b.closest('.modal').classList.remove('active'));
$('btn-start').onclick = () => startRace(Math.floor(Math.random() * 1e9));
$('btn-resume').onclick = () => resume();
$('btn-restart').onclick = () => { show('pause', false); startRace(race.seed); };
$('btn-pause-settings').onclick = () => show('settings');
$('btn-quit').onclick = () => toMenu();
$('btn-retry').onclick = () => { show('results', false); startRace(race.seed); };
$('btn-menu').onclick = () => { show('results', false); toMenu(); };

// ---------------------------------------------------------------------------
// Race lifecycle
function disposeRace() {
    if (!race) return;
    race.traffic.dispose();
    race.player.dispose();
    race.world.dispose();
    race = null;
}

function startRace(seed) {
    audio.init();
    audio.setVolume(settings.volume);
    disposeRace();
    show('menu', false);
    hud.units = settings.units;
    const kind = settings.kind;
    const night = settings.time === 'night';
    env.apply(settings.time, kind);
    const world = new World(scene, kind, night, seed);
    const rig = createCar(settings.car, { color: settings.color });
    const player = new PlayerCar(rig, scene, night);
    applyAssists(player.veh);
    const lane = kind === 'city' ? -1.75 - 3.5 : -1.8;
    player.place(world.road, 12, lane);
    // build everything around the start before the first frame
    for (let i = 0; i < 40; i++) world.update(player.s, rig.root.position, player.veh, 50);
    const traffic = new Traffic(scene, world, kind, night, seed, parseFloat(settings.traffic));
    traffic.reset(player.s);
    const game = new GameRules(settings.mode, kind);
    race = { world, traffic, player, game, seed, kind };
    camRig.reset();
    countdown = 3.5;
    state = 'countdown';
    simTime = 0;
    hud.show(true);
    $('countdown').textContent = '';
    if (camRig.current !== 'chase') hud.toast(camRigLabel());
}

function camRigLabel() { return ['Chase cam', 'Far chase cam', 'Cockpit view', 'Hood cam', 'Bumper cam'][camRig.mode]; }

function toMenu() {
    show('pause', false);
    disposeRace();
    hud.show(false);
    state = 'menu';
    show('menu');
    buildMenu();
    audio.update({ active: false, rpm: 1000, cylinders: 8, throttle: 0, redline: 8000, skid: 0, speed: 0 });
}

function pause() {
    if (state !== 'race' && state !== 'countdown') return;
    race.prevState = state;
    state = 'paused';
    show('pause');
    audio.suspend();
}

function resume() {
    if (state !== 'paused') return;
    show('pause', false);
    show('settings', false);
    state = race.prevState || 'race';
    audio.resume();
}

function finish() {
    state = 'results';
    const g = race.game;
    const score = Math.floor(g.score);
    const best = store.get('best', {});
    const k = race.kind + '-' + g.mode;
    const isBest = !best[k] || score > best[k];
    if (isBest) { best[k] = score; store.set('best', best); }
    const sp = (v) => settings.units === 'kmh' ? Math.round(v * 3.6) + ' km/h' : Math.round(v * 2.237) + ' mph';
    $('results-title').textContent = g.mode === 'timeattack' ? "Time's up!" : 'Session over';
    $('results-body').innerHTML = [
        ['Distance', (g.distance / 1000).toFixed(2) + ' km'],
        ['Time', formatTime(g.elapsed)],
        ['Checkpoints', g.checkpointsHit],
        ['Top speed', sp(g.topSpeed)],
        ['Near misses', g.nearMisses],
        ['Crashes', g.crashes],
    ].map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('') +
        `<div class="total">Score</div><div class="total">${score.toLocaleString()}</div>` +
        (isBest ? '<div class="newbest">New personal best!</div>' : '');
    show('results');
}

// ---------------------------------------------------------------------------
const _pos2 = { x: 0, y: 0 };
function updateRace(dt) {
    const { world, traffic, player, game } = race;
    const veh = player.veh;

    if (input.hit('Escape', 'KeyP')) { pause(); return; }
    if (input.hit('KeyC')) hud.toast(camRig.cycle());
    if (input.hit('KeyH')) audio.horn();
    if (input.hit('KeyE')) veh.shift(1);
    if (input.hit('KeyQ')) veh.shift(-1);
    if (input.hit('KeyR')) {
        const lane = race.kind === 'city' ? -5.25 : -1.8;
        player.place(world.road, player.s, lane);
        camRig.reset();
        hud.toast('Car reset');
    }

    let controls = true;
    if (state === 'countdown') {
        countdown -= dt;
        controls = false;
        const n = Math.ceil(countdown - 0.5);
        const el = $('countdown');
        const text = countdown > 0.5 ? String(n) : 'GO!';
        if (el.textContent !== text) {
            el.textContent = text;
            el.classList.toggle('go', text === 'GO!');
            audio.blip(text === 'GO!' ? 1046 : 523, text === 'GO!' ? 0.4 : 0.15, 'square', 0.12);
        }
        if (countdown <= 0.5) { state = 'race'; controls = true; }
    } else if ($('countdown').textContent && countdown > -0.8) {
        countdown -= dt;
        if (countdown <= -0.8) $('countdown').textContent = '';
    }
    if (state === 'race') simTime += dt;

    const impacts = player.update(dt, input, world, controls);
    _pos2.x = veh.x; _pos2.y = veh.y;
    world.update(player.s, player.rig.root.position, _pos2, 6);

    const f = world.road.frameAt(player.s);
    const along = veh.vx * f.c + veh.vy * f.sn;
    const events = traffic.update(dt, veh, player.s, player.d, along, simTime);
    for (const e of events) {
        if (e.type === 'crash') { audio.impact(e.strength); camRig.shake = Math.min(1, e.strength / 15); }
        if (e.type === 'honk') audio.horn();
    }
    for (const hit of impacts) { audio.impact(hit); camRig.shake = Math.max(camRig.shake, Math.min(1, hit / 20)); }

    if (state === 'race') {
        const popups = game.update(dt, player, world.road, events, impacts, hud, audio);
        for (const p of popups) hud.popup(p.text, p.cls);
        if (game.over) finish();
    }

    env.update(player.rig.root.position, camera);
    camRig.update(dt, player.rig, veh, input);
    audio.update({
        active: true, rpm: veh.rpm, cylinders: veh.P.cylinders, throttle: veh.throttle, redline: veh.P.redline,
        limiter: veh.limiter, skid: veh.skid, speed: veh.speed, inside: camRig.inside,
    });
    hud.update({ veh, game, road: world.road, player, traffic });
}

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0;
function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    input.update(dt);
    if (state === 'menu' && showroom) {
        showroom.update(dt);
        renderer.render(showroom.scene, showroom.camera);
    } else if (state === 'race' || state === 'countdown') {
        updateRace(dt);
        if (race) renderer.render(scene, camera);
    } else if (state === 'paused' || state === 'results') {
        if (input.hit('Escape', 'KeyP') && state === 'paused') resume();
        if (race) renderer.render(scene, camera);
    }
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 1) { window.__fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    input.endFrame();
}

// ---------------------------------------------------------------------------
async function boot() {
    resize();
    try {
        await loadAssets((p) => {
            $('load-bar').style.width = Math.round(p * 100) + '%';
        });
    } catch (e) {
        console.error(e);
        $('load-text').textContent = 'Failed to load assets. Serve the folder over HTTP (e.g. "npx serve" or "python3 -m http.server") instead of opening index.html directly.';
        return;
    }
    $('load-text').textContent = 'Preparing…';
    showroom = new Showroom(renderer);
    applyQuality();
    buildMenu();
    show('loading', false);
    state = 'menu';
    show('menu');
    requestAnimationFrame(frame);
}

// test hook: advance the simulation with a fixed step without rendering
function simulate(seconds, keys = [], autopilot = false) {
    for (const k of keys) input.keys.add(k);
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n && (state === 'race' || state === 'countdown'); i++) {
        input.update(1 / 60);
        if (autopilot && race) {
            // pure-pursuit driver used by automated tests
            const p = race.player, v = p.veh, road = race.world.road;
            const look = 12 + Math.abs(v.forwardSpeed) * 0.9;
            if (race.apLane == null) race.apLane = typeof autopilot === 'number' ? autopilot : -1.75;
            const blocked = race.traffic.cars.some(c => c.lane.dir > 0 && Math.abs(c.d - race.apLane) < 2 && c.s > p.s && c.s - p.s < 45);
            if (blocked && race.world.road.p.lanesPerDir > 1) race.apLane = race.apLane < -3.5 ? -1.75 : -5.25;
            const t = road.pointAt(p.s + look, race.apLane);
            const ang = Math.atan2(t.py - v.y, t.px - v.x) - v.th;
            const err = Math.atan2(Math.sin(ang), Math.cos(ang));
            input.steer = Math.max(-1, Math.min(1, -err * 3));
            const k = Math.abs(road.frameAt(p.s + look).k);
            const vmax = Math.min(85, Math.sqrt(1.0 * 9.81 / Math.max(k, 1e-4)));
            input.throttle = v.forwardSpeed < vmax ? 1 : 0;
            input.brake = v.forwardSpeed > vmax + 3 ? 1 : 0;
        }
        updateRace(1 / 60);
        input.endFrame();
    }
    for (const k of keys) input.keys.delete(k);
}
window.__game = { get race() { return race; }, get state() { return state; }, settings, startRace, camRig, input, renderer, scene, camera, simulate };
boot();
