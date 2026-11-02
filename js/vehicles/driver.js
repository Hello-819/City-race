// ============================================================================
// NPC driver: steers a VehicleEntity along the road graph.
//
//  - Keeps to the right-hand lane of each road piece (edge), turning at
//    junctions onto a randomly chosen next edge ('cruise') or the edge that
//    heads towards a target ('pursue').
//  - Pure-pursuit steering on a short polyline (exit of this edge -> entry of
//    the next), speed limits per road type, slowing for turns.
//  - Stops at red traffic lights (signalised junctions), keeps a gap to
//    anything in front (cars, the player, pedestrians), honks when blocked and
//    sometimes swerves around the obstacle.
//  - 'pursue' mode (police) ignores lights and drives straight at the target
//    once it is close.
// ============================================================================
import { CONFIG } from '../config.js';
import { clamp } from '../core/rng.js';

export const LIGHT_CYCLE = 22;          // seconds for a full traffic light cycle
// Is the light green for traffic travelling along `axis` at node n?
export function lightState(n, axis, time) {
    const t = ((time / LIGHT_CYCLE + n.phase) % 1) * LIGHT_CYCLE;
    const half = LIGHT_CYCLE / 2;
    const mine = axis === 'x' ? t < half : t >= half;
    const local = t % half;
    if (!mine) return 'red';
    return local > half - 2.5 ? 'amber' : 'green';
}

export class Driver {
    constructor(game, vehicle, { mode = 'cruise', aggression = 0, lane = null } = {}) {
        this.game = game;
        this.v = vehicle;
        vehicle.driver = this;
        this.mode = mode;
        this.aggression = aggression;
        this.target = null;              // {x, y} for pursue
        this.pts = [];                   // polyline [{x, y, v, stop, node, axis}]
        this.edges = [];                 // [{e, fwd}] planned
        this.blockedT = 0;
        this.honkT = 0;
        this.swerve = 0;
        this.laneChoice = lane;
        this.stopped = false;            // forced stop (police deployed, driver fled...)
        this.speedFactor = 0.8 + Math.random() * 0.25;
    }

    // Start on the given edge (travel direction fwd), at along-distance s.
    placeOn(e, fwd, s) {
        const p = this._lanePt(e, fwd, s);
        const th = Math.atan2(fwd ? e.uy : -e.uy, fwd ? e.ux : -e.ux);
        this.v.place(p.x, p.y, th);
        const sp = e.speed * 0.6;
        this.v.veh.vx = Math.cos(th) * sp; this.v.veh.vy = Math.sin(th) * sp;
        this.edges = [];
        this.pts = [];
        this._pushEdge(e, fwd, s);
        this._plan();
    }

    // Join the road network from wherever the car is now.
    attachToRoad() {
        const r = this.game.map.nearestRoad(this.v.x, this.v.y, 400);
        if (!r) return false;
        const e = r.edge;
        const dirx = Math.cos(this.v.th), diry = Math.sin(this.v.th);
        const fwd = dirx * e.ux + diry * e.uy >= 0;
        this.edges = []; this.pts = [];
        this._pushEdge(e, fwd, fwd ? r.s : e.len - r.s);
        this._plan();
        return true;
    }

    _lane(e) { return this.laneChoice != null ? Math.min(this.laneChoice, e.lanes - 1) : e.lanes - 1; }
    _lanePt(e, fwd, s) {
        const off = (this._lane(e) + 0.5) * e.laneW;
        return this.game.map.edgePoint(e, fwd ? s : e.len - s, fwd ? off : -off, {});
    }

    // Append an edge's lane polyline (from s0 along the travel direction).
    _pushEdge(e, fwd, s0 = null) {
        const map = this.game.map;
        const nStart = map.nodes[fwd ? e.a : e.b], nEnd = map.nodes[fwd ? e.b : e.a];
        const cut0 = nStart.edges.length > 1 ? nStart.half + 1 : 0;
        const cut1 = nEnd.edges.length > 1 ? nEnd.half + 1.5 : 2;
        const a = s0 != null ? Math.max(s0, 0) : cut0;
        const b = Math.max(a + 0.5, e.len - cut1);
        const pa = this._lanePt(e, fwd, a), pb = this._lanePt(e, fwd, b);
        this.pts.push({ x: pa.x, y: pa.y, v: e.speed, edge: e });
        this.pts.push({ x: pb.x, y: pb.y, v: e.speed, edge: e, stop: nEnd.signal ? nEnd : null, node: nEnd, axis: e.axis, end: true });
        this.edges.push({ e, fwd, endNode: nEnd });
    }

