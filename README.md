# Harbor Heat

An open-world crime sandbox that runs in the browser (Three.js, no build
step). Explore Isla Coral, one persistent island of about 7.8 x 11.8 km, on foot
or by car. It has a downtown of towers, suburbs, a highway ring with flyovers and
curved interchanges, farmland, a river with bridges, beaches, and a
switchback road up into the mountains, all under a continuous day/night cycle.

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

- **One persistent world**: a single clock runs the day/night cycle (24 minutes per game
  day by default), with lit windows, street lamps and headlights at night.
- **Seamless open map**: streamed in 240 m chunks with near and far levels of detail,
  a horizon mesh and an endless ocean. The view distance follows the graphics preset
  and adapts automatically to hold the frame rate (press `F3` for live stats).
- **Roads**: a city grid, curved highway corners, 20 flyover interchanges with curved
  ramps, river bridges, and a 3.7 km mountain pass. Physics knows which level you are
  on (deck or road below), and cars can fly off ledges.
- **Traffic**: real car models (Kenney Car Kit) with see-through glass, modelled
  interiors and a cockpit view. AI drivers follow lanes and traffic lights, give
  way, overtake, honk, swerve and panic. Rare cars (sports 1/50, supercar 1/200,
  classic, prototype, police interceptor) glow and get a label. Parked cars line the
  suburbs and fill the car parks.
- **On foot**: 12 character models (Mixamo-animated and Quaternius), ragdoll deaths,
  and a two-handed aiming pose.
- **Weapons**: pistol, SMG, shotgun, assault rifle and sniper rifle, chosen from a radial
  wheel (time slows while it is open). Drive-bys work from cars. Bullets hit people,
  cars, walls, trees and poles. Cars knock lamp posts and trees down.
- **NPCs and police**: pedestrians flee, phone the police or fight back. The wanted
  level runs from 1 to 5 stars; police plan A* routes to you, and officers deploy and
  shoot. Lose them by breaking line of sight.
- **Shops** (three interior styles per type): gun shop, clothing (outfits and
  characters), car dealership and garage, 24/7 store, café, and hospital treatment.
- **Money and missions**: five story missions (yellow M), courier jobs (J), 60 hidden
  packages, and cash dropped by NPCs. The GPS draws a route to every objective, or to a
  waypoint you click on the map.

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

- **Characters**: "Ultimate Modular Men / Women" packs by [Quaternius](https://quaternius.com), CC0 1.0.

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
