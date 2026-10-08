import { ARROW, CASTLE } from './config.js';
import { animalVelocity } from './animals.js';
import { clamp } from './utils.js';

const EDGE = { kind: 'edge' };
const LEAD_DOUBT = 0.5;

// Everything `team`'s arrows can hit, as capsules {x, y, h, r}.
export function collectObstacles(m, team) {
  const obs = [];
  for (const a of m.animals) obs.push({ kind: 'animal', ref: a, x: a.x, y: a.y, h: 0, r: a.r });
  for (const c of m.board.castles) {
    obs.push({
      kind: c.team === team ? 'home' : 'castle', ref: m.castles[c.team],
      x: c.x, y: c.y, h: CASTLE.halfLen, r: CASTLE.r,
    });
  }
  return obs;
}

// An arrow is spent on whatever onHit says 'stop' for, and bounces off everything else
// until it runs out of bounces.
function contact(ar, nx, ny, o, onHit) {
  const res = onHit(o, ar);
  if (res === 'stop' || ar.bouncesLeft <= 0) {
    ar.done = true;
    return;
  }
  ar.bouncesLeft--;
  const dot = ar.dx * nx + ar.dy * ny;
  ar.dx -= 2 * dot * nx;
  ar.dy -= 2 * dot * ny;
  const l = Math.hypot(ar.dx, ar.dy) || 1;
  ar.dx /= l;
  ar.dy /= l;
}

// Advances the arrow `distance` px in small sub-steps. onHit(obstacle, arrow) applies the
// effect and returns 'stop' if the arrow is spent on it.
export function stepArrow(ar, obs, board, distance, onHit) {
  const R0 = ARROW.radius;
  let left = distance;
  while (left > 0 && !ar.done) {
    const d = Math.min(ARROW.step, left);
    left -= d;
    ar.x += ar.dx * d;
    ar.y += ar.dy * d;

    let hit = null, hx = 0, hy = 0, depth = 0;
    for (const o of obs) {
      if (o.dead) continue;
      let ex = ar.x - clamp(ar.x, o.x - o.h, o.x + o.h), ey = ar.y - o.y;
      const dd = Math.hypot(ex, ey), R = o.r + R0;
      if (dd >= R) continue;
      if (dd > 1e-4) { ex /= dd; ey /= dd; } else { ex = -ar.dx; ey = -ar.dy; }
      if (ar.dx * ex + ar.dy * ey >= 0) continue; // already moving away
      if (R - dd > depth) { depth = R - dd; hit = o; hx = ex; hy = ey; }
    }
    if (hit) {
      contact(ar, hx, hy, hit, onHit);
      ar.x += hx * (depth + 0.5);
      ar.y += hy * (depth + 0.5);
      continue;
    }

    if (board.fieldG(ar.x, ar.y, R0) >= 1) {
      const N = board.fieldN(ar.x, ar.y, R0);
      if (ar.dx * N.x + ar.dy * N.y > 0) contact(ar, -N.x, -N.y, EDGE, onHit);
      for (let k = 0; k < 16 && board.fieldG(ar.x, ar.y, R0) >= 1; k++) {
        ar.x -= N.x;
        ar.y -= N.y;
      }
    }
  }
}

// Where each arrow of `team`'s volley starts: line abreast across the line of fire,
// centred on the launch point.
export function volleyStarts(m, team, angle) {
  const L = m.board.castles[team].launch, n = m.teams[team].arrows;
  const px = -Math.sin(angle), py = Math.cos(angle), starts = [];
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * ARROW.spread;
    starts.push({ x: L.x + px * off, y: L.y + py * off });
  }
  return starts;
}

// A frozen copy of the field for dry runs. With `lead`, animals carry their current
// velocity so the dry run can move them while the arrows are in the air.
function freeze(m, team, lead) {
  return collectObstacles(m, team).map(o => {
    const v = lead && o.kind === 'animal' ? animalVelocity(o.ref) : { x: 0, y: 0 };
    return { ...o, x0: o.x, y0: o.y, vx: v.x, vy: v.y, left: o.ref.left };
  });
}

// Dry run of a whole volley against frozen obstacles `obs`, loosed `start` seconds from
// now. The arrows step together, as they do in flight, so one that kills an animal lets
// its neighbours fly on. Returns what the volley brings in; with `paths`, also fills it
// with each arrow's start and contacts.
// doubt: how much of the ground an animal covers before an arrow reaches it counts as
// uncertainty about where it will be. Meat from a hit is marked down by the odds that
// the animal is still in the way, so a far-off sprinter is worth less than a near grazer.
function dryVolley(m, team, angle, obs, { start = 0, maxContacts = Infinity, paths = null, doubt = 0 } = {}) {
  const damage = m.teams[team].damage, res = { meat: 0, castle: 0 };
  let t = start;
  const arrows = volleyStarts(m, team, angle).map(p => ({
    x: p.x, y: p.y, dx: Math.cos(angle), dy: Math.sin(angle),
    bouncesLeft: Math.min(ARROW.bounces, maxContacts - 1), done: false,
    pts: paths ? [{ x: p.x, y: p.y, kind: 'start' }] : null,
  }));
  if (paths) for (const ar of arrows) paths.push(ar.pts);
  const onHit = (o, ar) => {
    if (ar.pts) ar.pts.push({ x: ar.x, y: ar.y, kind: o.kind, ox: o.x, oy: o.y, r: o.r });
    if (o.kind === 'animal') {
      const gain = o.ref.fast ? o.left : Math.min(o.left, damage), stray = o.ref.speed * t * doubt;
      o.left -= gain;
      res.meat += gain * Math.min(1, (o.r + ARROW.radius) / (stray || 1));
      if (o.left <= 0) o.dead = true;
      return 'stop';
    }
    if (o.kind === 'castle') {
      res.castle += ARROW.castleDamage;
      return 'stop';
    }
  };
  const chunk = 6;
  for (let i = 0; i < 400 && arrows.some(ar => !ar.done); i++) {
    t = start + (i * chunk) / ARROW.speed;
    for (const o of obs) {
      o.x = o.x0 + o.vx * t;
      o.y = o.y0 + o.vy * t;
    }
    for (const ar of arrows) if (!ar.done) stepArrow(ar, obs, m.board, chunk, onHit);
  }
  return res;
}

// What a whole volley fired at `angle`, `start` seconds from now, can be expected to bring
// in. Used by the AI to pick its shot. Leading an animal only guesses at its path, since
// it may turn; not leading it leaves all of its movement to chance.
export function simulateVolley(m, team, angle, lead = false, start = 0) {
  return dryVolley(m, team, angle, freeze(m, team, lead), { start, doubt: lead ? LEAD_DOUBT : 1 });
}

// Aim preview: for each arrow of the volley, its start and up to two contacts against
// the field as it stands right now. Animals are not led, so quick ones take judgement.
export function previewPath(m, team, angle) {
  const paths = [];
  dryVolley(m, team, angle, freeze(m, team, false), { maxContacts: 2, paths });
  return paths;
}
