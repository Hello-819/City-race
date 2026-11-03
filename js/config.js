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
        // island bounds (m): ~7.8 km wide, ~11.8 km tall; the city sits in the
        // south, countryside, a river and mountains fill the north
        bounds: { x0: -4100, x1: 4100, y0: -4100, y1: 8100 },
        cityHalf: 1200,            // downtown grid (dense towers)
        suburbHalf: 2400,          // suburbs (houses, shops)
        ring: 2880,                // highway ring road half-size (elevated at junctions)
        ringCornerRadius: 220,     // curved highway corners
        cityBlock: 120,            // road spacing downtown
        suburbBlock: 240,          // road spacing in suburbs
        countrySpacing: 960,       // road spacing in the countryside
        countryLines: [-1920, -960, 0, 960, 1920],
        countryReach: 3650,        // country roads run out towards the beaches...
        northRows: [3840, 4800, 5760],   // ...and up through the northern farmland
        coastCenterY: 2000,        // the island is an ellipse-ish superellipse:
        coastRadiusX: 3900,
        coastRadiusY: 5900,
        coastNoise: 160,
        beachWidth: 170,
        mountainY: 5900,           // mountains rise north of this line
        mountainHeight: 360,
        // highway interchanges: flyover height, ramp distances
        flyover: { clearance: 7.5, rampLength: 150, rampOut: 170, rampIn: 120 },
        river: {                   // a river from the mountains to the west coast
            points: [[-1300, 6250], [-1500, 5300], [-1250, 4300], [-1450, 3400], [-1440, 2900], [-1560, 2690],
                [-2100, 2640], [-3000, 2600], [-4300, 2560]],
            width: 44, bank: 40, depth: 3.5,
        },
        mountainRoad: [[0, 5760], [380, 6080], [-280, 6380], [480, 6720], [-180, 7020], [320, 7300], [120, 7480]],
        maxGrade: 0.085,
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
        ramp: { half: 4.9, lanes: 1, laneW: 3.6, speed: 16, sidewalk: 0, tex: 'mountain' },
        mountain: { half: 4.9, lanes: 1, laneW: 3.6, speed: 14, sidewalk: 0, tex: 'mountain' },
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
        // body: a Kenney Car Kit model (assets/models/vehicles/kenney/<body>.glb),
        // or 'ferrari' / 'concept' for the two detailed glTF supercars.
        // fixedColor keeps the model's own livery; paintMaterial limits
        // recolouring to one paint material on two-tone models.
        hatch: { name: 'Brio Hatch', body: 'hatchbackSports', hp: 120, mass: 1100, health: 900, price: 9000 },
        saloon: { name: 'Meridian Saloon', body: 'sedan', hp: 150, mass: 1400, health: 1000, price: 16000 },
        coupe: { name: 'Strada GT', body: 'sedanSports', hp: 230, mass: 1350, health: 950, price: 26000 },
        suv: { name: 'Ridge SUV', body: 'suv', hp: 230, mass: 2100, health: 1300, price: 30000 },
        suvLuxury: { name: 'Ridge Luxe', body: 'suvLuxury', hp: 300, mass: 2250, health: 1350, price: 48000 },
        pickup: { name: 'Mule Pickup', body: 'truck', hp: 210, mass: 2000, health: 1300, price: 21000 },
        flatbed: { name: 'Mule Flatbed', body: 'truckFlat', hp: 220, mass: 2300, health: 1400, price: 24000 },
        van: { name: 'Courier Van', body: 'van', hp: 130, mass: 2300, health: 1300, price: 18000 },
        boxtruck: { name: 'Box Truck', body: 'delivery', hp: 220, mass: 5500, health: 2000, price: 35000, paintMaterial: 'paintGreen' },
        lorry: { name: 'Flatbed Lorry', body: 'deliveryFlat', hp: 240, mass: 6000, health: 2100, price: 38000, paintMaterial: 'paintGreen' },
        taxi: { name: 'Taxi', body: 'taxi', hp: 150, mass: 1400, health: 1000, price: 14000, fixedColor: true },
        ambulance: { name: 'Ambulance', body: 'ambulance', hp: 260, mass: 3500, health: 1800, price: 0, fixedColor: true, notForSale: true },
        firetruck: { name: 'Fire Engine', body: 'firetruck', hp: 380, mass: 12000, health: 3500, price: 0, fixedColor: true, notForSale: true },
        tractor: { name: 'Field Tractor', body: 'tractor', hp: 110, mass: 3200, health: 1600, price: 12000 },
        digger: { name: 'Digger', body: 'tractorShovel', hp: 140, mass: 5200, health: 2200, price: 0, notForSale: true },
        // rare / special
        sports: { name: 'Concept GT', body: 'concept', health: 1000, price: 120000, rare: true },
        supercar: { name: 'Ferrari 458 Italia', body: 'ferrari', health: 1000, price: 250000, rare: true },
        classic: { name: 'Vintage Racer', body: 'race', hp: 260, mass: 1000, health: 900, price: 85000, rare: true },
        prototype: { name: 'Apex Prototype', body: 'raceFuture', hp: 520, mass: 1050, health: 1000, price: 180000, rare: true },
        policeInterceptor: { name: 'Police Interceptor', body: 'police', hp: 380, mass: 1600, health: 1600, price: 0, rare: true, notForSale: true, fixedColor: true, livery: 'police' },
        police: { name: 'Police Cruiser', body: 'police', hp: 320, mass: 1600, health: 1500, fixedColor: true, livery: 'police', notForSale: true },
        policeTractor: { name: 'Police Tractor', body: 'tractorPolice', hp: 140, mass: 3200, health: 1600, fixedColor: true, livery: 'police', notForSale: true },
    },

    // ------------------------------------------------------------------------
    // Traffic. Tune spawn rates HERE.
    traffic: {
        maxCars: 34,                   // NPC cars around the player (downtown)
        density: { city: 1, suburb: 0.6, country: 0.3, highway: 0.5 },
        spawnRadius: [110, 240],       // spawn between these distances
        despawnRadius: 300,
        minGap: 14,                    // don't spawn closer than this to another car
        // relative weights of the normal civilian models
        weights: { hatch: 14, saloon: 18, coupe: 6, suv: 10, suvLuxury: 5, pickup: 8, flatbed: 4, van: 8, boxtruck: 5, lorry: 3, taxi: 10, ambulance: 1.2, firetruck: 0.6 },
        // extra weights used out in the countryside
        countryWeights: { tractor: 6, digger: 2, pickup: 6, flatbed: 4 },
        // rare cars: independent chance PER SPAWN (rolled before the normal pick)
        rare: { supercar: 1 / 200, sports: 1 / 50, classic: 1 / 120, prototype: 1 / 300, policeInterceptor: 1 / 150 },
        rareGlow: true,                // glowing ring + floating label on rare cars
        rareNotify: true,              // HUD message when one spawns nearby
        honkChance: 0.5,
        busSpeedFactor: 0.75,
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
    // Shops, prices and ways to earn money.
    shops: {
        // how many of each building exist on the map
        counts: { hospital: 4, police: 3, gun: 5, clothes: 6, dealership: 3, convenience: 10, cafe: 8 },
        // gun shop: weapon price, ammo pack size and pack price
        guns: {
            pistol: { price: 400, ammoPack: 24, ammoPrice: 40 },
            smg: { price: 1500, ammoPack: 60, ammoPrice: 90 },
            shotgun: { price: 2200, ammoPack: 16, ammoPrice: 80 },
            rifle: { price: 4500, ammoPack: 60, ammoPrice: 150 },
            sniper: { price: 9000, ammoPack: 10, ammoPrice: 200 },
        },
        // clothing store outfits (kind: character model; top / bottom colours)
        outfits: [
            // kind = character model (man / michelle / Quaternius characters);
            // top / bottom recolour Alex's clothes, tint recolours the others.
            { id: 'default', name: 'Alex · street casual', price: 0, kind: 'man', top: '#2b3a55', bottom: '#1f1f22' },
            { id: 'red', name: 'Alex · red bomber', price: 250, kind: 'man', top: '#9a1c1c', bottom: '#202020' },
            { id: 'white', name: 'Alex · summer whites', price: 400, kind: 'man', top: '#e8e6df', bottom: '#cfc8b4' },
            { id: 'gold', name: 'Alex · high roller', price: 2500, kind: 'man', top: '#c9a227', bottom: '#111111' },
            { id: 'michelle', name: 'Michelle · classic', price: 800, kind: 'michelle', tint: '#ffffff' },
            { id: 'worker', name: 'Hi-vis worker', price: 300, kind: 'm_Worker', noTint: true },
            { id: 'punk', name: 'Punk', price: 600, kind: 'm_Punk', noTint: true },
            { id: 'adventurer', name: 'Adventurer', price: 900, kind: 'm_Adventurer', noTint: true },
            { id: 'farmer', name: 'Farmer', price: 350, kind: 'm_Farmer', noTint: true },
            { id: 'w-suit', name: 'Business suit', price: 1500, kind: 'w_Suit', noTint: true },
            { id: 'w-punk', name: 'Punk (women)', price: 600, kind: 'w_Punk', noTint: true },
            { id: 'w-adventurer', name: 'Explorer', price: 900, kind: 'w_Adventurer', noTint: true },
        ],
        convenience: [
            { id: 'snack', name: 'Snack bar', desc: '+25 health', price: 10, health: 25 },
            { id: 'medkit', name: 'First-aid kit', desc: 'Full health', price: 90, health: 100 },
            { id: 'vest', name: 'Light armour', desc: '+50 armour', price: 150, armour: 50 },
            { id: 'heavy', name: 'Heavy armour', desc: 'Full armour', price: 280, armour: 100 },
        ],
        cafe: [
            { id: 'coffee', name: 'Coffee', desc: '+15 health', price: 5, health: 15 },
            { id: 'sandwich', name: 'Club sandwich', desc: '+40 health', price: 15, health: 40 },
            { id: 'meal', name: 'Full breakfast', desc: 'Full health', price: 40, health: 100 },
        ],
        // vehicles the dealership sells (prices come from CONFIG.vehicles)
        dealership: ['hatch', 'saloon', 'coupe', 'suv', 'suvLuxury', 'pickup', 'flatbed', 'van', 'boxtruck', 'tractor', 'classic', 'sports', 'prototype', 'supercar'],
        garageSlots: 8,
    },

    economy: {
        packages: 60,                 // hidden packages scattered over the island
        packageReward: 750,
        packageRadarRange: 120,       // they show up on the radar when this close
        jobPay: { base: 150, perMetre: 0.3, timeBonus: 2 },   // courier jobs ($, $/m, $/s left)
        jobDistance: [500, 1800],
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
        controls: ['F1'],           // show the controls overlay
        fastTime: ['KeyT'],         // hold to fast-forward the clock (handy for testing)
    },
};
