// One game arena: decoys, bots, players, rounds. server.js creates one per game mode.
const { WebSocketServer } = require('ws');
const { C, POWERS, resolve, moveBox, groundUnder, freeSpot, turnToward, inSlash } = require('./shared');

const now = () => performance.now() / 1000;
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const LEVEL_GAP = 30; // boxes further apart in height than this don't bump into each other

const POWER_TYPES = Object.keys(POWERS);
const randomPower = () => (Math.random() < C.POWER_CHANCE ? POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)] : null);

const BOT_NAMES = ['Boxy McBoxface', 'Cardboard Carl', 'Flap Jack', 'Tape Worm', 'Corrugated Cora', 'Packrat', 'Shipping Sheila', 'Fragile Fred', 'Bubble Wrap Bob', 'Parcel Pam'];

// opts.canSee      — (player, x, y) => bool: could this human currently see that spot?
// opts.botFill     — bots top up the lobby to this many players
// opts.moveDecoys  — whether decoys wander around (players can toggle it in game)
function createGame({ canSee, botFill, moveDecoys = false }) {
  const BOT_FILL = botFill;
  const options = { moveDecoys };

  // ---------- game state ----------
  const players = new Map(); // id -> player (humans and bots)
  let decoys = [];
  let nextId = 1;
  let phase = 'play';
  let phaseEnd = now() + C.ROUND;
  let pickups = [];          // power-ups lying on the floor: {id, x, y, z, type, pickup: true}
  let nextPickupId = 1;
  let nextPickupAt = now() + 3;

  // Every box on the field gets an opaque random key so snapshots don't reveal who is a player.
  const usedKeys = new Set();
  function newKey() {
    let k;
    do { k = Math.floor(Math.random() * 2 ** 31); } while (usedKeys.has(k));
    usedKeys.add(k);
    return k;
  }

  // Whether any human could currently see (x, y) — used to place/remove decoys unnoticed.
  function hiddenFromHumans(x, y) {
    for (const p of players.values()) {
      if (!p.bot && canSee(p, x, y)) return false;
    }
    return true;
  }

  function makeDecoy(pos) {
    return {
      key: newKey(),
      x: pos.x, y: pos.y, z: groundUnder(pos.x, pos.y),
      a: Math.random() * Math.PI * 2,
      variant: Math.floor(Math.random() * C.VARIANTS),
      state: 'idle', timer: rand(0, 5), dir: 0, cutT: -99,
      power: randomPower(), // hidden prize; nobody can tell which decoys have one
    };
  }

  function hiddenFreeSpot() {
    for (let i = 0; i < 40; i++) {
      const s = freeSpot(decoys, 50);
      if (hiddenFromHumans(s.x, s.y)) return s;
    }
    return null;
  }

  function populateDecoys() {
    for (const d of decoys) usedKeys.delete(d.key);
    decoys = [];
    for (let i = 0; i < C.DECOYS; i++) decoys.push(makeDecoy(freeSpot(decoys, 55)));
  }

  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
  function send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }

  // Spawning takes over an existing decoy, so a respawning player never just "pops in".
  function spawn(p) {
    const enemies = [...players.values()].filter(q => q !== p && q.alive);
    let best = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const d = decoys[Math.floor(Math.random() * decoys.length)];
      if (!d) break;
      const nearest = enemies.length ? Math.min(...enemies.map(q => dist2(q, d))) : 1e9;
      if (nearest > bestScore) { bestScore = nearest; best = d; }
    }
    if (best) {
      decoys.splice(decoys.indexOf(best), 1);
      Object.assign(p, { key: best.key, x: best.x, y: best.y, z: best.z, a: best.a, variant: best.variant });
    } else {
      const s = freeSpot(enemies, 300);
      Object.assign(p, { key: newKey(), x: s.x, y: s.y, z: s.z, a: Math.random() * Math.PI * 2, variant: Math.floor(Math.random() * C.VARIANTS) });
    }
    p.alive = true;
    p.seq++;
    p.sus = 0;
    p.nextSlash = now() + 0.6;
    p.powers = {};
    sendPowers(p);
    p.lastUpdate = now();
    p.ai = { think: rand(0.5, 2), target: null, hunt: 0 };
    Object.assign(p, { state: 'idle', timer: rand(1, 3), dir: 0 }); // wander state, same shape as a decoy's
    send(p, { t: 'spawn', x: p.x, y: p.y, z: p.z, a: p.a, key: p.key, seq: p.seq, variant: p.variant });
  }

  function addPlayer(name, ws, bot = false) {
    const p = {
      id: nextId++, name, ws, bot,
      key: 0, x: 0, y: 0, z: 0, a: 0, variant: 0, // z = height of the box's bottom (stairs, platforms, jumps)
      alive: false, respawnAt: 0, seq: 0,
      score: 0, deaths: 0, nextSlash: 0, sus: 0, lastUpdate: now(), ai: null,
      powers: {}, // power type -> expiry time (server seconds)
    };
    players.set(p.id, p);
    send(p, { t: 'welcome', id: p.id, phase, timeLeft: phaseEnd - now(), options });
    spawn(p);
    broadcast({ t: 'feed', text: `${p.name} joined the warehouse` });
    return p;
  }

  function removePlayer(p) {
    players.delete(p.id);
    if (p.alive) {
      // the box stays behind as a decoy so nobody can tell they left
      decoys.push({ key: p.key, x: p.x, y: p.y, z: groundUnder(p.x, p.y), a: p.a, variant: p.variant, state: 'idle', timer: rand(1, 4), dir: 0, cutT: -99, power: null });
    } else usedKeys.delete(p.key);
    broadcast({ t: 'feed', text: `${p.name} left` });
  }

  // ---------- power-ups ----------
  const has = (p, type) => (p.powers[type] || 0) > now();
  const reachOf = p => C.SLASH_RANGE * (has(p, 'reach') ? C.REACH_MULT : 1);

  // Tell a player which power-ups they have and how many seconds each has left.
  function sendPowers(p, got) {
    const t = now(), left = {};
    for (const [type, until] of Object.entries(p.powers)) if (until > t) left[type] = until - t;
    send(p, { t: 'power', powers: left, got });
  }

  function givePower(p, type) {
    p.powers[type] = now() + POWERS[type].dur;
    sendPowers(p, type);
  }

  // Drop a random power-up on the floor somewhere open, away from boxes and other pickups.
  function spawnPickup() {
    const boxes = decoys.concat([...players.values()].filter(p => p.alive));
    let best = null;
    for (let i = 0; i < 20 && !best; i++) {
      const s = freeSpot(boxes, 45);
      if (pickups.every(k => dist2(k, s) > 300 * 300) || i === 19) best = s;
    }
    pickups.push({ id: nextPickupId++, x: best.x, y: best.y, z: best.z, type: POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)], pickup: true });
  }

  // Players (and bots) grab floor power-ups by walking over them. Decoys never do.
  function collectPickups() {
    for (const p of players.values()) {
      if (!p.alive) continue;
      for (const k of pickups) {
        if (Math.abs(k.z - p.z) > 30 || dist2(k, p) > C.PICKUP_R * C.PICKUP_R) continue;
        pickups.splice(pickups.indexOf(k), 1);
        broadcast({ t: 'pickup', id: k.id, x: k.x, y: k.y, z: k.z, type: k.type });
        givePower(p, k.type);
        break;
      }
    }
  }

  // A decoy with a prize inside bursts open; whoever cut it gets the power-up.
  function crack(d, p) {
    decoys.splice(decoys.indexOf(d), 1);
    usedKeys.delete(d.key);
    broadcast({ t: 'crack', x: d.x, y: d.y, z: d.z, a: d.a, variant: d.variant, power: d.power });
    givePower(p, d.power);
  }

  function kill(victim, killer) {
    victim.alive = false;
    victim.powers = {};
    victim.respawnAt = now() + C.RESPAWN;
    victim.deaths++;
    killer.score++;
    usedKeys.delete(victim.key);
    broadcast({ t: 'kill', x: victim.x, y: victim.y, z: groundUnder(victim.x, victim.y), a: victim.a, variant: victim.variant, killer: killer.name, victim: victim.name, kid: killer.id, vid: victim.id });
  }

  function slash(p, aim) {
    if (!p.alive || phase !== 'play' || !Number.isFinite(aim)) return;
    const t = now();
    if (t < p.nextSlash) return;
    const range = reachOf(p);
    broadcast({ t: 'slash', x: p.x, y: p.y, z: p.z, aim, r: range });
    p.sus += 1.2;

    let hit = false;
    for (const q of players.values()) {
      if (q === p || !q.alive || !reaches(p, aim, q, range)) continue;
      hit = true;
      if (has(q, 'shield')) {
        // bubble wrap soaks up the cut (but everyone now knows that box is a player)
        delete q.powers.shield;
        sendPowers(q);
        broadcast({ t: 'blocked', x: q.x, y: q.y, z: q.z, vid: q.id });
      } else kill(q, p);
    }
    let found = false;
    for (const d of decoys.slice()) {
      if (!reaches(p, aim, d, range)) continue;
      if (d.power) { crack(d, p); found = true; } else d.cutT = t;
    }
    const fast = hit || found || has(p, 'quick');
    p.nextSlash = t + (fast ? C.SLASH_CD_HIT : C.SLASH_CD_MISS);
    if (!fast) send(p, { t: 'miss', cd: C.SLASH_CD_MISS });

    // with moving decoys on, nearby ones sometimes startle and scatter — gives the attacker some cover
    if (options.moveDecoys) for (const d of decoys) {
      if (dist2(d, p) < 240 * 240 && Math.random() < 0.5) {
        d.state = 'move';
        d.dir = Math.atan2(d.y - p.y, d.x - p.x) + rand(-0.6, 0.6);
        d.timer = rand(0.4, 1.1);
      }
    }
  }

  const reaches = (p, aim, q, range) => Math.abs(q.z - p.z) < C.Z_REACH && inSlash(p.x, p.y, aim, q.x, q.y, range);

  // Server-simulated boxes walk on the floor: up stairs, off ledges, never up a ledge.
  function walk(e, dx, dy) {
    const moved = moveBox(e, dx, dy);
    e.z = groundUnder(e.x, e.y);
    return moved;
  }

  // Idle/shuffle behaviour shared by decoys and wandering bots. `calm` boxes mostly stay put.
  function wander(e, dt, calm = false) {
    e.timer -= dt;
    if (e.state === 'move') {
      e.a = turnToward(e.a, e.dir, C.TURN * dt);
      const moved = walk(e, Math.cos(e.dir) * C.WALK * dt, Math.sin(e.dir) * C.WALK * dt);
      if (moved < C.WALK * dt * 0.3) e.dir += rand(1, 2.5) * (Math.random() < 0.5 ? -1 : 1);
      if (e.timer <= 0) { e.state = 'idle'; e.timer = calm ? rand(6, 16) : rand(1.5, 7); }
    } else if (e.timer <= 0) {
      if (Math.random() < (calm ? 0.35 : 0.6)) { e.state = 'move'; e.dir = Math.random() * Math.PI * 2; e.timer = rand(0.4, 2.4); }
      else e.timer = calm ? rand(4, 12) : rand(1, 5);
    }
  }

  function updateBot(p, dt) {
    const ai = p.ai;
    ai.think -= dt;
    if (ai.think <= 0 && !ai.target) {
      ai.think = rand(1, 3);
      ai.stuck = 0;
      const near = pickups.filter(k => dist2(k, p) < 500 * 500 && Math.abs(k.z - p.z) <= C.STEP);
      if (phase === 'play' && near.length && Math.random() < 0.45) {
        // go grab a power-up lying nearby
        ai.target = near[Math.floor(Math.random() * near.length)];
        ai.hunt = 0;
      } else if (phase === 'play' && Math.random() < 0.6) {
        // pick something to cut, weighted by how suspicious it's been acting
        // (bots get a bit of "gut feeling" for real players so they're a threat)
        const cands = [];
        for (const q of players.values()) if (q !== p && q.alive && dist2(q, p) < 600 * 600) cands.push([q, 0.6 + q.sus * 1.5]);
        for (const d of decoys) if (dist2(d, p) < 600 * 600) cands.push([d, 0.1]);
        let total = cands.reduce((s, c) => s + c[1], 0), r = Math.random() * total;
        for (const [ref, w] of cands) { if ((r -= w) <= 0) { ai.target = ref; ai.hunt = 0; break; } }
      }
    }
    const tgt = ai.target;
    if (tgt) {
      const gone = tgt.pickup ? !pickups.includes(tgt) : tgt.alive === false || (tgt.alive === undefined && !decoys.includes(tgt));
      ai.hunt += dt;
      // give up if it's gone, taking too long, or on another level we can't reach
      if (gone || ai.hunt > 7 || ai.stuck > 1.2 || phase !== 'play') { ai.target = null; return wander(p, dt, !options.moveDecoys); }
      const dx = tgt.x - p.x, dy = tgt.y - p.y, d = Math.hypot(dx, dy);
      const dir = Math.atan2(dy, dx);
      if (tgt.pickup || d > reachOf(p) * 0.7 || Math.abs(tgt.z - p.z) >= C.Z_REACH) {
        const speed = ((tgt.sus || 0) > 1.2 && d > 200 ? C.SPRINT : C.WALK) * (has(p, 'speed') ? C.SPEED_MULT : 1);
        p.a = turnToward(p.a, dir, C.TURN * dt);
        const moved = walk(p, Math.cos(dir) * speed * dt, Math.sin(dir) * speed * dt);
        ai.stuck = moved < speed * dt * 0.3 ? (ai.stuck || 0) + dt : 0;
        if (speed > C.WALK) p.sus += dt * 1.2;
      } else {
        slash(p, dir + rand(-0.25, 0.25));
        ai.target = null;
        ai.think = rand(0.8, 2.5);
      }
    } else {
      wander(p, dt, !options.moveDecoys);
    }
  }

  // Push overlapping boxes apart. Only server-simulated boxes move; human players own their position.
  function separate() {
    const all = decoys.concat([...players.values()].filter(p => p.alive));
    const min = C.R * 2, min2 = min * min;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= min2 || d2 < 1e-6) continue;
        if (Math.abs(a.z - b.z) > LEVEL_GAP) continue; // different levels, or jumping over
        const d = Math.sqrt(d2), push = (min - d), nx = dx / d, ny = dy / d;
        const aFixed = a.ws && !a.bot, bFixed = b.ws && !b.bot;
        if (aFixed && bFixed) continue;
        const wa = aFixed ? 0 : bFixed ? 1 : 0.5, wb = 1 - wa;
        a.x -= nx * push * wa; a.y -= ny * push * wa;
        b.x += nx * push * wb; b.y += ny * push * wb;
      }
    }
    // settle server-simulated boxes; a shove never lifts a box up onto a ledge
    for (const e of all) {
      if (e.ws && !e.bot) continue;
      const ox = e.x, oy = e.y;
      resolve(e);
      if (groundUnder(e.x, e.y) > e.z + C.STEP) { e.x = ox; e.y = oy; resolve(e); }
      e.z = groundUnder(e.x, e.y);
    }
  }

  // ---------- rounds ----------
  function scoreList() {
    return [...players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score, deaths: p.deaths, bot: p.bot }))
      .sort((a, b) => b.score - a.score || a.deaths - b.deaths);
  }

  function endRound() {
    phase = 'intermission';
    phaseEnd = now() + C.INTERMISSION;
    broadcast({ t: 'roundEnd', scores: scoreList(), timeLeft: C.INTERMISSION });
  }

  function startRound() {
    phase = 'play';
    phaseEnd = now() + C.ROUND;
    populateDecoys();
    pickups = [];
    nextPickupAt = now() + 3;
    for (const p of players.values()) {
      p.score = 0; p.deaths = 0;
      if (p.alive) usedKeys.delete(p.key);
      p.alive = false;
    }
    for (const p of players.values()) spawn(p);
    broadcast({ t: 'roundStart', timeLeft: C.ROUND });
  }

  // ---------- loops ----------
  function tick() {
    const t = now(), dt = 1 / C.TICK;
    if (phase === 'play' && t >= phaseEnd) endRound();
    else if (phase === 'intermission' && t >= phaseEnd) startRound();

    if (options.moveDecoys) for (const d of decoys) wander(d, dt);
    for (const p of players.values()) {
      if (!p.alive) { if (t >= p.respawnAt) spawn(p); continue; }
      if (p.bot) updateBot(p, dt);
      p.sus = Math.max(0, p.sus - dt * 0.35);
    }
    separate();
    if (phase === 'play') {
      collectPickups();
      if (t >= nextPickupAt) {
        if (pickups.length < C.PICKUP_MAX) spawnPickup();
        nextPickupAt = t + rand(0.6, 1.4) * C.PICKUP_EVERY;
      }
    }
  }

  function snapshot() {
    const t = now();
    const boxes = [];
    const pack = e => boxes.push([e.key, Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10, Math.round(e.a * 100) / 100, e.variant, t - (e.cutT ?? -99) < 5 ? 1 : 0, Math.round(e.z)]);
    for (const d of decoys) pack(d);
    for (const p of players.values()) if (p.alive) pack(p);
    // shuffle so list order can't be used to pick out players
    for (let i = boxes.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [boxes[i], boxes[j]] = [boxes[j], boxes[i]]; }
    const pk = pickups.map(k => [k.id, Math.round(k.x), Math.round(k.y), Math.round(k.z), k.type]);
    broadcast({ t: 's', T: Math.round(t * 1000), ph: phase, tl: Math.max(0, phaseEnd - t), b: boxes, pk });
    // X-ray specs: tell the wearer which boxes are real players
    for (const p of players.values()) {
      if (p.bot || !p.alive || !has(p, 'radar')) continue;
      send(p, { t: 'radar', keys: [...players.values()].filter(q => q !== p && q.alive).map(q => q.key) });
    }
  }

  function housekeeping() {
    // keep the lobby topped up with bots
    const humans = [...players.values()].filter(p => !p.bot).length;
    const bots = [...players.values()].filter(p => p.bot);
    const want = humans === 0 ? 0 : Math.max(0, BOT_FILL - humans);
    if (bots.length < want) {
      const used = new Set(bots.map(b => b.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `Box #${nextId}`;
      addPlayer(name, null, true);
    } else if (bots.length > want) removePlayer(bots[bots.length - 1]);

    // keep the decoy population steady, adding/removing only out of sight
    if (decoys.length < C.DECOYS) {
      const s = hiddenFreeSpot();
      if (s) decoys.push(makeDecoy(s));
    } else if (decoys.length > C.DECOYS + 4) {
      const i = decoys.findIndex(d => hiddenFromHumans(d.x, d.y));
      if (i >= 0) usedKeys.delete(decoys.splice(i, 1)[0].key);
    }
    broadcast({ t: 'scores', scores: scoreList() });
  }

  // ---------- networking ----------
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', ws => {
    let p = null;
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'join' && !p) {
        const name = String(msg.name || '').replace(/[<>]/g, '').trim().slice(0, 16) || `Box ${nextId}`;
        p = addPlayer(name, ws);
      } else if (!p) {
        return;
      } else if (msg.t === 'st') {
        if (!p.alive || msg.seq !== p.seq || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
        const t = now();
        const elapsed = Math.min(Math.max(t - p.lastUpdate, 1 / 60), 0.25);
        p.lastUpdate = t;
        // trust the client's position, but never faster than a sprint
        let dx = msg.x - p.x, dy = msg.y - p.y;
        const d = Math.hypot(dx, dy), maxD = C.SPRINT * (has(p, 'speed') ? C.SPEED_MULT : 1) * elapsed * 1.4 + 8;
        if (d > maxD) { dx *= maxD / d; dy *= maxD / d; }
        p.x += dx; p.y += dy;
        resolve(p);
        if (Number.isFinite(msg.a)) p.a = msg.a;
        // height comes from the client too (jumps, stairs), within reason: never below the floor
        const g = groundUnder(p.x, p.y);
        p.z = Number.isFinite(msg.z) ? Math.min(Math.max(msg.z, g), g + 80) : g;
        if (msg.s && d > 1) p.sus += elapsed * 1.2;
      } else if (msg.t === 'sl') {
        slash(p, msg.aim);
      } else if (msg.t === 'opt' && typeof msg.moveDecoys === 'boolean' && msg.moveDecoys !== options.moveDecoys) {
        options.moveDecoys = msg.moveDecoys;
        broadcast({ t: 'options', options, by: p.name });
      }
    });
    ws.on('close', () => { if (p) removePlayer(p); });
  });

  populateDecoys();
  setInterval(tick, 1000 / C.TICK);
  setInterval(snapshot, 1000 / C.SNAP);
  setInterval(housekeeping, 1000);

  return { wss };
}

module.exports = { createGame };
