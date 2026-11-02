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
