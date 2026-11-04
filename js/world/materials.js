// Shared world materials. Every chunk reuses these, so there is one material
// per surface type for the whole map (cheap to update at dusk: windows,
// street lamps and signs glow according to the day/night factor).
import * as THREE from 'three';
import {
    roadTexture, sidewalkTexture, concreteTexture, facadeTextures, roofTexture, houseTextures,
    detailTexture, crosswalkTexture, glowTexture, bannerTexture,
} from '../textures.js';

let M = null;

export function worldMaterials() {
    if (M) return M;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const offset = (m, f) => { m.polygonOffset = true; m.polygonOffsetFactor = f; m.polygonOffsetUnits = f; return m; };
    M = {
        terrain: std({ vertexColors: true, map: detailTexture(), roughness: 0.97 }),
        horizon: std({ vertexColors: true, roughness: 1 }),
        roadCity: offset(std({ map: roadTexture('city'), roughness: 0.88 }), -2),
        roadCountry: offset(std({ map: roadTexture('mountain'), roughness: 0.88 }), -2),
        asphalt: offset(std({ map: concreteTexture(), color: 0x6c6c6e, roughness: 0.9 }), -2),
        crosswalk: offset(std({ map: crosswalkTexture(), transparent: true, roughness: 0.8, depthWrite: false, side: THREE.DoubleSide }), -4),
        pavement: offset(std({ map: sidewalkTexture(), roughness: 0.92 }), -1),
        parking: offset(std({ map: concreteTexture(), color: 0x55565a, roughness: 0.9 }), -3),
        roof: std({ map: roofTexture(), roughness: 0.95 }),
        houseRoof: std({ color: 0x6e3b30, roughness: 0.85 }),
        barn: std({ color: 0x8a2a20, roughness: 0.85 }),
        metal: std({ color: 0x2c3036, metalness: 0.6, roughness: 0.45 }),
        lampHead: std({ color: 0xfff0d0, emissive: 0xffd9a0, emissiveIntensity: 0 }),
        lightPool: new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffc77a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
        trunk: std({ color: 0x5a4030, roughness: 1 }),
        leaves: std({ color: 0xffffff, roughness: 0.9 }),
        rock: std({ color: 0x7c776e, roughness: 1, flatShading: true }),
        concrete: std({ map: concreteTexture(), color: 0xb8b4ac, roughness: 0.95, side: THREE.DoubleSide }),
        ocean: std({ color: 0x1b4a63, roughness: 0.1, metalness: 0.05, transparent: true, opacity: 0.86 }),
        farBuildings: null,
        facade: {},
        house: [],
        signs: new Map(),
    };
    for (const style of ['glass', 'office', 'stone', 'brick']) {
        const t = facadeTextures(style);
        M.facade[style] = std({
            map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0,
            roughness: style === 'glass' ? 0.25 : 0.8, metalness: style === 'glass' ? 0.5 : 0.05,
        });
    }
    for (let v = 0; v < 6; v++) {
        const t = houseTextures(v);
        M.house.push(std({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.85 }));
    }
    const ft = facadeTextures('office');
    M.farBuildings = std({ map: ft.map, vertexColors: true, emissive: 0xffffff, emissiveMap: ft.emissive, emissiveIntensity: 0, roughness: 0.8 });
    return M;
}

// Shop / service signs (cached by type).
const SIGN = {
    hospital: ['HOSPITAL', 'EMERGENCY  +', '#c62828'],
    police: ['POLICE', 'STATION', '#1e4fa8'],
    gun: ['AMMU-SHOP', 'FIREARMS', '#2e2e2e'],
    clothes: ['THREADS', 'CLOTHING', '#8e24aa'],
    dealership: ['MOTORS', 'NEW & USED CARS', '#00796b'],
    convenience: ['24/7', 'CONVENIENCE STORE', '#e65100'],
    cafe: ['CAFE', 'FOOD & COFFEE', '#6d4c41'],
};
export const SPECIAL_NAMES = {
    hospital: 'Hospital', police: 'Police Station', gun: 'Gun Shop', clothes: 'Clothing Store',
    dealership: 'Car Dealership', convenience: '24/7 Store', cafe: 'Café',
};
export function signMaterial(type) {
    const m = worldMaterials();
    if (!m.signs.has(type)) {
        const [a, b, c] = SIGN[type] || [type.toUpperCase(), '', '#333'];
        const tex = bannerTexture(a, b, c);
        m.signs.set(type, new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, roughness: 0.6 }));
    }
    return m.signs.get(type);
}

// Day/night response of every glowing material (0 = day, 1 = night).
export function setWorldNight(n) {
    const m = worldMaterials();
    for (const f of Object.values(m.facade)) f.emissiveIntensity = n * 1.3;
    for (const h of m.house) h.emissiveIntensity = n * 0.9;
    m.farBuildings.emissiveIntensity = n * 1.4;
    m.lampHead.emissiveIntensity = n * 4;
    m.lightPool.opacity = n * 0.55;
    for (const s of m.signs.values()) s.emissiveIntensity = 0.25 + n * 1.2;
}
