# City Race

An open-world crime-sandbox game that runs in the browser (Three.js, no build
step). Explore one persistent 8 × 8 km island on foot or by car: a downtown of
towers, suburbs, a highway ring, countryside, beaches and a mountain range,
all under a continuous day/night cycle.

## Running it

The game uses ES modules and loads `.glb` models, so serve it over HTTP
(opening `index.html` straight from disk will not work):

```sh
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000 and click **Start**. Click the game view to
capture the mouse. Progress is saved in the browser (localStorage).

## Features

- **One persistent world**: no modes. One clock runs continuously (24 minutes per game
  day by default) and drives the sun, moon, sky, fog, street lamps and lit windows.
- **Seamless open map**: a generated 8 × 8 km island streamed in 240 m chunks.
  Nearby chunks get full detail; distant chunks get one merged low-detail mesh; a
  coarse whole-island horizon mesh and an endless ocean fill the rest. Chunks are
  built within a per-frame time budget, so there are no loading screens. The map edge
  is sea all round, with mountains to the north.
- **On foot**: walk, sprint, jump and swim. Get in and out of any car with `F`, and
  pull NPC drivers out of theirs (carjacking).
- **Weapons**: pistol, SMG, shotgun, assault rifle and sniper rifle (plus fists), each
  with its own damage, fire rate, reload time, ammo, recoil and accuracy. Aim with
  right mouse (the crosshair tightens, the sniper rifle zooms). Hits show hit markers
  and shots show muzzle flashes and tracers; sound effects are generated in code.
  Hold `Q`/`Tab` for a **radial weapon wheel** that slows time.
- **Reactive NPCs**: pedestrians walk the pavements. When violence breaks out they
  flee, phone the police, or (if armed) shoot back. Drivers panic, honk and swerve.
- **Health, armour, death**: "WASTED" respawns you at the nearest hospital (for a fee).
- **Wanted level (1–5 stars)**: police cars chase you and officers get out and fight.
  Stay out of sight to lose the stars. Stand still next to an officer and you are
  "BUSTED".
- **Enterable shops**: gun shop, clothing store, car dealership with a garage,
  24/7 store (health and armour) and café (food restores health). Each fades into its
  own interior and returns you to the same spot outside.
- **Money**: cash dropped by NPCs, 60 hidden packages and timed courier jobs (yellow
  `J` markers by 24/7 stores).
- **Traffic**: 13 civilian models and 4 rare ones (sports car 1/50, supercar 1/200,
  classic 1/120, police interceptor 1/150 per spawn). Rare cars have a glowing ring
  and a label. AI drivers follow lanes, stop at traffic lights and keep their distance.
  Vehicles take damage, smoke, catch fire and explode.

## Controls

| On foot | | In a vehicle | |
|---|---|---|---|
| `WASD` | move (`Shift` sprint, `Space` jump) | `W` / `S` | throttle / brake & reverse |
| mouse | look | `A` / `D` | steer |
| right mouse | aim | `Space` | handbrake |
| left mouse | shoot | `H` | horn |
| hold `Q` / `Tab` | weapon wheel | `C` / `B` | camera / look back |
| mouse wheel | next weapon | `F` | get out |
| `R` | reload | | |
| `E` | doors, shop counter, jobs | | |
| `F` | enter / steal a vehicle | | |

`M` map · `Esc`/`P` pause · hold `T` to fast-forward time. Bindings are in
`CONFIG.keys` (`js/config.js`).

## Tuning

**Every balance value is in [`js/config.js`](js/config.js)**: the map size and zones,
streaming radii, road speeds, weapon stats, wanted-level rules, NPC behaviour,
vehicle catalog (power, mass, health, price), shop prices, rewards, traffic density
and rare spawn rates (`CONFIG.traffic.rare`), the day length and key bindings.

## Project layout

```
js/config.js               all tuning values
js/main.js                 boot, title menu (Start / Options / Quit), pause, render loop
js/game/game.js            gameplay glue: owns and updates every system
js/game/save.js            save / load (localStorage)
js/game/pickups.js         cash, ammo, health pickups and packages
js/game/jobs.js            hidden packages and courier jobs
js/world/map.js            island layout: zones, terrain, road graph, blocks, buildings, colliders
js/world/chunkBuilder.js   chunk meshes (near / far LOD), instanced props, horizon
js/world/streamer.js       chunk streaming, ocean
js/world/materials.js      shared materials + night lighting
js/world/environment.js    continuous day/night sky and lighting
js/vehicles/vehicleEntity.js  vehicle physics on terrain, collisions, damage, fire, explosions
js/vehicles/carModels.js   procedural vehicle models + physics per catalog entry
js/vehicles/driver.js      AI driver: lanes, junctions, traffic lights, gaps, pursuit
js/vehicles/traffic.js     traffic spawning, pooling, rare cars, traffic lights
js/npc/peds.js             pedestrians and police officers on foot
js/npc/police.js           wanted level and police response
js/player/player.js        on-foot controller, aiming pose (IK), health
js/player/camera.js        third-person orbit camera + vehicle cameras
js/weapons/weapons.js      weapon inventory, firing, recoil, spread
js/weapons/combat.js       hitscan, line of sight, tracers / muzzle flashes
js/shops/interiors.js      enterable interiors with fade transitions
js/shops/shopUI.js         shop menus and purchases
js/ui/hud.js, mapView.js   HUD, radar, full map
js/ui/weaponWheel.js       radial weapon wheel
js/core/                   input (keyboard, mouse lock, gamepad), audio, RNG / noise
js/vehicle.js, collide.js  tyre physics model and rotated-box collisions
js/assets.js, textures.js  glTF car / people loading, canvas textures
```

## Credits

- **Vehicles**: [Car Kit](https://kenney.nl/assets/car-kit) by Kenney (www.kenney.nl), CC0 1.0.
  Scaled to real-world size, with glass, interiors and physics added in code.

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
