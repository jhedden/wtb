// Code shared by the server (Node) and the client (browser): constants, map, collision.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const C = {
    W: 3000,
    H: 2000,
    BOX: 40,             // box edge length (visual)
    R: 18,               // collision radius
    WALK: 150,           // px/s — decoys move at exactly this speed
    SPRINT: 270,         // px/s — faster than any decoy, so it gives you away
    TURN: 7,             // rad/s body turn rate (same for decoys and players)
    STAMINA_MAX: 100,
    STAMINA_DRAIN: 45,   // per second while sprinting
    STAMINA_REGEN: 20,
    SLASH_RANGE: 72,
    SLASH_ARC: Math.PI * 0.65,
    SLASH_CD_HIT: 0.45,  // cooldown after cutting a player
    SLASH_CD_MISS: 1.3,  // cooldown after whiffing / cutting a decoy
    Z_REACH: 40,         // a slash only reaches boxes within this height of you
    STEP: 14,            // highest ledge a box can walk up without stairs
    RESPAWN: 3,
    ROUND: 180,
    INTERMISSION: 8,
    DECOYS: 90,
    TICK: 30,
    SNAP: 20,
    VARIANTS: 4,
    POWER_CHANCE: 0.17,  // share of decoys hiding a power-up
    SPEED_MULT: 1.35,
    REACH_MULT: 1.6,
    PICKUP_MAX: 6,       // power-ups lying on the floor at once
    PICKUP_EVERY: 7,     // average seconds between new floor power-ups
    PICKUP_R: 28,        // walk within this distance of one to grab it
  };

  // Power-ups hidden inside some decoys. Cut one open to get it. `dur` is in seconds.
  const POWERS = {
    speed: { name: 'Turbo Tape', icon: '⚡', color: '#5fb4ff', dur: 10, desc: 'Faster, and sprinting is free' },
    reach: { name: 'Long Blade', icon: '🗡️', color: '#ff7a5c', dur: 12, desc: 'Your slash reaches further' },
    quick: { name: 'Fresh Blade', icon: '✂️', color: '#57e389', dur: 12, desc: "Misses don't slow your cutter" },
    shield: { name: 'Bubble Wrap', icon: '🫧', color: '#dff1ff', dur: 30, desc: 'Blocks the next cut' },
    radar: { name: 'X-Ray Specs', icon: '👓', color: '#c77dff', dur: 6, desc: 'Real players are marked' },
  };

  // ---------- map ----------
  // The warehouse is four rooms joined by doorways, with three raised areas reached by stairs.
  const T = 40;   // outer wall thickness
  const IW = 30;  // interior wall thickness

  const ROOMS = [
    { name: 'MAIN HALL', x: T, y: T, w: 1860, h: 1260, lx: 1050, ly: 1022 },
    { name: 'LOADING DOCK', x: T, y: 1330, w: 1860, h: 630, lx: 920, ly: 1650 },
    { name: 'OFFICE', x: 1930, y: T, w: 1030, h: 960, lx: 2445, ly: 420 },
    { name: 'STORAGE', x: 1930, y: 1030, w: 1030, h: 930, lx: 2470, ly: 1470 },
  ];

  // Axis-aligned solid rectangles {x, y, w, h, kind}
  const OBSTACLES = [];
  const DOORS = []; // gaps in interior walls (for drawing door frames)
  const add = (kind, x, y, w, h) => OBSTACLES.push({ x, y, w, h, kind });

  // outer walls
  add('wall', 0, 0, C.W, T);
  add('wall', 0, C.H - T, C.W, T);
  add('wall', 0, 0, T, C.H);
  add('wall', C.W - T, 0, T, C.H);

  // An interior wall along one axis, from `from` to `to`, with [a, b] door gaps.
  function wallRun(axis, at, from, to, gaps) {
    const seg = (a, b) => { if (b > a) axis === 'h' ? add('wall', a, at, b - a, IW) : add('wall', at, a, IW, b - a); };
    let s = from;
    for (const [a, b] of gaps) {
      seg(s, a);
      DOORS.push(axis === 'h' ? { x: a, y: at, w: b - a, h: IW } : { x: at, y: a, w: IW, h: b - a });
      s = b;
    }
    seg(s, to);
  }
  wallRun('h', 1300, T, 1900, [[420, 560], [1100, 1240], [1640, 1780]]);        // hall | dock
  wallRun('v', 1900, T, C.H - T, [[480, 620], [1080, 1220], [1560, 1700]]);     // west | east wing
  wallRun('h', 1000, 1930, C.W - T, [[2380, 2520]]);                             // office | storage

  // Raised floors. Nothing goes underneath them; their edges are ledges you can drop off.
  const PLATFORMS = [
    { x: T, y: T, w: 600, h: 300, top: 70 },                     // hall mezzanine
    { x: T, y: 1720, w: 1860, h: C.H - T - 1720, top: 60 },      // loading dock platform
    { x: 2600, y: 1500, w: C.W - T - 2600, h: C.H - T - 1500, top: 90 }, // storage loft
  ];
  // Ramps of steps. `up` is the direction you walk to climb them; they reach `top` at that end.
  const STAIRS = [
    { x: 500, y: 340, w: 120, h: 220, top: 70, up: 'n' },
    { x: 260, y: 1540, w: 120, h: 180, top: 60, up: 's' },
    { x: 1500, y: 1540, w: 120, h: 180, top: 60, up: 's' },
    { x: 2380, y: 1560, w: 220, h: 120, top: 90, up: 'e' },
  ];

  // main hall
  add('shelf', 760, 220, 400, 50);
  add('shelf', 1300, 220, 400, 50);
  add('shelf', 700, 560, 50, 380);
  add('shelf', 1600, 560, 50, 380);
  add('shelf', 220, 1120, 400, 50);
  add('shelf', 760, 1120, 400, 50);
  add('shelf', 1300, 1120, 400, 50);
  add('crate', 1010, 690, 120, 120);
  add('pillar', 870, 540, 56, 56);
  add('pillar', 1210, 540, 56, 56);
  add('pillar', 870, 900, 56, 56);
  add('pillar', 1210, 900, 56, 56);
  add('crate', 240, 760, 80, 80);
  add('crate', 1760, 760, 80, 80);
  add('crate', 1360, 400, 70, 70);
  add('crate', 140, 130, 70, 70);       // up on the mezzanine
  // loading dock
  add('crate', 640, 1450, 90, 90);
  add('crate', 1000, 1520, 70, 70);
  add('crate', 1250, 1420, 80, 80);
  add('crate', 1760, 1450, 80, 80);
  add('crate', 800, 1820, 100, 80);     // on the dock platform
  add('crate', 1150, 1800, 80, 80);
  // office
  for (const y of [200, 560]) for (const x of [2040, 2340, 2640]) add('desk', x, y, 160, 80);
  add('cabinet', 2900, 700, 60, 220);
  add('cabinet', 1960, 820, 200, 50);
  // storage
  add('shelf', 2020, 1120, 50, 300);
  add('shelf', 2200, 1120, 50, 300);
  add('shelf', 2000, 1780, 300, 50);
  add('crate', 2700, 1150, 80, 80);
  add('crate', 2450, 1250, 70, 70);
  add('crate', 2800, 1620, 80, 80);     // up in the loft

  // Floor paint, shared so both clients draw the same warehouse.
  const ZONES = [
    { x: 1930, y: T, w: 1030, h: 960, kind: 'carpet' },
    { x: T, y: 1330, w: 1860, h: 390, kind: 'dock' },
  ];
  const LANES = [
    [660, 430, 1860, 430], [80, 1075, 1860, 1075], [820, 430, 820, 1075], [1430, 430, 1430, 1075],
    [80, 1620, 1860, 1620],
  ];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  // Floor height at (x, y): 0, a platform's top, or somewhere along a staircase.
  function groundAt(x, y) {
    let g = 0;
    for (const p of PLATFORMS) if (p.top > g && inRect(p, x, y)) g = p.top;
    for (const s of STAIRS) {
      if (!inRect(s, x, y)) continue;
      const f = s.up === 'n' ? (s.y + s.h - y) / s.h
        : s.up === 's' ? (y - s.y) / s.h
        : s.up === 'e' ? (x - s.x) / s.w
        : (s.x + s.w - x) / s.w;
      g = Math.max(g, clamp(f, 0, 1) * s.top);
    }
    return g;
  }

  // Highest floor under a box's footprint: boxes rest on a ledge until they're fully off it,
  // and can't get any closer to a ledge they're unable to climb than their own half-width.
  function groundUnder(x, y, r = C.R * 0.85) {
    return Math.max(groundAt(x, y), groundAt(x + r, y), groundAt(x - r, y), groundAt(x, y + r), groundAt(x, y - r));
  }

  // Push a circle {x, y} of radius r out of every obstacle.
  function resolve(p, r = C.R) {
    for (let i = 0; i < OBSTACLES.length; i++) {
      const o = OBSTACLES[i];
      const cx = clamp(p.x, o.x, o.x + o.w);
      const cy = clamp(p.y, o.y, o.y + o.h);
      const dx = p.x - cx, dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.y = cy + (dy / d) * r;
      } else {
        // centre inside the rect: push out through the nearest edge
        const l = p.x - o.x, rt = o.x + o.w - p.x, t = p.y - o.y, b = o.y + o.h - p.y;
        const m = Math.min(l, rt, t, b);
        if (m === l) p.x = o.x - r;
        else if (m === rt) p.x = o.x + o.w + r;
        else if (m === t) p.y = o.y - r;
        else p.y = o.y + o.h + r;
      }
    }
    p.x = clamp(p.x, T + r, C.W - T - r);
    p.y = clamp(p.y, T + r, C.H - T - r);
  }

  // Move a box {x, y, z} by (dx, dy): walls block it, and so do ledges more than STEP above
  // its feet (z). It slides along a ledge when only one axis is blocked. Returns distance moved.
  function moveBox(p, dx, dy) {
    const ox = p.x, oy = p.y;
    const ok = () => groundUnder(p.x, p.y) <= (p.z || 0) + C.STEP;
    p.x = ox + dx; p.y = oy + dy; resolve(p);
    if (!ok()) {
      p.x = ox + dx; p.y = oy; resolve(p);
      if (!ok()) {
        p.x = ox; p.y = oy + dy; resolve(p);
        if (!ok()) { p.x = ox; p.y = oy; }
      }
    }
    return Math.hypot(p.x - ox, p.y - oy);
  }

  function isFree(x, y, r = C.R + 4) {
    for (const o of OBSTACLES) {
      const cx = clamp(x, o.x, o.x + o.w), cy = clamp(y, o.y, o.y + o.h);
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return false;
    }
    return x > T + r && y > T + r && x < C.W - T - r && y < C.H - T - r;
  }

  // Random free location at least minDist from every point in `avoid`.
  function freeSpot(avoid = [], minDist = 0) {
    for (let tries = 0; tries < 400; tries++) {
      const x = 60 + Math.random() * (C.W - 120);
      const y = 60 + Math.random() * (C.H - 120);
      if (!isFree(x, y)) continue;
      const md = tries < 300 ? minDist : minDist / 3;
      if (avoid.every(a => (a.x - x) ** 2 + (a.y - y) ** 2 >= md * md)) return { x, y, z: groundUnder(x, y) };
    }
    return { x: 1000, y: 460, z: 0 };
  }

  function angleDiff(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function turnToward(a, target, maxStep) {
    const d = angleDiff(a, target);
    return a + clamp(d, -maxStep, maxStep);
  }

  // Is point (tx, ty) inside the slash cone from (x, y) aiming `aim`? (Height is checked separately.)
  function inSlash(x, y, aim, tx, ty, range = C.SLASH_RANGE) {
    const dx = tx - x, dy = ty - y;
    const d = Math.hypot(dx, dy);
    if (d > range + C.R) return false;
    if (d < C.R * 1.4) return true;
    return Math.abs(angleDiff(aim, Math.atan2(dy, dx))) <= C.SLASH_ARC / 2;
  }

  return { C, POWERS, ROOMS, OBSTACLES, DOORS, PLATFORMS, STAIRS, ZONES, LANES, clamp, groundAt, groundUnder, resolve, moveBox, isFree, freeSpot, angleDiff, turnToward, inSlash };
});