    // Choose the next edge at the end node of the last planned edge.
    _plan() {
        const map = this.game.map;
        while (this.edges.length < 3) {
            const last = this.edges[this.edges.length - 1];
            const n = last.endNode;
            let opts = n.edges.map(id => map.edges[id]).filter(e => e !== last.e);
            if (!opts.length) opts = [last.e];          // dead end: turn around
            let pick;
            if (this.mode === 'pursue' && this.target) {
                let bd = Infinity;
                for (const e of opts) {
                    const other = map.nodes[e.a === n.id ? e.b : e.a];
                    const d = Math.hypot(other.x - this.target.x, other.y - this.target.y);
                    if (d < bd) { bd = d; pick = e; }
                }
            } else {
                // prefer going straight, avoid highways' exits being too common
                const straight = opts.find(e => e.axis === last.e.axis);
                pick = straight && Math.random() < 0.55 ? straight : opts[Math.floor(Math.random() * opts.length)];
            }
            const fwd = pick.a === n.id;
            // mark the junction turn speed on the previous exit point
            const prevEnd = this.pts[this.pts.length - 1];
            if (pick.axis !== last.e.axis || pick === last.e) prevEnd.v = Math.min(prevEnd.v, pick === last.e ? 4 : 7);
            this._pushEdge(pick, fwd);
        }
    }

    // Distance from the car to point i along the polyline (approx).
    update(dt, time) {
        const v = this.v, veh = v.veh;
        if (!v.alive) { v.controls = STOP; return; }
        if (this.stopped) { v.controls = this._speedCtl(0); return; }
        // drop passed points: when the car is beyond the 2nd point projected on segment 0-1
        while (this.pts.length > 2) {
            const a = this.pts[0], b = this.pts[1];
            const sx = b.x - a.x, sy = b.y - a.y, L2 = sx * sx + sy * sy || 1;
            const t = ((veh.x - a.x) * sx + (veh.y - a.y) * sy) / L2;
            if (t < 1) break;
            const gone = this.pts.shift();
            if (gone.end) { this.edges.shift(); this._plan(); }
        }
        const speed = veh.speed;
        // --- pursuit: drive straight at the target when close ---
        let tx, ty, vTarget;
        const direct = this.mode === 'pursue' && this.target && Math.hypot(this.target.x - veh.x, this.target.y - veh.y) < 55;
        if (direct) {
            tx = this.target.x; ty = this.target.y;
            const d = Math.hypot(tx - veh.x, ty - veh.y);
            vTarget = this.aggression > 0.5 ? 22 : clamp((d - 10) * 0.8, 0, 20);
            if (this.pts.length > 0 && this.retargetT === undefined) this.retargetT = 0;
        } else {
            const look = 5 + speed * 0.7;
            const p = this._lookahead(look);
            tx = p.x; ty = p.y;
            vTarget = this._edgeSpeed();
            if (this.mode === 'pursue') vTarget *= 1.35;
            // lights & turns ahead
            vTarget = Math.min(vTarget, this._junctionLimit(time));
        }
        // --- obstacles ---
        const gap = this._obstacleGap();
        if (gap < Infinity) {
            const stopDist = Math.max(0, gap - 2.5);
            vTarget = Math.min(vTarget, Math.sqrt(2 * 5 * stopDist));
        }
        if (gap < 6 && speed < 1) {
            this.blockedT += dt;
            if (this.blockedT > 2.5 && this.honkT <= 0) { this.honkT = 3 + Math.random() * 3; this.game.npcHonk(v); }
            if (this.blockedT > 5 && this.mode === 'cruise') this.swerve = 2.5 * (Math.random() < 0.5 ? 1 : -1);
        } else this.blockedT = Math.max(0, this.blockedT - dt);
        this.honkT -= dt;
        if (this.swerve) { this.swerve *= Math.exp(-dt * 0.6); if (Math.abs(this.swerve) < 0.1) this.swerve = 0; }
        // steering: pure pursuit (swerve shifts the aim point sideways)
        const sx = Math.sin(veh.th) * this.swerve, sy = -Math.cos(veh.th) * this.swerve;
        let err = Math.atan2(ty + sy - veh.y, tx + sx - veh.x) - veh.th;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        const ctl = this._speedCtl(vTarget * (direct ? 1 : this.speedFactor));
        // reverse out if pointing the wrong way and slow (stuck against a wall)
        if (Math.abs(err) > 2.2 && speed < 3) { ctl.steer = clamp(err * 2, -1, 1); }
        else ctl.steer = clamp(-err * 2.4, -1, 1);
        v.controls = ctl;
        // stuck detection: rejoin the road after being shoved about
        if (speed < 0.5 && vTarget > 3) {
            this.stuckT = (this.stuckT || 0) + dt;
            if (this.stuckT > 6) { this.stuckT = 0; this.attachToRoad(); }
        } else this.stuckT = 0;
    }

