// ============================================================================
// CONFIG: every gameplay tuning value lives in this one file.
// Change numbers here; no other file should hard-code balance values.
// Units: metres, seconds, m/s, dollars.
// ============================================================================

export const CONFIG = {
    // ------------------------------------------------------------------------
    // Time & environment: a single persistent world with one continuous cycle.
    time: {
        dayLengthMinutes: 24,      // real minutes for one full 24 h game day
        startHour: 9.5,            // clock when a new game starts
        envRefreshHours: 0.5,      // re-bake reflections every N game hours
        fogNear: 120,
        fogFar: 2200,              // view distance in clear daylight
    },

    // ------------------------------------------------------------------------
    // Map layout. The island is generated deterministically from `seed`.
    // All zone sizes are half-widths of squares centred on the origin and must
    // be multiples of `chunkSize` so blocks never straddle chunks.
    map: {
        seed: 1337,
        size: 8000,                // world square (m). Everything outside is open ocean.
        cityHalf: 1200,            // downtown grid (dense towers)
        suburbHalf: 2400,          // suburbs (houses, shops)
        ring: 2880,                // highway ring road half-size
        cityBlock: 120,            // road spacing downtown
        suburbBlock: 240,          // road spacing in suburbs
        countrySpacing: 960,       // road spacing in the countryside
        spurEnd: 3360,             // beach access roads reach this far out
        coastRadius: 3720,         // average distance of the coastline (superellipse)
        coastNoise: 160,
        beachWidth: 170,
        mountainY: 3000,           // mountains rise north of this line
        mountainHeight: 340,
        seaLevel: 0,
        landBase: 3,
        hills: { city: 2, suburb: 6, country: 20 },    // terrain amplitude per zone
        downtownRadius: 520,       // skyscrapers inside this radius
        towerHeight: [60, 210],
        midriseHeight: [14, 60],
    },

    // Chunk streaming: near chunks have full detail, far chunks a cheap LOD.
    streaming: {
        chunkSize: 240,
        nearRadius: 500,           // full detail (props, textures, shadows)
        farRadius: 1450,           // low detail beyond this nothing but the horizon mesh
        buildBudgetMs: 6,          // max time per frame spent building chunks
        maxCachedData: 600,        // chunk data (colliders) kept in memory
    },

    // Road types: half width (m), lanes per direction, lane width, speed limit (m/s)
    roads: {
        highway: { half: 7.5, lanes: 2, laneW: 3.5, speed: 28, sidewalk: 0, tex: 'city' },
        city: { half: 7.5, lanes: 2, laneW: 3.5, speed: 15, sidewalk: 4, tex: 'city' },
        suburb: { half: 4.9, lanes: 1, laneW: 3.6, speed: 13, sidewalk: 3, tex: 'mountain' },
        country: { half: 4.9, lanes: 1, laneW: 3.6, speed: 22, sidewalk: 0, tex: 'mountain' },
    },

    // ------------------------------------------------------------------------
    // Weapons. damage per hit (x pellets), fireRate shots/s, reload s,
    // clip/maxAmmo rounds, recoil = camera kick (rad), spread = hip-fire cone
    // (rad), aimSpread = aimed cone, bloom = extra spread per shot.
    weapons: {
        order: ['unarmed', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper'],
        unarmed: { name: 'Fists', melee: true, damage: 15, fireRate: 2.2, range: 1.8 },
        pistol: { name: 'Pistol', damage: 26, fireRate: 4, auto: false, clip: 12, reload: 1.3, maxAmmo: 240, recoil: 0.03, spread: 0.03, aimSpread: 0.006, bloom: 0.01, range: 120, pellets: 1, sound: 'pistol' },
        smg: { name: 'SMG', damage: 15, fireRate: 13, auto: true, clip: 30, reload: 1.8, maxAmmo: 480, recoil: 0.014, spread: 0.05, aimSpread: 0.018, bloom: 0.005, range: 80, pellets: 1, sound: 'smg' },
        shotgun: { name: 'Shotgun', damage: 13, fireRate: 1.2, auto: false, clip: 8, reload: 2.8, maxAmmo: 96, recoil: 0.09, spread: 0.11, aimSpread: 0.07, bloom: 0.02, range: 40, pellets: 9, sound: 'shotgun' },
        rifle: { name: 'Assault Rifle', damage: 30, fireRate: 9, auto: true, clip: 30, reload: 2.2, maxAmmo: 360, recoil: 0.022, spread: 0.04, aimSpread: 0.007, bloom: 0.004, range: 220, pellets: 1, sound: 'rifle' },
        sniper: { name: 'Sniper Rifle', damage: 160, fireRate: 0.8, auto: false, clip: 5, reload: 3.0, maxAmmo: 60, recoil: 0.12, spread: 0.08, aimSpread: 0.0004, bloom: 0, range: 700, pellets: 1, sound: 'sniper', zoom: 0.32 },
        headshotMultiplier: 2.5,
        wheelTimeScale: 0.3,           // world speed while the weapon wheel is open
        startWeapons: { pistol: 48 },  // weapon -> ammo for a new game
    },

    // ------------------------------------------------------------------------
    // Vehicle catalog. body = procedural shape (vehicles/carModels.js) or a
    // glTF model id ('ferrari', 'concept'). hp/mass drive the physics,
    // health = damage before it catches fire and explodes, price = dealership.
    vehicles: {
        hatch: { name: 'Brio Hatch', body: 'hatch', hp: 105, mass: 1050, health: 900, price: 9000 },
        compact: { name: 'Pico City', body: 'compact', hp: 80, mass: 900, health: 800, price: 6500 },
        saloon: { name: 'Meridian Saloon', body: 'saloon', hp: 150, mass: 1400, health: 1000, price: 16000 },
        estate: { name: 'Voyager Estate', body: 'estate', hp: 140, mass: 1500, health: 1000, price: 15000 },
        coupe: { name: 'Strada Coupe', body: 'coupe', hp: 190, mass: 1300, health: 900, price: 22000 },
        suv: { name: 'Ridge SUV', body: 'suv', hp: 230, mass: 2100, health: 1300, price: 30000 },
        pickup: { name: 'Mule Pickup', body: 'pickup', hp: 210, mass: 2000, health: 1300, price: 21000 },
        van: { name: 'Courier Van', body: 'van', hp: 130, mass: 2300, health: 1300, price: 18000 },
        minivan: { name: 'Family Mover', body: 'minivan', hp: 160, mass: 1800, health: 1100, price: 19000 },
        boxtruck: { name: 'Box Truck', body: 'boxtruck', hp: 220, mass: 5500, health: 2000, price: 35000 },
        taxi: { name: 'Taxi', body: 'saloon', hp: 150, mass: 1400, health: 1000, price: 14000, livery: 'taxi' },
        bus: { name: 'City Bus', body: 'bus', hp: 300, mass: 11000, health: 3000, price: 60000 },
        limo: { name: 'Stretch Limo', body: 'limo', hp: 250, mass: 2600, health: 1400, price: 45000 },
        // rare / special
        sports: { name: 'Concept GT', body: 'concept', health: 1000, price: 120000, rare: true },
        supercar: { name: 'Ferrari 458 Italia', body: 'ferrari', health: 1000, price: 250000, rare: true },
        classic: { name: 'Vintage Roadster', body: 'classic', hp: 180, mass: 1100, health: 900, price: 85000, rare: true },
        policeInterceptor: { name: 'Police Interceptor', body: 'saloon', hp: 380, mass: 1600, health: 1600, price: 0, livery: 'police', rare: true, notForSale: true },
        police: { name: 'Police Cruiser', body: 'saloon', hp: 300, mass: 1600, health: 1500, livery: 'police', notForSale: true },
    },

    // ------------------------------------------------------------------------
    npc: {
        pedCount: 26,                  // pooled pedestrians kept around the player
        spawnMin: 45, spawnMax: 150, despawn: 190,
        walkSpeed: [1.1, 1.6], runSpeed: 5.2,
        health: 100,
        armedChance: 0.12,             // civilians carrying a pistol (fight back)
        callPoliceChance: 0.3,         // witnesses who phone the police
        callTime: 4,                   // seconds on the phone before police are told
        reactRadius: 45,               // gunshots are heard this far
        accuracy: 0.35,                // armed civilian hit chance per shot
        cashDrop: [10, 80],
    },

    // Wanted level (1-5 stars) and police response
    police: {
        crimes: {                       // stars added (if below) for each crime
            shooting: 1, assault: 1, pedKilled: 1, carJack: 1, copHurt: 2, copKilled: 3, vehicleDestroyed: 1, policeCarJack: 2,
        },
        cars: [0, 1, 2, 3, 4, 6],      // police cars chasing per star level
        officers: [0, 2, 3, 4, 6, 8],  // max officers on foot near you
        accuracy: [0, 0.2, 0.28, 0.36, 0.45, 0.55],
        damage: [0, 8, 10, 12, 14, 16],
        sightRange: 90,                // officers see you within this range
        evadeTime: [0, 10, 14, 18, 24, 30],  // seconds unseen to lose the stars
        spawnDistance: [160, 260],
        bustTime: 2.5,                 // seconds held by an officer on foot = busted
        bustFee: 500, hospitalFee: 200,
    },

    // ------------------------------------------------------------------------
    player: {
        jogSpeed: 3.4,
        sprintSpeed: 6.6,
        walkSpeed: 1.5,             // while aiming
        swimSpeed: 1.6,
        jumpSpeed: 4.6,
        radius: 0.35,
        enterVehicleRange: 3.2,
        exitMaxSpeed: 9,            // m/s; above this you cannot bail out
        startMoney: 500,
        spawn: { x: 10, y: -60 },   // on the downtown pavement
    },

    camera: {
        mouseSensitivity: 0.0022,
        footDistance: 3.8,
        footHeight: 1.55,
        shoulder: 0.55,
        aimDistance: 1.7,
        aimFov: 50,
        fov: 62,
        vehicleRecenter: 1.6,       // seconds before the car camera swings back behind
    },

    // Key bindings (KeyboardEvent.code). Change them here.
    keys: {
        enterExit: ['KeyF'],
        weaponWheel: ['KeyQ', 'Tab'],
        sprint: ['ShiftLeft', 'ShiftRight'],
        jump: ['Space'],
        reload: ['KeyR'],
        interact: ['KeyE'],
        map: ['KeyM'],
        horn: ['KeyH'],
        camera: ['KeyC'],
        lookBack: ['KeyB'],
        pause: ['Escape', 'KeyP'],
        fastTime: ['KeyT'],         // hold to fast-forward the clock (handy for testing)
    },
};
