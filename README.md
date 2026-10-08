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
- **Districts** – the city changes as you drive: downtown towers, midtown shopfronts
  with awnings and plazas, residential streets with houses, lawns and parked cars,
  parks with ponds, waterfront promenades and suspension bridges over the river,
  elevated railways crossing overhead.
- **Mountains** – huge ridges and valleys; the road bores through mountains in
  lit tunnels and crosses valleys on bridges, with steep drops off the road edge.
- **Traffic** – AI cars in both directions (Intelligent Driver Model, lane changes,
  honking, stopping for people crossing), with collisions. More car models can be
  dropped into `assets/models/traffic/` (see the README there).
- **Pedestrians** – animated people walk both sidewalks, wait for gaps and cross
  the road (some jaywalk), run from speeding cars and get knocked over if hit.
- **Police** – hitting people, crashing into cars or knocking down lamp posts raises
  your wanted level. Police cars chase, ram and set up roadblocks; stop near them
  and you are busted, stay out of sight to lose the heat. Police cars can be wrecked.
- **Damage** – crashes dent the actual car body, break lights, then the engine
  smokes, catches fire and finally explodes.
- **AI rivals** – race 1, 3 or 5 opponents in any mode, with live positions.
- **Ghost** – your best run on a track is saved and raced as a ghost car (use the
  *Daily* track, or *Race Again*).
- **Replay** – press `V` (or use the pause/results menus) to watch the last 45 s
  with trackside, orbit, helicopter and wheel cameras.
- **Rear-view mirror** – a real rendered mirror in the cockpit (HUD mirror in hood
  and bumper views). **Speed effects** – radial blur and speed lines at high speed.
- **Touch controls** on phones and tablets.
- **Game modes** – Time Attack (checkpoints add time), Sprint Race (5 km to the
  finish) or Free Roam. Score from distance, speed, near misses, drifts and a combo
  multiplier; best scores are saved.
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
| `V` | Instant replay |
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
- **Pedestrians**: "Michelle" (Mixamo) and a Ready Player Me avatar from the three.js
  examples; walk / run / idle animations from the three.js "Soldier" example (Mixamo),
  retargeted in code.
- [three.js](https://threejs.org) r160, MIT licence (`vendor/three/LICENSE`).
- Everything else (buildings, terrain, textures, sounds) is generated in code.
