// Entry point: renderer, menus, race lifecycle and the main loop.
import * as THREE from 'three';
import { loadAssets, createCar, CARS, PAINTS } from './assets.js';
import { setMaxAnisotropy } from './textures.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { Environment } from './world/environment.js';
import { World } from './world/world.js';
import { Traffic } from './traffic.js';
import { Car } from './playerCar.js';
import { Pedestrians } from './pedestrians.js';
import { Police } from './police.js';
import { Racers } from './racers.js';
import { GhostRecorder, GhostCar, ghostStore } from './ghost.js';
import { Recorder, ReplayDirector, carChannel, trafficChannel } from './replay.js';
import { PostFX } from './post.js';
import { RearMirror } from './mirror.js';
import { TouchControls } from './touch.js';
import { vehicleVsVehicle } from './collide.js';
import { CameraRig } from './cameraRig.js';
import { Hud, formatTime } from './hud.js';
import { GameRules } from './game.js';
import { Showroom } from './showroom.js';
import { Effects } from './effects.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas');

const store = {
    get(k, d) { try { const v = localStorage.getItem('cityrace.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cityrace.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = Object.assign({
    car: 'ferrari', color: CARS.ferrari.defaultColor, kind: 'city', time: 'day', mode: 'timeattack', traffic: '1',
    quality: 'medium', units: 'kmh', gearbox: 'auto', assists: 'on', volume: 0.7,
    rivals: '0', police: 'on', ghost: 'on', peds: 'on', track: 'random', mirror: 'on', speedfx: 'on',
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
const post = new PostFX(renderer, scene, camera);
const mirror = new RearMirror(renderer);
const touch = new TouchControls(input);
let replay = null;        // ReplayDirector while watching
let replayReturn = null;  // state to go back to

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
    post.enabled = q !== 'low' && settings.speedfx === 'on';
    mirror.enabled = settings.mirror === 'on';
    resize();
}

function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
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
    if (key === 'quality' || key === 'speedfx' || key === 'mirror') applyQuality();
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
function trackSeed() {
    if (settings.track === 'daily') { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
    return Math.floor(Math.random() * 1e9);
}
$('btn-start').onclick = () => startRace(trackSeed());
$('btn-pause-replay').onclick = () => { show('pause', false); startReplay('paused'); };
$('btn-results-replay').onclick = () => { show('results', false); startReplay('results'); };
$('rp-exit').onclick = () => exitReplay();
$('rp-restart').onclick = () => { replay.restart(); replay.playing = true; };
$('rp-play').onclick = () => { replay.playing = !replay.playing; if (replay.playing && replay.progress >= 0.999) replay.restart(); };
$('rp-speed').onclick = () => { const s = [0.25, 0.5, 1, 2]; replay.speed = s[(s.indexOf(replay.speed) + 1) % s.length]; $('rp-speed').textContent = replay.speed + '×'; };
$('rp-cam').onclick = () => { replay.nextCam(); $('rp-cam').textContent = 'Camera: ' + replay.camName; };
document.querySelector('.replay-bar').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); replay.seek((e.clientX - r.left) / r.width); };
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
    race.effects.dispose();
    race.player.dispose();
    race.peds.dispose();
    if (race.police) race.police.dispose();
    if (race.racers) race.racers.dispose();
    if (race.ghostCar) race.ghostCar.dispose();
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
    const mode = settings.mode;
    env.apply(settings.time, kind);
    const game = new GameRules(mode, kind);
    const world = new World(scene, kind, night, seed, { finishS: mode === 'sprint' ? game.finishS : null });
    const rig = createCar(settings.car, { color: settings.color });
    const player = new Car(rig, scene, { night, player: true });
    applyAssists(player.veh);
    const nRivals = parseInt(settings.rivals, 10) || 0;
    const slots = Racers.grid(kind, nRivals);
    player.place(world.road, nRivals ? slots[0].s : 12, nRivals ? slots[0].d : (kind === 'city' ? -5.25 : -1.8));
    // build everything around the start before the first frame
    for (let i = 0; i < 40; i++) world.update(player.s, rig.root.position, player.veh, 50);
    const traffic = new Traffic(scene, world, kind, night, seed, parseFloat(settings.traffic));
    traffic.reset(player.s + (nRivals ? 40 : 0));
    const peds = new Pedestrians(scene, world, seed, settings.peds === 'on' && kind === 'city' ? 34 : 0);
    peds.reset(player.s);
    const police = settings.police === 'on' ? new Police(scene, world, night, seed) : null;
    const racers = nRivals ? new Racers(scene, world, nRivals, night, seed) : null;
    if (racers) racers.place(slots);
    const effects = new Effects(scene, night);
    const ghostKey = ghostStore.key(kind, seed, mode);
    const ghostData = settings.ghost === 'on' ? ghostStore.load(ghostKey) : null;
    const ghostCar = ghostData ? new GhostCar(scene, ghostData) : null;
    const recorder = new Recorder([carChannel(player), trafficChannel(traffic), peds.enabled ? peds : null, police, racers]);
    mirror.attach(rig);
    race = { world, traffic, player, game, seed, kind, effects, peds, police, racers, ghostCar, ghostKey, ghostRec: new GhostRecorder(), recorder, wreckT: 0, endT: 0 };
    camRig.reset();
    countdown = 3.5;
    state = 'countdown';
    simTime = 0;
    hud.show(true);
    touch.show(true);
    $('countdown').textContent = '';
    if (ghostCar) hud.toast('Racing your ghost');
    else if (camRig.current !== 'chase') hud.toast(camRigLabel());
}

function camRigLabel() { return ['Chase cam', 'Far chase cam', 'Cockpit view', 'Hood cam', 'Bumper cam'][camRig.mode]; }

function toMenu() {
    show('pause', false);
    if (replay) exitReplay(true);
    disposeRace();
    hud.show(false);
    touch.show(false);
    audio.siren(0);
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

// --- replay ---------------------------------------------------------------
function startReplay(from) {
    if (!race || race.recorder.count < 10) { hud.toast('Nothing recorded yet'); if (from === 'paused') show('pause'); else show('results'); return; }
    replayReturn = from;
    state = 'replay';
    audio.resume();
    race.effects.clearTransient();
    replay = new ReplayDirector(race.recorder, camera, race.world.road, race.player);
    show('replay-ui');
    hud.show(false); touch.show(false);
    $('rp-play').textContent = '⏸'; $('rp-speed').textContent = '1×'; $('rp-cam').textContent = 'Camera: auto';
}

function exitReplay(silent = false) {
    show('replay-ui', false);
    replay = null;
    if (silent || !race) return;
    // restore the live state of every actor before continuing
    race.recorder.apply(race.recorder.endTime, 0);
    race.player.syncVisual(race.world.road, 0);
    camRig.reset();
    camera.fov = 60;
    if (replayReturn === 'results') { state = 'results'; show('results'); }
    else { state = 'paused'; show('pause'); hud.show(true); touch.show(true); audio.suspend(); }
}

function resume() {
    if (state !== 'paused') return;
    show('pause', false);
    show('settings', false);
    hud.show(true); touch.show(true);
    state = race.prevState || 'race';
    audio.resume();
}

function finish() {
    state = 'results';
    audio.siren(0);
    const g = race.game;
    const score = Math.floor(g.score);
    const best = store.get('best', {});
    const k = race.kind + '-' + g.mode;
    const isBest = g.endReason !== 'busted' && (!best[k] || score > best[k]);
    if (isBest) { best[k] = score; store.set('best', best); }
    // keep the ghost if this run beat the stored one
    const old = ghostStore.load(race.ghostKey);
    const better = g.mode === 'sprint' ? (g.finished && (!old || !old.finishTime || g.finishTime < old.finishTime)) : (!old || g.distance > (old.distance || 0));
    if (better && race.ghostRec.data.length > 20) ghostStore.save(race.ghostKey, { car: settings.car, data: race.ghostRec.data, finishTime: g.finished ? g.finishTime : 0, distance: g.distance });
    const sp = (v) => settings.units === 'kmh' ? Math.round(v * 3.6) + ' km/h' : Math.round(v * 2.237) + ' mph';
    const titles = { time: "Time's up!", finish: 'Finished!', busted: 'BUSTED!' };
    $('results-title').textContent = titles[g.endReason] || 'Session over';
    const rows = [
        ['Distance', (g.distance / 1000).toFixed(2) + ' km'],
        ['Time', formatTime(g.finished ? g.finishTime : g.elapsed)],
    ];
    if (race.racers) rows.push(['Position', race.racers.position(race.player.s, g.finished, g.finishTime) + ' / ' + (race.racers.units.length + 1)]);
    if (g.mode === 'timeattack') rows.push(['Checkpoints', g.checkpointsHit]);
    rows.push(['Top speed', sp(g.topSpeed)], ['Near misses', g.nearMisses], ['Crashes', g.crashes]);
    if (race.police) rows.push(['Max wanted level', '★'.repeat(race.maxStars || 0) || '-']);
    $('results-body').innerHTML = rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('') +
        `<div class="total">Score</div><div class="total">${score.toLocaleString()}</div>` +
        (isBest ? '<div class="newbest">New personal best!</div>' : '') +
        (better && race.ghostRec.data.length > 20 && settings.ghost === 'on' ? '<div class="newbest">Ghost saved: race it with Race Again</div>' : '');
    show('results');
}

// ---------------------------------------------------------------------------
const _pos2 = { x: 0, y: 0 };
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };

function heatEvent(amount, reason) {
    const police = race.police;
    if (!police) return;
    const up = police.addHeat(amount);
    race.maxStars = Math.max(race.maxStars || 0, police.stars);
    if (up) { hud.popup('WANTED ' + '★'.repeat(police.stars), 'bad'); }
    else if (reason && police.stars === 0 && police.heat > 0.01) hud.popup(reason, 'bad');
}

// crash feedback only (no damage model): camera shake and sparks
function crashFx(speed, nx, ny) {
    if (speed < 3) return;
    camRig.shake = Math.max(camRig.shake, Math.min(0.8, speed / 30));
    const v = race.player.veh;
    race.effects.impactSparks(v.x - nx * 1.2, v.z + 0.5, -(v.y - ny * 1.2), v.vx, -v.vy, speed);
}

function updateRace(dt) {
    const { world, traffic, player, game, peds, police, racers, effects } = race;
    const veh = player.veh;

    if (input.hit('Escape', 'KeyP')) { pause(); return; }
    if (input.hit('KeyV')) { race.prevState = state; state = 'paused'; startReplay('paused'); return; }
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

    // --- player ---
    const ctl = controls ? { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake } : NO_INPUT;
    const impacts = player.update(dt, ctl, world);
    _pos2.x = veh.x; _pos2.y = veh.y;
    world.update(player.s, player.rig.root.position, _pos2, 6);

    const f = world.road.frameAt(player.s);
    const along = veh.vx * f.c + veh.vy * f.sn;

    // --- traffic ---
    const obstacles = [{ s: player.s, d: player.d, v: along }];
    if (police) for (const u of police.units) if (u.active) obstacles.push({ s: u.car.s, d: u.car.d, v: u.car.veh.forwardSpeed });
    if (racers) for (const u of racers.units) obstacles.push({ s: u.car.s, d: u.car.d, v: u.car.veh.forwardSpeed });
    peds.obstacles(obstacles);
    const events = traffic.update(dt, { playerS: player.s, playerD: player.d, playerAlong: along, player: veh, obstacles, simTime });
    for (const h of traffic.collide(veh, player.s, simTime)) {
        events.push({ type: 'crash', strength: h.speed });
        crashFx(h.speed, h.nx, h.ny);
        audio.impact(h.speed);
        if (h.speed > 4) heatEvent(0.5, 'Careful - the police noticed that');
    }
    for (const e of events) if (e.type === 'honk') audio.horn();

    // --- walls & props ---
    for (const hit of impacts) {
        audio.impact(hit.speed);
        crashFx(hit.speed, hit.nx, hit.ny);
        if (hit.kind === 'prop' && hit.speed > 3 && !hit.prop.hit) { hit.prop.hit = true; heatEvent(0.4, 'Property damage!'); }
    }
    for (const sc of player.scrapes) effects.scrape(sc.x, veh.z + 0.4, -sc.y, veh.vx, -veh.vy);

    // --- AI rivals ---
    if (racers) {
        for (const e of racers.update(dt, { player, traffic, world, controls: state === 'race', simTime, finishS: game.mode === 'sprint' ? game.finishS : null, police })) {
            if (e.type === 'racerContact') { crashFx(e.speed, e.nx, e.ny); audio.impact(e.speed); }
            if (e.type === 'racerFinished' && !game.finished) hud.popup(e.u.name + ' finished', 'bad');
        }
    }

    // --- pedestrians ---
    const hitters = [{ veh, s: player.s, isPlayer: true, tag: 'player' }];
    if (police) for (const u of police.units) if (u.active) hitters.push({ veh: u.car.veh, s: u.car.s, tag: 'police' });
    if (racers) for (const u of racers.units) hitters.push({ veh: u.car.veh, s: u.car.s, tag: 'racer' });
    for (const e of peds.update(dt, player.s, camera.position, hitters, traffic)) {
        if (e.isPlayer) {
            game.pedsHit++;
            audio.impact(6);
            if (game.combo > 1) { game.combo = 1; }
            heatEvent(1.0);
            if (!police) hud.popup('PEDESTRIAN HIT', 'bad');
        }
    }

    // --- police ---
    if (police) {
        for (const e of police.update(dt, { player, traffic, world, effects, simTime })) {
            if (e.type === 'copContact') {
                crashFx(e.speed, e.nx, e.ny);
                audio.impact(e.speed);
                if (e.speed > 6 && !e.unit.rammed) { e.unit.rammed = true; heatEvent(0.6); setTimeout(() => { e.unit.rammed = false; }, 2000); }
            }
            if (e.type === 'roadblock') hud.popup('ROADBLOCK AHEAD', 'bad');
            if (e.type === 'starLost') hud.popup('Heat dropping', 'cp');
            if (e.type === 'evaded') hud.popup('EVADED!', 'cp');
            if (e.type === 'busted' && state === 'race') game.end('busted');
        }
        const near = police.nearest ?? Infinity;
        audio.siren(police.active.length ? Math.max(0, 1 - near / 260) : 0);
    }


    if (state === 'race') {
        const popups = game.update(dt, player, world.road, events, impacts.map(i => i.speed), hud, audio);
        for (const p of popups) hud.popup(p.text, p.cls);
        if (game.over) { race.endT += dt; if (race.endT > (game.endReason === 'finish' ? 1.5 : 0.6)) finish(); }
    }

    // --- effects, ghost, recording ---
    player.rig.root.updateMatrixWorld(true);
    effects.tyres(dt, player.rig, veh.skid, veh.speed);
    if (racers) for (const u of racers.units) { u.car.rig.root.updateMatrixWorld(true); effects.tyres(dt, u.car.rig, u.car.veh.skid, u.car.veh.speed, u.car.rig); }
    effects.update(dt);
    if (state === 'race') {
        race.ghostRec.record(simTime, player.rig.root);
        race.recorder.record(simTime);
    }
    if (race.ghostCar) race.ghostCar.update(simTime);

    env.update(player.rig.root.position, camera);
    camRig.update(dt, player.rig, veh, input);
    audio.update({
        active: true, rpm: veh.rpm, cylinders: veh.P.cylinders, throttle: veh.throttle, redline: veh.P.redline,
        limiter: veh.limiter, skid: veh.skid, speed: veh.speed, inside: camRig.inside,
    });
    const position = racers ? { place: racers.position(player.s, game.finished, game.finishTime), total: racers.units.length + 1 } : null;
    hud.update({ veh, game, road: world.road, player, traffic, police, racers, position });
}

function renderRace(dt) {
    const p = race.player;
    const inside = camRig.current === 'cockpit';
    const needMirror = mirror.enabled && (inside || camRig.current === 'hood' || camRig.current === 'bumper');
    if (needMirror) mirror.update(scene, p.rig);
    if (mirror.cockpitPlane) mirror.cockpitPlane.visible = needMirror && inside;
    const police = race.police;
    const chase = police && police.active.length ? Math.max(0, 1 - (police.nearest ?? 999) / 120) : 0;
    post.render(scene, camera, dt, { speed: state === 'replay' ? (p.replaySpeed || 0) : Math.abs(p.veh.forwardSpeed), damage: 0, police: chase });
    if (needMirror && (!inside || !mirror.cockpitPlane) && state !== 'replay') mirror.drawHud(window.innerWidth, window.innerHeight);
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
        if (race && (state === 'race' || state === 'countdown')) renderRace(dt);
    } else if (state === 'replay' && replay) {
        if (input.hit('Escape', 'KeyV')) exitReplay();
        else {
            if (input.hit('KeyC')) $('rp-cam').click();
            if (input.hit('Space')) $('rp-play').click();
            replay.update(dt, race.effects);
            $('replay-progress').style.width = (replay.progress * 100).toFixed(1) + '%';
            $('rp-play').textContent = replay.playing ? '⏸' : '▶';
            env.update(race.player.rig.root.position, camera);
            renderRace(dt);
        }
    } else if (state === 'paused' || state === 'results') {
        if (input.hit('Escape', 'KeyP') && state === 'paused') resume();
        if (race) renderer.render(scene, camera);
    }
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 1) { window.__fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    input.endFrame();
}

document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

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
window.__game = { get race() { return race; }, get state() { return state; }, settings, startRace, camRig, input, renderer, scene, camera, simulate, startReplay, get replay() { return replay; }, renderRace: (dt) => renderRace(dt) };
boot();
