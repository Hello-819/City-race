# City Race

An endless 3D street racer that runs in the browser (Three.js, no build step).
Drive real car models through procedurally generated city avenues or a winding
mountain pass, by day, at sunset or at night.

## Running it

The game uses ES modules and loads `.glb` models, so it has to be served over
HTTP (opening `index.html` straight from disk will not work):

```sh
# any static file server works, e.g.
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000. It also works as-is on GitHub Pages.

## Features

- **Real car models** – Ferrari 458 Italia and a Concept GT (glTF), with spinning
  and steering wheels, a turning steering wheel, brake/head lights and paint colours.
- **Cameras** – chase, far chase, **cockpit (interior)**, hood and bumper. Press `C`
  to cycle, `B` to look back, drag the mouse to look around.
- **Driving physics** – tyre model with load transfer and grip falloff, combined
  slip, torque curves, 6/7-speed gearbox (auto or manual), aero drag/downforce,
  brakes, handbrake drifts, and optional TCS / ESC / ABS assists.
- **Procedural world** – an endless road built from straights, clothoid-eased
  curves and grades that can never overlap itself.
  - *City*: generated blocks of glass, office, stone and brick buildings, sidewalks,
    street lights, trees, cross streets with crosswalks and signals, neon at night.
  - *Mountain*: heightfield terrain blended into the road (cuttings and
    embankments), pine forests, rocks, a lake, guardrails, curve chevrons and
    a distant snowy range.
- **Traffic** – AI cars in both directions (Intelligent Driver Model, lane changes,
  honking), with collisions.
- **Game modes** – Time Attack (checkpoints add time) or Free Roam. Score from
  distance, speed, near misses, drifts and a combo multiplier; best scores are saved.
- Synthesised engine/tyre/wind audio, HUD with tachometer and minimap,
  gamepad support, graphics quality settings.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake, hold when stopped to reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake |
| `C` | Change camera |
| `B` | Look back |
| `Q` / `E` | Shift down / up (manual gearbox) |
| `H` | Horn |
| `R` | Reset car onto the road |
| `Esc` / `P` | Pause |

## Project layout

```
index.html, style.css      page, menus and HUD markup
js/main.js                 boot, menus, race lifecycle, main loop
js/assets.js               car catalogue, glTF loading, car rigs (wheels, steering, LODs)
js/vehicle.js              vehicle dynamics
js/playerCar.js            player car: physics + road collisions + visuals
js/road.js                 procedural road centre-line + spatial queries
js/world/                  city & mountain generators, sky/lighting, streaming
js/traffic.js              AI traffic
js/cameraRig.js            camera modes
js/effects.js              tyre smoke and skid marks
js/hud.js, js/game.js      HUD and scoring rules
js/core/                   input, audio, seeded RNG / noise
assets/models/             car models (see credits)
vendor/three/              three.js r160 (MIT)
```

## Credits

- **Ferrari 458 Italia** model by [vicent091036](https://sketchfab.com/vicent091036)
  ([Sketchfab](https://skfb.ly/6o8yK)), as distributed with the three.js examples.
  The traffic version (`ferrari_lod.glb`) is a simplified derivative.
- **Car Concept** from the Khronos [glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept),
  CC BY 4.0, based on the public-domain "Free Concept Car 004" by Unity Fan.
  Textures were resized/recompressed and a simplified traffic version was made;
  Khronos logos are hidden in game.
- [three.js](https://threejs.org) r160, MIT licence (`vendor/three/LICENSE`).
- Everything else (buildings, terrain, textures, sounds) is generated in code.