    _speedCtl(vt) {
        const veh = this.v.veh, v = veh.forwardSpeed;
        if (vt < 0.3 && Math.abs(v) < 0.8) return { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
        const thr = clamp((vt - v) * 0.35, 0, 1);
        const brk = v > vt + 0.8 ? clamp((v - vt) * 0.35, 0, 1) : 0;
        return { throttle: brk > 0 ? 0 : thr, brake: brk, steer: 0, handbrake: 0 };
    }

    _edgeSpeed() { return this.pts.length ? this.pts[0].edge.speed : 10; }

    // Point `dist` metres ahead along the polyline from the car's projection.
    _lookahead(dist) {
        const veh = this.v.veh, P = this.pts;
        if (P.length < 2) return P[0] || { x: veh.x, y: veh.y };
        const a = P[0], b = P[1];
        const sx = b.x - a.x, sy = b.y - a.y, L = Math.hypot(sx, sy) || 1;
        let t = clamp(((veh.x - a.x) * sx + (veh.y - a.y) * sy) / (L * L), 0, 1);
        let remain = dist;
        let i = 0, px = a.x + sx * t, py = a.y + sy * t;
        while (i + 1 < P.length) {
            const nx = P[i + 1].x, ny = P[i + 1].y;
            const seg = Math.hypot(nx - px, ny - py);
            if (seg >= remain) return { x: px + (nx - px) * remain / seg, y: py + (ny - py) * remain / seg };
            remain -= seg; px = nx; py = ny; i++;
        }
        return { x: px, y: py };
    }

    // Speed limit from the next junction: red light -> stop at the line; turn -> slow.
    _junctionLimit(time) {
        const veh = this.v.veh;
        let along = 0, px = veh.x, py = veh.y, limit = Infinity;
        for (let i = 1; i < this.pts.length && along < 80; i++) {
            const p = this.pts[i];
            along += Math.hypot(p.x - px, p.y - py);
            px = p.x; py = p.y;
            if (!p.end) continue;
            if (p.stop && this.mode !== 'pursue') {
                const st = lightState(p.stop, p.axis, time);
                const dStop = along;
                // amber: stop if there is room, otherwise go through
                if (st === 'red' || (st === 'amber' && dStop > veh.speed * 1.2 + 4)) limit = Math.min(limit, Math.sqrt(2 * 4 * Math.max(0, dStop - 1)));
            }
            limit = Math.min(limit, Math.sqrt(p.v * p.v + 2 * 3.5 * along));
            break;
        }
        return limit;
    }

    // Distance to the nearest thing in our path (cars, player, pedestrians).
    _obstacleGap() {
        const g = this.game, veh = this.v.veh;
        const c = Math.cos(veh.th), s = Math.sin(veh.th);
        const look = 8 + veh.speed * 1.6;
        const hw = veh.P.halfWidth + 0.4;
        let best = Infinity;
        const test = (x, y, r) => {
            const dx = x - veh.x, dy = y - veh.y;
            const lx = dx * c + dy * s - veh.P.halfLength;
            if (lx < -1 || lx > look) return;
            const ly = -dx * s + dy * c;
            if (Math.abs(ly) < hw + r) best = Math.min(best, Math.max(0, lx - r));
        };
        for (const o of g.vehicles) {
            if (o === this.v || Math.abs(o.x - veh.x) > look + 8 || Math.abs(o.y - veh.y) > look + 8) continue;
            test(o.x, o.y, o.veh.P.halfLength * 0.8);
        }
        const p = g.player;
        if (!p.vehicle && !(this.mode === 'pursue' && this.aggression > 0.5)) test(p.x, p.y, 0.5);
        if (this.mode !== 'pursue') for (const ped of g.peds.active) if (!ped.dead && Math.abs(ped.x - veh.x) < look + 2 && Math.abs(ped.y - veh.y) < look + 2) test(ped.x, ped.y, 0.4);
        return best;
    }
}

const STOP = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
export { CONFIG };
