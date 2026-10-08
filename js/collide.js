// 2D collision helpers shared by all vehicles (map frame).

// Oriented-rectangle overlap (separating axis). Returns {nx, ny, depth} pushing A out of B.
export function obbOverlap(ax, ay, ath, ahl, ahw, bx, by, bth, bhl, bhw) {
    const axes = [[Math.cos(ath), Math.sin(ath)], [-Math.sin(ath), Math.cos(ath)], [Math.cos(bth), Math.sin(bth)], [-Math.sin(bth), Math.cos(bth)]];
    const dx = ax - bx, dy = ay - by;
    let best = null;
    const proj = (th, hl, hw, nx, ny) => hl * Math.abs(Math.cos(th) * nx + Math.sin(th) * ny) + hw * Math.abs(-Math.sin(th) * nx + Math.cos(th) * ny);
    for (const [nx, ny] of axes) {
        const ra = proj(ath, ahl, ahw, nx, ny), rb = proj(bth, bhl, bhw, nx, ny);
        const dist = dx * nx + dy * ny;
        const overlap = ra + rb - Math.abs(dist);
        if (overlap <= 0) return null;
        if (!best || overlap < best.depth) best = { nx: nx * Math.sign(dist || 1), ny: ny * Math.sign(dist || 1), depth: overlap };
    }
    return best;
}

// Contact point estimate: midpoint between the two centres pulled to A's surface.
export function contactPoint(ax, ay, bx, by, hit) {
    return { x: (ax + bx) / 2, y: (ay + by) / 2 };
}

// Two dynamic vehicles (Vehicle instances). Returns closing speed (m/s) or 0.
export function vehicleVsVehicle(a, b, e = 0.25) {
    if (Math.abs(a.x - b.x) > 7 || Math.abs(a.y - b.y) > 7) return null;
    const hit = obbOverlap(a.x, a.y, a.th, a.P.halfLength, a.P.halfWidth, b.x, b.y, b.th, b.P.halfLength, b.P.halfWidth);
    if (!hit) return null;
    const ma = a.P.mass, mb = b.P.mass;
    const wa = mb / (ma + mb), wb = ma / (ma + mb);
    a.x += hit.nx * hit.depth * wa; a.y += hit.ny * hit.depth * wa;
    b.x -= hit.nx * hit.depth * wb; b.y -= hit.ny * hit.depth * wb;
    const rvx = a.vx - b.vx, rvy = a.vy - b.vy;
    const vn = rvx * hit.nx + rvy * hit.ny;
    if (vn >= 0) return { speed: 0, hit };
    const j = -(1 + e) * vn / (1 / ma + 1 / mb);
    a.vx += j / ma * hit.nx; a.vy += j / ma * hit.ny;
    b.vx -= j / mb * hit.nx; b.vy -= j / mb * hit.ny;
    // yaw kicks from off-centre contact
    const side = (v, nx, ny) => Math.cos(v.th) * ny - Math.sin(v.th) * nx;
    a.r += side(a, hit.nx, hit.ny) * Math.min(0.4, -vn * 0.02);
    b.r -= side(b, hit.nx, hit.ny) * Math.min(0.4, -vn * 0.02);
    return { speed: -vn, hit };
}
