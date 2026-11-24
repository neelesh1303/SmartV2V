'use strict';
/**
 * SmartV2V simulation engine
 * --------------------------
 * A blind 4-way intersection (buildings on every corner block line-of-sight).
 * Every vehicle carries an On-Board Unit (OBU) that broadcasts a Basic Safety
 * Message (BSM) 10 times per second over a simulated wireless channel
 * (limited range, random packet loss, 10-50 ms latency).
 *
 * Each vehicle makes its driving decisions ONLY from what it perceives:
 *   - V2V ON : received BSMs (dead-reckoned to "now") + its own sensors
 *   - V2V OFF: its own sensors only (45 m range, blocked by buildings)
 *
 * Collision warning logic run on every OBU:
 *   FCW  - Forward Collision Warning   (time-to-collision with vehicle ahead)
 *   EEBL - Emergency Electronic Brake Light (vehicle ahead braking hard)
 *   ICW  - Intersection Collision Warning (crossing traffic will occupy the
 *          junction at the same time -> priority negotiation / yield)
 *   HAZ  - Stationary hazard (crashed vehicle) ahead
 */

const WORLD = 180;                 // metres (square world)
const C = WORLD / 2;               // intersection centre
const LANE_W = 4;                  // lane width (m)
const BOX = LANE_W;                // half-size of the conflict box
const SPAWN_MARGIN = 6;
const PATH_LEN = WORLD + SPAWN_MARGIN * 2;
const BSM_INTERVAL = 0.1;          // 10 Hz
const NEIGHBOR_TTL = 1.0;          // s before a neighbour entry expires
const SENSOR_RANGE = 45;           // m (radar/camera)
const MAX_BRAKE = 8.5;             // m/s^2
const COMFORT_DECEL = 3;           // m/s^2
const A_MAX = 1.8;                 // m/s^2
const ICW_MARGIN = 0.8;            // s safety margin between junction occupancies
const REACTION = 1.5;              // s perception-reaction delay without V2V (crossing traffic)

// Left-hand traffic (India). Screen coordinates: +y is down.
const APPROACHES = [
  { name: 'Eastbound', dx: 1, dy: 0, x0: -SPAWN_MARGIN, y0: C - LANE_W / 2 },
  { name: 'Westbound', dx: -1, dy: 0, x0: WORLD + SPAWN_MARGIN, y0: C + LANE_W / 2 },
  { name: 'Southbound', dx: 0, dy: 1, x0: C + LANE_W / 2, y0: -SPAWN_MARGIN },
  { name: 'Northbound', dx: 0, dy: -1, x0: C - LANE_W / 2, y0: WORLD + SPAWN_MARGIN },
];

const B_IN = LANE_W + 2;   // road half width + footpath
const B_SIZE = 70;
const BUILDINGS = [
  { x: C + B_IN, y: C + B_IN, w: B_SIZE, h: B_SIZE },
  { x: C - B_IN - B_SIZE, y: C + B_IN, w: B_SIZE, h: B_SIZE },
  { x: C + B_IN, y: C - B_IN - B_SIZE, w: B_SIZE, h: B_SIZE },
  { x: C - B_IN - B_SIZE, y: C - B_IN - B_SIZE, w: B_SIZE, h: B_SIZE },
];

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function lineOfSight(x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.ceil(d));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (const b of BUILDINGS) {
      if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return false;
    }
  }
  return true;
}

/** Time to travel distance d starting at speed v, accelerating at a up to vmax. */
function travelTime(d, v, a = 2.0, vmax = 12) {
  if (d <= 0) return 0;
  vmax = Math.max(vmax, v, 0.5);
  const t1 = (vmax - v) / a;
  const d1 = v * t1 + 0.5 * a * t1 * t1;
  if (d <= d1) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
  return t1 + (d - d1) / vmax;
}

const DEFAULT_CONFIG = {
  v2v: true,          // V2V communication enabled
  range: 120,         // radio range (m)
  loss: 0.05,         // packet loss probability
  spawnRate: 6,       // vehicles per minute per approach
  speed: 1,           // simulation speed multiplier
  paused: false,
};

class Simulation {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.t = 0;
    this.nextId = 1;
    this.vehicles = [];
    this.queue = [];             // in-flight radio packets
    this.events = [];
    this.nextSpawn = APPROACHES.map(() => Math.random() * 2);
    this.stats = {
      sent: 0, delivered: 0, dropped: 0, latencySum: 0,
      msgsPerSec: 0, warnings: 0, collisions: 0, passed: 0,
      _winStart: 0, _winSent: 0,
    };
  }

  setConfig(patch) {
    const c = this.config;
    if (typeof patch.v2v === 'boolean') {
      if (c.v2v !== patch.v2v) {
        this.log('sys', patch.v2v ? 'V2V communication ENABLED' : 'V2V communication DISABLED - sensors only');
        if (!patch.v2v) { for (const v of this.vehicles) v.nbrs.clear(); this.queue = []; }
      }
      c.v2v = patch.v2v;
    }
    if (Number.isFinite(patch.range)) c.range = clamp(patch.range, 20, 250);
    if (Number.isFinite(patch.loss)) c.loss = clamp(patch.loss, 0, 0.95);
    if (Number.isFinite(patch.spawnRate)) c.spawnRate = clamp(patch.spawnRate, 2, 30);
    if (Number.isFinite(patch.speed)) c.speed = clamp(patch.speed, 0.25, 3);
    if (typeof patch.paused === 'boolean') c.paused = patch.paused;
  }

  log(kind, msg) {
    this.events.push({ t: r1(this.t), kind, msg });
    if (this.events.length > 60) this.events.shift();
  }

  pos(v) {
    const a = APPROACHES[v.ap];
    return { x: a.x0 + a.dx * v.s, y: a.y0 + a.dy * v.s };
  }

  // ---------------------------------------------------------------- spawning
  spawn() {
    const mean = 60 / this.config.spawnRate;
    APPROACHES.forEach((ap, i) => {
      if (this.t < this.nextSpawn[i]) return;
      const onLane = this.vehicles.filter((v) => v.ap === i);
      const last = onLane.reduce((m, v) => (v.s < m.s ? v : m), { s: Infinity, v: 0 });
      if (last.s < 16) { this.nextSpawn[i] = this.t + 0.4; return; }
      const vDes = 10 + Math.random() * 5; // 36-54 km/h
      let v0 = vDes * (0.85 + Math.random() * 0.15);
      if (last.s < 45) v0 = Math.min(v0, last.v);
      this.vehicles.push({
        id: this.nextId++, ap: i, s: 0, v: v0, a: 0, vDes,
        len: 4.6, wid: 1.9, color: Math.floor(Math.random() * 8),
        alert: 0, alertType: '', role: 'CRUISE', ttc: null,
        braking: false, crashed: false, crashT: 0, hardBrakeUntil: 0,
        nbrs: new Map(), lastTx: this.t - Math.random() * BSM_INTERVAL,
        tx: 0, rx: 0, wait: 0, seen: new Map(),
      });
      this.nextSpawn[i] = this.t + Math.max(1.2, -Math.log(1 - Math.random()) * mean);
    });
  }

  // --------------------------------------------------------- V2V radio layer
  transmit() {
    const { range, loss } = this.config;
    for (const s of this.vehicles) {
      if (this.t - s.lastTx < BSM_INTERVAL) continue;
      s.lastTx = this.t;
      s.tx++;
      const p = this.pos(s);
      const ap = APPROACHES[s.ap];
      const bsm = {
        id: s.id, t: this.t, x: p.x, y: p.y, hx: ap.dx, hy: ap.dy,
        v: s.v, a: s.a, len: s.len, wid: s.wid,
        braking: s.braking, crashed: s.crashed, wait: s.wait,
      };
      this.stats.sent++;
      this.stats._winSent++;
      for (const r of this.vehicles) {
        if (r === s) continue;
        const q = this.pos(r);
        if (Math.hypot(q.x - p.x, q.y - p.y) > range) continue;
        if (Math.random() < loss) { this.stats.dropped++; continue; }
        const latency = 0.01 + Math.random() * 0.04;
        this.queue.push({ to: r.id, at: this.t + latency, latency, bsm });
      }
    }
  }

  deliver() {
    if (!this.queue.length) return;
    const byId = new Map(this.vehicles.map((v) => [v.id, v]));
    const pending = [];
    for (const pkt of this.queue) {
      if (pkt.at > this.t) { pending.push(pkt); continue; }
      const r = byId.get(pkt.to);
      if (!r) continue;
      r.nbrs.set(pkt.bsm.id, { bsm: pkt.bsm, rx: this.t });
      r.rx++;
      this.stats.delivered++;
      this.stats.latencySum += pkt.latency;
    }
    this.queue = pending;
  }

  // -------------------------------------------------------------- perception
  perceive(me) {
    const list = new Map();
    if (this.config.v2v) {
      for (const [id, e] of me.nbrs) {
        if (this.t - e.rx > NEIGHBOR_TTL) { me.nbrs.delete(id); continue; }
        const b = e.bsm;
        const age = this.t - b.t;
        const adv = b.crashed ? 0 : Math.max(0, b.v * age + 0.5 * b.a * age * age);
        list.set(id, {
          id, x: b.x + b.hx * adv, y: b.y + b.hy * adv, hx: b.hx, hy: b.hy,
          v: Math.max(0, b.v + b.a * age), len: b.len, braking: b.braking,
          crashed: b.crashed, wait: b.wait || 0, src: 'V2V', age,
        });
      }
    }
    // On-board sensors (radar / camera): short range, forward cone, need line-of-sight
    const p = this.pos(me);
    const ap = APPROACHES[me.ap];
    const seenNow = new Set();
    for (const o of this.vehicles) {
      if (o === me) continue;
      const q = this.pos(o);
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > SENSOR_RANGE) continue;
      if (d > 8 && (dx * ap.dx + dy * ap.dy) / d < 0.3) continue;
      if (!lineOfSight(p.x, p.y, q.x, q.y)) continue;
      const oa = APPROACHES[o.ap];
      const prev = list.get(o.id);
      if (!me.seen.has(o.id)) me.seen.set(o.id, this.t);
      seenNow.add(o.id);
      const crossing = Math.abs(oa.dx * ap.dx + oa.dy * ap.dy) < 0.3;
      if (!prev && crossing && !o.crashed && this.t - me.seen.get(o.id) < REACTION) continue;
      list.set(o.id, {
        id: o.id, x: q.x, y: q.y, hx: oa.dx, hy: oa.dy, v: o.v, len: o.len,
        braking: prev ? prev.braking : false, crashed: o.crashed, wait: prev ? prev.wait : 0,
        src: prev ? 'V2V+SENSOR' : 'SENSOR', age: 0,
      });
    }
    for (const id of me.seen.keys()) if (!seenNow.has(id)) me.seen.delete(id);
    return [...list.values()];
  }

  // ---------------------------------------------------------------- decision
  decide(me) {
    if (me.crashed) { me.a = 0; me.alert = 0; me.alertType = 'CRASHED'; me.role = 'CRASHED'; return; }
    const P = this.perceive(me);
    me.perceived = P;
    const ap = APPROACHES[me.ap];
    const p = this.pos(me);
    const v = me.v;
    let alert = 0, alertType = '', role = 'CRUISE', ttcMin = Infinity;
    const raise = (lvl, type) => { if (lvl > alert) { alert = lvl; alertType = type; } };

    // ---- car following (IDM) + FCW / EEBL / hazard
    let leader = null, lgap = Infinity;
    for (const o of P) {
      const along = ap.dx * (o.x - p.x) + ap.dy * (o.y - p.y);
      const lat = Math.abs(-ap.dy * (o.x - p.x) + ap.dx * (o.y - p.y));
      const same = o.hx * ap.dx + o.hy * ap.dy > 0.9;
      if (along > 0 && lat < 2.2 && (same || o.crashed)) {
        const gap = along - (me.len + o.len) / 2;
        if (gap < lgap) { lgap = gap; leader = o; }
      }
    }
    let acc;
    if (leader) {
      role = 'FOLLOW';
      const gap = Math.max(lgap, 0.1);
      const dv = v - leader.v;
      const sStar = Math.max(0, 2.5 + v * 1.3 + (v * dv) / (2 * Math.sqrt(A_MAX * COMFORT_DECEL)));
      acc = A_MAX * (1 - Math.pow(v / me.vDes, 4) - Math.pow(sStar / gap, 2));
      if (dv > 0.1) {
        const ttc = lgap / dv;
        ttcMin = Math.min(ttcMin, ttc);
        if (ttc < 2.0 || lgap < 1.5) raise(2, 'FCW');
        else if (ttc < 4.0) raise(1, 'FCW');
      }
      if (leader.crashed && lgap < 60) raise(lgap < 25 ? 2 : 1, 'HAZARD');
      if (leader.braking && lgap < 50) {
        raise(lgap < 20 ? 2 : 1, 'EEBL');
        if (lgap < 30) acc = Math.min(acc, -3);
      }
    } else {
      acc = A_MAX * (1 - Math.pow(v / me.vDes, 4));
    }

    // ---- intersection collision avoidance (ICW)
    const prog = (C - p.x) * ap.dx + (C - p.y) * ap.dy;
    const myEntry = prog - BOX - me.len / 2;
    const myExit = prog + BOX + me.len / 2;
    if (myExit > 0) {
      const tInMe = travelTime(Math.max(myEntry, 0), v, 2, Math.max(me.vDes, v));
      const tOutMe = travelTime(myExit, v, 2, Math.max(me.vDes, v));
      let mustYield = false;
      let conflict = false;
      for (const o of P) {
        if (Math.abs(o.hx * ap.dx + o.hy * ap.dy) > 0.3) continue; // only crossing traffic
        const oProg = (C - o.x) * o.hx + (C - o.y) * o.hy;
        const oEntry = oProg - BOX - o.len / 2;
        const oExit = oProg + BOX + o.len / 2;
        if (oExit < 0) continue;
        if (o.crashed) {
          if (oEntry < 0 && myEntry > 0) { mustYield = true; conflict = true; raise(myEntry < 30 ? 2 : 1, 'HAZARD'); }
          continue;
        }
        const tInO = travelTime(Math.max(oEntry, 0), o.v, 2, Math.max(12, o.v));
        const tOutO = travelTime(oExit, o.v, 2, Math.max(12, o.v));
        const overlap = tInMe < tOutO + ICW_MARGIN && tInO < tOutMe + ICW_MARGIN;
        if (!overlap) continue;
        conflict = true;
        ttcMin = Math.min(ttcMin, tInMe);
        let yieldHere;
        if (myEntry <= 0) yieldHere = false;              // already in the junction: clear it
        else if (oEntry <= 0) yieldHere = true;           // other already inside
        else {
          const myStop = (v * v) / (2 * Math.max(myEntry - 1, 0.1));
          const oStop = (o.v * o.v) / (2 * Math.max(oEntry - 1, 0.1));
          const meCan = myStop < 6, oCan = oStop < 6;
          if (o.wait > 2.5 && o.wait > me.wait && myStop < 3.5) yieldHere = true;          // fairness: waited longer
          else if (me.wait > 2.5 && me.wait > o.wait && oStop < 3.0) yieldHere = false;
          else if (meCan && !oCan) yieldHere = true;
          else if (!meCan && oCan) yieldHere = false;
          else if (Math.abs(tInMe - tInO) < 0.25) yieldHere = me.id > o.id;
          else yieldHere = tInMe > tInO;
        }
        if (yieldHere) mustYield = true;
      }
      if (mustYield && myEntry > 0) {
        role = 'YIELD';
        const stopDist = myEntry - 1.0;
        me.stopDist = stopDist;
        const need = (v * v) / (2 * Math.max(stopDist, 0.1));
        if (stopDist <= 0.3) acc = Math.min(acc, v > 0.2 ? -MAX_BRAKE : 0);
        else if (need > COMFORT_DECEL) acc = Math.min(acc, -need * 1.05);
        else {
          const vAllowed = Math.sqrt(2 * COMFORT_DECEL * 0.8 * Math.max(stopDist - 0.5, 0));
          acc = Math.min(acc, (vAllowed - v) * 1.5);
        }
        if (v < 0.3 && stopDist < 1.5) { acc = Math.min(acc, 0); me.v = 0; }
        raise(need > 3.5 || tInMe < 2 ? 2 : 1, alertType === 'HAZARD' ? 'HAZARD' : 'ICW');
      } else if (conflict) {
        role = 'PRIORITY';
        if (tInMe < 4) raise(1, 'ICW');
      }
    }

    // ---- injected emergency brake event
    if (me.hardBrakeUntil > this.t) { acc = -7; role = 'E-BRAKE'; raise(1, 'E-BRAKE'); }

    me.a = clamp(acc, -MAX_BRAKE, A_MAX);
    me.ttc = Number.isFinite(ttcMin) ? ttcMin : null;
    me.role = role;
    if (role !== 'YIELD') me.stopDist = Infinity;
    if (alert === 2 && me.alert < 2) {
      this.stats.warnings++;
      const label = { FCW: 'Forward Collision Warning', ICW: 'Intersection Collision Warning', EEBL: 'Emergency Brake Light ahead', HAZARD: 'Hazard ahead' }[alertType] || alertType;
      this.log('warn', `V${me.id} (${ap.name}): ${label}` + (me.ttc ? ` - TTC ${me.ttc.toFixed(1)}s` : ''));
    }
    me.alert = alert;
    me.alertType = alertType;
  }

  // -------------------------------------------------------- physics & safety
  integrate(dt) {
    for (const v of this.vehicles) {
      if (v.crashed) { v.v = 0; v.braking = false; continue; }
      v.v = Math.max(0, v.v + v.a * dt);
      v.s += v.v * dt;
      v.braking = v.a < -3 && v.v > 0.5;
      v.wait = v.role === 'YIELD' && v.v < 0.5 && v.stopDist < 4 ? v.wait + dt : 0;
    }
  }

  detectCollisions() {
    const V = this.vehicles;
    for (let i = 0; i < V.length; i++) {
      const a = V[i];
      const pa = this.pos(a);
      const ha = APPROACHES[a.ap].dx !== 0;
      const aw = ha ? a.len / 2 : a.wid / 2, ah = ha ? a.wid / 2 : a.len / 2;
      for (let j = i + 1; j < V.length; j++) {
        const b = V[j];
        if (a.crashed && b.crashed) continue;
        const pb = this.pos(b);
        const hb = APPROACHES[b.ap].dx !== 0;
        const bw = hb ? b.len / 2 : b.wid / 2, bh = hb ? b.wid / 2 : b.len / 2;
        if (Math.abs(pa.x - pb.x) < aw + bw - 0.05 && Math.abs(pa.y - pb.y) < ah + bh - 0.05) {
          for (const v of [a, b]) {
            if (!v.crashed) { v.crashed = true; v.crashT = this.t; v.v = 0; v.a = 0; }
          }
          this.stats.collisions++;
          this.log('crash', `COLLISION between V${a.id} and V${b.id}`);
        }
      }
    }
  }

  cleanup() {
    this.vehicles = this.vehicles.filter((v) => {
      if (v.crashed && this.t - v.crashT > 4) return false;
      if (v.s > PATH_LEN) { this.stats.passed++; return false; }
      return true;
    });
  }

  triggerEmergencyBrake() {
    const cands = this.vehicles.filter((v) => !v.crashed && v.v > 6 && this.vehicles.some(
      (o) => o !== v && o.ap === v.ap && o.s < v.s && v.s - o.s < 45));
    const pool = cands.length ? cands : this.vehicles.filter((v) => !v.crashed && v.v > 4);
    if (!pool.length) return null;
    const v = pool[Math.floor(Math.random() * pool.length)];
    v.hardBrakeUntil = this.t + 2.5;
    this.log('sys', `V${v.id} (${APPROACHES[v.ap].name}) performs EMERGENCY BRAKING`);
    return v.id;
  }

  step(dt) {
    this.t += dt;
    this.spawn();
    if (this.config.v2v) this.transmit();
    this.deliver();
    for (const v of this.vehicles) this.decide(v);
    this.integrate(dt);
    this.detectCollisions();
    this.cleanup();
    const s = this.stats;
    if (this.t - s._winStart >= 1) {
      s.msgsPerSec = Math.round(s._winSent / (this.t - s._winStart));
      s._winStart = this.t; s._winSent = 0;
    }
  }

  // ---------------------------------------------------------------- snapshot
  snapshot({ selected = null, links = false } = {}) {
    const s = this.stats;
    const attempted = s.delivered + s.dropped;
    const out = {
      t: r1(this.t),
      cfg: this.config,
      v: this.vehicles.map((v) => {
        const p = this.pos(v);
        return [v.id, r2(p.x), r2(p.y), v.ap, r1(v.v), v.alert, v.braking ? 1 : 0, v.crashed ? 1 : 0, v.color, v.nbrs.size, v.alertType];
      }),
      stats: {
        vehicles: this.vehicles.length,
        sent: s.sent,
        msgsPerSec: s.msgsPerSec,
        pdr: attempted ? Math.round((s.delivered / attempted) * 1000) / 10 : 100,
        latency: s.delivered ? Math.round((s.latencySum / s.delivered) * 1000) : 0,
        warnings: s.warnings,
        collisions: s.collisions,
        passed: s.passed,
      },
      events: this.events.splice(0),
    };
    if (links && this.config.v2v) {
      const L = [];
      for (const v of this.vehicles) for (const id of v.nbrs.keys()) if (v.id < id) L.push([v.id, id]);
      out.links = L;
    }
    const sel = selected && this.vehicles.find((v) => v.id === selected);
    if (sel) {
      const p = this.pos(sel);
      out.sel = {
        id: sel.id,
        approach: APPROACHES[sel.ap].name,
        speed: Math.round(sel.v * 3.6),
        accel: r1(sel.a),
        alert: sel.alert,
        alertType: sel.alertType,
        role: sel.role,
        ttc: sel.ttc != null ? r1(sel.ttc) : null,
        tx: sel.tx, rx: sel.rx,
        nbrs: (sel.perceived || []).map((o) => ({
          id: o.id,
          dist: Math.round(Math.hypot(o.x - p.x, o.y - p.y)),
          age: Math.round(o.age * 1000),
          src: o.src,
        })).sort((a, b) => a.dist - b.dist).slice(0, 8),
      };
    }
    return out;
  }
}

module.exports = { Simulation, WORLD, C, LANE_W, BOX, BUILDINGS, APPROACHES, SENSOR_RANGE };
