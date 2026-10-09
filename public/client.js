// What The Box? clone — browser client.
const { C, POWERS, ROOMS, OBSTACLES, DOORS, PLATFORMS, STAIRS, ZONES, LANES, groundUnder, moveBox, turnToward, clamp } = Shared;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const { $, esc, addFeed } = UI;

// ---------- state ----------
let ws = null;
let myId = null;
let me = null;          // locally predicted own box {x, y, a, key, seq, variant}
let alive = false;
let deadAt = { x: C.W / 2, y: C.H / 2 };
let respawnAt = 0;
let stamina = C.STAMINA_MAX, exhausted = false, sprinting = false;
let nextSlashAt = 0, slashCdTotal = 1, lastLocalSlash = -1;
let snaps = [];         // [{T, boxes: Map(key -> [x, y, a, variant, cut])}]
let timeOffset = null;  // serverTimeMs - performance.now()
let phase = 'play', timeLeft = C.ROUND, timeLeftAt = performance.now();
let scores = [];
let options = { moveDecoys: false };
let powers = {};          // power type -> expiry (performance.now() ms)
let radarKeys = new Set(), radarAt = -1e9;
let pickups = [];         // floor power-ups from the latest snapshot: [id, x, y, z, type]
const powered = type => (powers[type] || 0) > performance.now();
const myReach = () => C.SLASH_RANGE * (powered('reach') ? C.REACH_MULT : 1);
let lastSend = 0;
let visibleBoxes = [];  // interpolated other boxes from the last frame (used for local collision)

const fx = { slashes: [], particles: [], decals: [], texts: [] };
const keys = new Set();
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
const cam = { x: C.W / 2, y: C.H / 2, s: 1 };

// ---------- menu / connection ----------
try { $('name').value = localStorage.getItem('wtb-name') || ''; } catch {}

function join() {
  const name = $('name').value.trim() || 'Box';
  try { localStorage.setItem('wtb-name', name); } catch {}
  initAudio();
  $('status').textContent = 'Connecting…';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/topdown`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('status').textContent = 'Disconnected from the warehouse. Hit PLAY to rejoin.';
    alive = false; me = null; snaps = []; timeOffset = null; pickups = [];
  };
}
$('play').onclick = join;
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handle(m) {
  const t = performance.now();
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      $('menu').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $('status').textContent = '';
      setPhase(m.phase, m.timeLeft);
      options = m.options;
      UI.renderOptions(options);
      break;
    case 'options':
      options = m.options;
      UI.renderOptions(options);
      addFeed(`${esc(m.by)} turned decoy movement <b>${options.moveDecoys ? 'ON' : 'OFF'}</b>`);
      break;
    case 'spawn':
      me = { x: m.x, y: m.y, z: m.z, a: m.a, key: m.key, seq: m.seq, variant: m.variant };
      alive = true;
      stamina = C.STAMINA_MAX; exhausted = false;
      UI.hideDeath();
      break;
    case 's': {
      const o = m.T - t;
      if (timeOffset === null || Math.abs(o - timeOffset) > 1000) timeOffset = o;
      else timeOffset = o > timeOffset ? timeOffset * 0.7 + o * 0.3 : timeOffset * 0.98 + o * 0.02;
      const boxes = new Map();
      for (const b of m.b) boxes.set(b[0], b);
      snaps.push({ T: m.T, boxes });
      pickups = m.pk || [];
      if (snaps.length > 40) snaps.shift();
      if (m.ph !== phase) setPhase(m.ph, m.tl);
      timeLeft = m.tl; timeLeftAt = t;
      break;
    }
    case 'slash': {
      const mine = me && Math.hypot(m.x - me.x, m.y - me.y) < 50 && t - lastLocalSlash < 500;
      if (!mine) { fx.slashes.push({ x: m.x, y: m.y, aim: m.aim, r: m.r, t }); sfx.swish(m.x, m.y); }
      break;
    }
    case 'miss':
      break;
    case 'power':
      powers = {};
      for (const [type, left] of Object.entries(m.powers)) powers[type] = t + left * 1000;
      if (m.got) {
        const def = POWERS[m.got];
        UI.toast(`${def.icon} ${def.name}`, def.desc, def.color);
        sfx.chime();
        // the cut that found it doesn't count as a whiff
        nextSlashAt = Math.min(nextSlashAt, lastLocalSlash + C.SLASH_CD_HIT * 1000);
        slashCdTotal = C.SLASH_CD_HIT;
      }
      break;
    case 'crack': {
      // a decoy with a prize inside bursts open
      const def = POWERS[m.power];
      burst(m.x, m.y, m.a, m.variant, def.color);
      fx.texts.push({ x: m.x, y: m.y - 24, text: def.icon, t, color: def.color, size: 34 });
      sfx.pop(m.x, m.y);
      break;
    }
    case 'pickup': {
      // someone grabbed a floor power-up
      const def = POWERS[m.type];
      sparkle(m.x, m.y, def.color);
      fx.texts.push({ x: m.x, y: m.y - 20, text: def.icon, t, color: def.color, size: 30 });
      sfx.ding(m.x, m.y);
      break;
    }
    case 'blocked':
      bubbles(m.x, m.y);
      fx.texts.push({ x: m.x, y: m.y - 24, text: 'BLOCKED!', t, color: '#dff1ff' });
      sfx.pop(m.x, m.y);
      break;
    case 'radar':
      radarKeys = new Set(m.keys);
      radarAt = t;
      break;
    case 'kill': {
      burst(m.x, m.y, m.a, m.variant);
      sfx.rip(m.x, m.y);
      const mineK = m.kid === myId, mineV = m.vid === myId;
      addFeed(`<span class="k">${esc(m.killer)}</span> ✂ ${esc(m.victim)}`, mineK || mineV);
      if (mineK) {
        nextSlashAt = Math.min(nextSlashAt, t + C.SLASH_CD_HIT * 1000);
        slashCdTotal = C.SLASH_CD_HIT;
        fx.texts.push({ x: m.x, y: m.y - 20, text: '+1 CUT!', t, color: '#57e389' });
      }
      if (mineV) {
        alive = false;
        powers = {};
        deadAt = { x: m.x, y: m.y };
        respawnAt = t + C.RESPAWN * 1000;
        UI.showDeath(m.killer);
      }
      break;
    }
    case 'scores':
      scores = m.scores;
      UI.renderScores(scores, myId);
      break;
    case 'roundEnd':
      scores = m.scores;
      setPhase('intermission', m.timeLeft);
      break;
    case 'roundStart':
      setPhase('play', m.timeLeft);
      fx.decals = [];
      break;
    case 'feed':
      addFeed(esc(m.text));
      break;
  }
}

function setPhase(ph, tl) {
  phase = ph;
  timeLeft = tl; timeLeftAt = performance.now();
  if (ph === 'intermission') UI.showRoundEnd(scores, myId);
  else UI.hideRoundEnd();
}

// ---------- input ----------
addEventListener('keydown', e => {
  if (document.activeElement === $('name')) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); trySlash(); }
  if (e.code === 'KeyM' && !e.repeat) send({ t: 'opt', moveDecoys: !options.moveDecoys });
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
UI.bindScoreboardKey();
canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => { if (e.button === 0) trySlash(); });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function aimAngle() {
  const wx = (mouse.x - innerWidth / 2) / cam.s + cam.x;
  const wy = (mouse.y - innerHeight / 2) / cam.s + cam.y;
  return Math.atan2(wy - me.y, wx - me.x);
}

function trySlash() {
  const t = performance.now();
  if (!alive || !me || phase !== 'play' || t < nextSlashAt) return;
  const aim = aimAngle();
  send({ t: 'sl', aim });
  // assume a miss until the server tells us we cut someone
  const cd = powered('quick') ? C.SLASH_CD_HIT : C.SLASH_CD_MISS;
  nextSlashAt = t + cd * 1000;
  slashCdTotal = cd;
  lastLocalSlash = t;
  fx.slashes.push({ x: me.x, y: me.y, aim, r: myReach(), t });
  sfx.swish(me.x, me.y);
}

// ---------- simulation ----------
function updateLocal(dt) {
  if (!alive || !me) return;
  const k = c => keys.has(c);
  let mx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
  let my = (k('KeyS') || k('ArrowDown') ? 1 : 0) - (k('KeyW') || k('ArrowUp') ? 1 : 0);
  const len = Math.hypot(mx, my);
  const moving = len > 0;
  if (moving) { mx /= len; my /= len; }

  sprinting = moving && (k('ShiftLeft') || k('ShiftRight')) && !exhausted;
  if (sprinting && powered('speed')) {
    // turbo tape: sprinting is free
  } else if (sprinting) {
    stamina -= C.STAMINA_DRAIN * dt;
    if (stamina <= 0) { stamina = 0; exhausted = true; }
  } else {
    stamina = Math.min(C.STAMINA_MAX, stamina + C.STAMINA_REGEN * dt);
    if (exhausted && stamina > C.STAMINA_MAX * 0.3) exhausted = false;
  }

  let dx = 0, dy = 0;
  if (moving) {
    const speed = (sprinting ? C.SPRINT : C.WALK) * (powered('speed') ? C.SPEED_MULT : 1);
    dx = mx * speed * dt;
    dy = my * speed * dt;
    me.a = turnToward(me.a, Math.atan2(my, mx), C.TURN * dt);
  }
  // shove ourselves out of other boxes on our level, then move (walls and ledges block)
  const min = C.R * 2;
  for (const b of visibleBoxes) {
    if (Math.abs(b.z - me.z) > 30) continue;
    const ox = me.x - b.x, oy = me.y - b.y, d = Math.hypot(ox, oy);
    if (d < min && d > 0.01) { dx += (ox / d) * (min - d) * 0.5; dy += (oy / d) * (min - d) * 0.5; }
  }
  moveBox(me, dx, dy);
  me.z = groundUnder(me.x, me.y); // no jumping in top-down: walk up stairs, drop off ledges

  const t = performance.now();
  if (t - lastSend > 1000 / 30) {
    lastSend = t;
    send({ t: 'st', x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 100) / 100, z: Math.round(me.z), seq: me.seq, s: sprinting });
  }
}

function lerpAngle(a, b, f) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

// Other boxes, rendered ~110ms in the past and interpolated between snapshots.
function interpolated() {
  if (!snaps.length || timeOffset === null) return [];
  const rt = performance.now() + timeOffset - 110;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i - 1].T > rt) i--;
  const b = snaps[i], a = snaps[i - 1] || b;
  const f = b.T === a.T ? 1 : clamp((rt - a.T) / (b.T - a.T), 0, 1);
  const out = [];
  for (const [key, nb] of b.boxes) {
    if (me && alive && key === me.key) continue;
    const ob = a.boxes.get(key) || nb;
    out.push({ key, x: ob[1] + (nb[1] - ob[1]) * f, y: ob[2] + (nb[2] - ob[2]) * f, a: lerpAngle(ob[3], nb[3], f), v: nb[4], cut: nb[5], z: (ob[6] || 0) + ((nb[6] || 0) - (ob[6] || 0)) * f });
  }
  return out;
}

// ---------- effects ----------
const CARD = ['#c99a5e', '#c4925a', '#d0a46b', '#bf8f55'];

function burst(x, y, a, variant, confettiColor) {
  if (confettiColor) {
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 300;
      fx.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 30,
        w: 5, h: 3, color: i % 3 ? confettiColor : '#fff6c8', life: 1.2 + Math.random() * 0.8, age: 0, confetti: true });
    }
  }
  const base = CARD[variant] || CARD[0];
  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 260;
    fx.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 18,
      w: 8 + Math.random() * 14, h: 6 + Math.random() * 10, color: base, life: 1.1 + Math.random() * 0.6, age: 0 });
  }
  for (let i = 0; i < 14; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 200;
    fx.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 0, vr: 0, w: 5, h: 3, color: '#fffaf0', peanut: true, life: 1.6 + Math.random(), age: 0 });
  }
  fx.decals.push({ x, y, a, color: base, t: performance.now() });
  if (fx.decals.length > 30) fx.decals.shift();
}

// glittery puff when a floor power-up is grabbed
function sparkle(x, y, color) {
  for (let i = 0; i < 22; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 180;
    fx.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 20,
      w: 4, h: 4, color: i % 2 ? color : '#fffbe0', life: 0.6 + Math.random() * 0.5, age: 0, confetti: true });
  }
}

// bubble wrap popping
function bubbles(x, y) {
  for (let i = 0; i < 18; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
    fx.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 0, vr: 0, w: 9, h: 9, color: 'rgba(225,240,255,0.85)', peanut: true, life: 0.8 + Math.random() * 0.5, age: 0 });
  }
}

function updateFx(dt) {
  for (const p of fx.particles) {
    p.age += dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= Math.pow(0.04, dt); p.vy *= Math.pow(0.04, dt);
    p.r += p.vr * dt; p.vr *= Math.pow(0.1, dt);
  }
  fx.particles = fx.particles.filter(p => p.age < p.life);
  const t = performance.now();
  fx.slashes = fx.slashes.filter(s => t - s.t < 260);
  fx.texts = fx.texts.filter(s => t - s.t < 1200);
  fx.decals = fx.decals.filter(d => t - d.t < 15000);
}

// ---------- audio ----------
let actx = null, noiseBuf = null;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { actx = null; }
}
function earshot(x, y) {
  const c = alive && me ? me : deadAt;
  return clamp(1 - Math.hypot(x - c.x, y - c.y) / 1000, 0, 1);
}
function noise(vol, dur, type, f0, f1, rough) {
  if (!actx || vol <= 0.01) return;
  const t = actx.currentTime;
  const src = actx.createBufferSource(); src.buffer = noiseBuf;
  const filt = actx.createBiquadFilter(); filt.type = type; filt.Q.value = 1.2;
  filt.frequency.setValueAtTime(f0, t); filt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  if (rough) {
    // jagged envelope sounds like tearing cardboard
    for (let s = 0; s < dur; s += 0.025) g.gain.setValueAtTime(vol * (0.3 + Math.random() * 0.7) * (1 - s / dur), t + s);
  } else {
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(actx.destination);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}
function tone(vol, f0, f1, dur) {
  if (!actx || vol <= 0.01) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
const sfx = {
  chime: () => { tone(0.25, 660, 1320, 0.22); setTimeout(() => tone(0.22, 990, 1980, 0.3), 90); },
  ding: (x, y) => tone(0.22 * earshot(x, y), 880, 1760, 0.18),
  pop: (x, y) => { noise(0.6 * earshot(x, y), 0.12, 'highpass', 1800, 900); tone(0.2 * earshot(x, y), 300, 900, 0.12); },
  swish: (x, y) => noise(0.5 * earshot(x, y), 0.16, 'bandpass', 4200, 900),
  rip: (x, y) => noise(0.9 * earshot(x, y), 0.5, 'lowpass', 2600, 500, true),
};

// ---------- rendering ----------
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

// deterministic pseudo-random for map decoration
function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
const decor = (() => {
  const r = seeded(42), stains = [];
  for (let i = 0; i < 40; i++) stains.push({ x: r() * C.W, y: r() * C.H, rad: 20 + r() * 70, o: 0.03 + r() * 0.05 });
  const shelfItems = OBSTACLES.filter(o => o.kind === 'shelf').map(o => {
    const items = [], horiz = o.w > o.h, n = Math.floor((horiz ? o.w : o.h) / 30);
    for (let i = 0; i < n; i++) if (r() < 0.8) items.push({ i, c: ['#7d5a3a', '#5c6b7a', '#8a3b2e', '#6d7a4a', '#9b7a4c'][Math.floor(r() * 5)], s: 14 + r() * 8 });
    return items;
  });
  return { stains, shelfItems };
})();

function drawFloor() {
  ctx.fillStyle = '#8f908a';
  ctx.fillRect(0, 0, C.W, C.H);
  for (const z of ZONES) {
    ctx.fillStyle = z.kind === 'carpet' ? '#56616d' : '#7f807a';
    ctx.fillRect(z.x, z.y, z.w, z.h);
    if (z.kind === 'carpet') {
      // carpet tiles
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = z.x; x <= z.x + z.w; x += 60) { ctx.moveTo(x, z.y); ctx.lineTo(x, z.y + z.h); }
      for (let y = z.y; y <= z.y + z.h; y += 60) { ctx.moveTo(z.x, y); ctx.lineTo(z.x + z.w, y); }
      ctx.stroke();
    }
  }
  // concrete slabs (not on carpet)
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, C.W, C.H);
  for (const z of ZONES) if (z.kind === 'carpet') ctx.rect(z.x + z.w, z.y, -z.w, z.h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= C.W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, C.H); }
  for (let y = 0; y <= C.H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(C.W, y); }
  ctx.stroke();
  for (const s of decor.stains) {
    ctx.fillStyle = `rgba(30,25,20,${s.o})`;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.rad, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // painted lanes
  ctx.strokeStyle = 'rgba(240,200,40,0.55)';
  ctx.lineWidth = 6;
  ctx.setLineDash([40, 30]);
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of LANES) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
  ctx.stroke();
  ctx.setLineDash([]);
  // room names painted on the floor
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.font = '44px Bungee, Impact, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const r of ROOMS) ctx.fillText(r.name, r.lx, r.ly);
  // door thresholds
  for (const d of DOORS) hazard(d.x, d.y, d.w, d.h, 12);
}

function hazard(x, y, w, h, step) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#f2c230'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1d1d1d';
  const n = Math.max(w, h);
  for (let s = -n; s < n * 2; s += step * 2) { ctx.beginPath(); ctx.moveTo(x + s, y + h); ctx.lineTo(x + s + step, y + h); ctx.lineTo(x + s + step + h, y); ctx.lineTo(x + s + h, y); ctx.fill(); }
  ctx.restore();
}

// Raised floors cast a shadow and get a yellow safety edge; stairs show their steps.
function drawLevels() {
  for (const p of PLATFORMS) {
    const off = p.top / 5;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(p.x + off, p.y + off, p.w, p.h);
    ctx.fillStyle = '#a9aaa3'; ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let x = p.x + 10; x < p.x + p.w; x += 20) for (let y = p.y + 10; y < p.y + p.h; y += 20) ctx.fillRect(x, y, 6, 2);
    ctx.strokeStyle = '#f2c230'; ctx.lineWidth = 5; ctx.strokeRect(p.x + 2.5, p.y + 2.5, p.w - 5, p.h - 5);
  }
  for (const s of STAIRS) {
    const vert = s.up === 'n' || s.up === 's';
    const len = vert ? s.h : s.w, n = Math.round(s.top / 10);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(s.x + 6, s.y + 6, s.w, s.h);
    for (let i = 0; i < n; i++) {
      // step i counts up from the bottom; higher steps are lighter
      const f = (i + 1) / n, a = i * len / n, b = (i + 1) * len / n;
      const shade = Math.round(105 + 60 * f);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
      if (s.up === 'n') ctx.fillRect(s.x, s.y + s.h - b, s.w, b - a);
      else if (s.up === 's') ctx.fillRect(s.x, s.y + a, s.w, b - a);
      else if (s.up === 'e') ctx.fillRect(s.x + a, s.y, b - a, s.h);
      else ctx.fillRect(s.x + s.w - b, s.y, b - a, s.h);
    }
    ctx.strokeStyle = 'rgba(242,194,48,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const a = i * len / n;
      if (s.up === 'n') { ctx.moveTo(s.x, s.y + s.h - a); ctx.lineTo(s.x + s.w, s.y + s.h - a); }
      else if (s.up === 's') { ctx.moveTo(s.x, s.y + a); ctx.lineTo(s.x + s.w, s.y + a); }
      else if (s.up === 'e') { ctx.moveTo(s.x + a, s.y); ctx.lineTo(s.x + a, s.y + s.h); }
      else { ctx.moveTo(s.x + s.w - a, s.y); ctx.lineTo(s.x + s.w - a, s.y + s.h); }
    }
    ctx.stroke();
    // chevrons pointing uphill
    ctx.save();
    ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
    ctx.rotate({ n: -Math.PI / 2, s: Math.PI / 2, e: 0, w: Math.PI }[s.up]);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const ox of [-22, 0, 22]) { ctx.beginPath(); ctx.moveTo(ox - 8, -14); ctx.lineTo(ox + 6, 0); ctx.lineTo(ox - 8, 14); ctx.stroke(); }
    ctx.restore();
  }
}

function drawObstacles() {
  for (const o of OBSTACLES) {
    if (o.kind !== 'wall') { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(o.x + 7, o.y + 9, o.w, o.h); }
  }
  let shelfIdx = 0;
  for (const o of OBSTACLES) {
    if (o.kind === 'wall') {
      ctx.fillStyle = '#34373d'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = '#4a4e56'; ctx.fillRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8);
    } else if (o.kind === 'shelf') {
      ctx.fillStyle = '#23384f'; ctx.fillRect(o.x, o.y, o.w, o.h);
      const horiz = o.w > o.h;
      for (const it of decor.shelfItems[shelfIdx]) {
        const cx = horiz ? o.x + 15 + it.i * 30 : o.x + o.w / 2;
        const cy = horiz ? o.y + o.h / 2 : o.y + 15 + it.i * 30;
        ctx.fillStyle = it.c; ctx.fillRect(cx - it.s / 2, cy - it.s / 2, it.s, it.s);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(cx - it.s / 2, cy - it.s / 2, it.s, it.s);
      }
      ctx.strokeStyle = '#e8792b'; ctx.lineWidth = 4; ctx.strokeRect(o.x + 2, o.y + 2, o.w - 4, o.h - 4);
      shelfIdx++;
    } else if (o.kind === 'crate') {
      ctx.fillStyle = '#7a5230'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#5a3a1e'; ctx.lineWidth = 3;
      ctx.strokeRect(o.x + 3, o.y + 3, o.w - 6, o.h - 6);
      ctx.beginPath(); ctx.moveTo(o.x + 4, o.y + 4); ctx.lineTo(o.x + o.w - 4, o.y + o.h - 4);
      ctx.moveTo(o.x + o.w - 4, o.y + 4); ctx.lineTo(o.x + 4, o.y + o.h - 4); ctx.stroke();
    } else if (o.kind === 'pillar') {
      hazard(o.x, o.y, o.w, o.h, 8);
      ctx.fillStyle = '#6b6e72'; ctx.fillRect(o.x + 8, o.y + 8, o.w - 16, o.h - 16);
    } else if (o.kind === 'desk') {
      ctx.fillStyle = '#8b6a45'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#5e4429'; ctx.lineWidth = 2; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
      ctx.fillStyle = '#222'; ctx.fillRect(o.x + o.w / 2 - 22, o.y + 10, 44, 8);        // monitor
      ctx.fillStyle = '#444'; ctx.fillRect(o.x + o.w / 2 - 18, o.y + 38, 36, 12);       // keyboard
      ctx.fillStyle = '#e8e2d0'; ctx.fillRect(o.x + 16, o.y + 30, 22, 28);              // papers
    } else if (o.kind === 'cabinet') {
      ctx.fillStyle = '#7d848c'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#5b6168'; ctx.lineWidth = 2;
      const horiz = o.w > o.h, n = Math.floor((horiz ? o.w : o.h) / 50);
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        if (horiz) { ctx.moveTo(o.x + i * o.w / n, o.y); ctx.lineTo(o.x + i * o.w / n, o.y + o.h); }
        else { ctx.moveTo(o.x, o.y + i * o.h / n); ctx.lineTo(o.x + o.w, o.y + i * o.h / n); }
      }
      ctx.stroke();
      ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
    }
  }
}

function drawBox(x, y, a, v, cut, opts = {}) {
  if (opts.radar) {
    // x-ray specs: mark real players
    ctx.save();
    ctx.strokeStyle = '#c77dff'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(x, y, C.BOX * 0.75, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  const h = C.BOX / 2;
  const sc = 1 + (opts.z || 0) / 260; // boxes up on platforms are closer to the camera
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sc, sc);
  ctx.rotate(a);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-h + 4, -h + 6, C.BOX, C.BOX);
  ctx.fillStyle = CARD[v] || CARD[0];
  ctx.fillRect(-h, -h, C.BOX, C.BOX);
  // flap seam + tape
  ctx.fillStyle = 'rgba(231,214,168,0.85)';
  ctx.fillRect(-h, -4, C.BOX, 8);
  if (v === 1) ctx.fillRect(-4, -h, 8, C.BOX);
  ctx.strokeStyle = 'rgba(90,60,30,0.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-h, 0); ctx.lineTo(h, 0); ctx.stroke();
  if (v === 2) {
    // "this way up" arrows
    ctx.fillStyle = '#b4302a';
    for (const ox of [-10, 10]) { ctx.beginPath(); ctx.moveTo(ox, -16); ctx.lineTo(ox + 4, -10); ctx.lineTo(ox - 4, -10); ctx.fill(); }
  } else if (v === 3) {
    // shipping label
    ctx.fillStyle = '#f5f1e6'; ctx.fillRect(4, 7, 13, 10);
    ctx.fillStyle = '#555'; ctx.fillRect(6, 10, 9, 1); ctx.fillRect(6, 13, 6, 1);
  }
  // edges
  ctx.strokeStyle = '#7d552c'; ctx.lineWidth = 2;
  ctx.strokeRect(-h + 1, -h + 1, C.BOX - 2, C.BOX - 2);
  ctx.strokeStyle = 'rgba(255,240,210,0.35)';
  ctx.beginPath(); ctx.moveTo(-h + 2, h - 2); ctx.lineTo(-h + 2, -h + 2); ctx.lineTo(h - 2, -h + 2); ctx.stroke();
  if (cut) {
    ctx.strokeStyle = '#2e1b0b'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-14, -12); ctx.lineTo(-4, -2); ctx.lineTo(2, 0); ctx.lineTo(14, 11); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,230,190,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-13, -14); ctx.lineTo(-3, -4); ctx.lineTo(3, -2); ctx.lineTo(15, 9); ctx.stroke();
  }
  ctx.restore();
  if (opts.self) {
    ctx.save();
    // glow in the colour of any active power-up
    const active = Object.keys(powers).filter(powered);
    if (active.length) {
      ctx.strokeStyle = POWERS[active[0]].color; ctx.lineWidth = 6; ctx.globalAlpha = 0.45 + 0.25 * Math.sin(performance.now() / 120);
      ctx.beginPath(); ctx.arc(x, y, h + 16, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#57e389'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, h + 10, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#57e389';
    ctx.beginPath(); ctx.moveTo(x, y - h - 14); ctx.lineTo(x - 7, y - h - 26); ctx.lineTo(x + 7, y - h - 26); ctx.fill();
    ctx.restore();
  }
}

function drawDecal(d, t) {
  const alpha = clamp(1 - (t - d.t - 12000) / 3000, 0, 1) * 0.9;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(d.x, d.y);
  ctx.rotate(d.a);
  // flattened box (unfolded net)
  ctx.fillStyle = d.color; ctx.strokeStyle = '#6b4724'; ctx.lineWidth = 1.5;
  const s = 24;
  const rects = [[-s / 2, -s / 2, s, s], [-s / 2, -s * 1.5, s, s], [-s / 2, s / 2, s, s], [-s * 1.5, -s / 2, s, s], [s / 2, -s / 2, s, s]];
  for (const r of rects) { ctx.fillRect(...r); ctx.strokeRect(...r); }
  ctx.strokeStyle = '#2e1b0b'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-s, -s * 0.8); ctx.lineTo(s, s * 0.8); ctx.stroke();
  ctx.restore();
}

function drawSlash(s, t) {
  const age = (t - s.t) / 260;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.globalAlpha = 1 - age;
  const r = (s.r || C.SLASH_RANGE) + 6;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, s.aim - C.SLASH_ARC / 2, s.aim + C.SLASH_ARC / 2); ctx.closePath(); ctx.fill();
  // sweeping blade trail
  const sweep = s.aim - C.SLASH_ARC / 2 + C.SLASH_ARC * Math.min(1, age * 2.5);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, r - 4, s.aim - C.SLASH_ARC / 2, sweep); ctx.stroke();
  ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r - 12, s.aim - C.SLASH_ARC / 2, sweep); ctx.stroke();
  ctx.restore();
}

// Floor power-ups: a pulsing glow with the power-up's icon bobbing on top, big enough to spot across a room.
function drawPickups(t) {
  for (const [, x, y, , type] of pickups) {
    const def = POWERS[type], k = Math.sin(t / 250 + x);
    ctx.save();
    ctx.translate(x, y);
    const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 46);
    glow.addColorStop(0, def.color); glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.6 + 0.25 * k;
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(20,16,12,0.85)';
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = def.color; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(0, 0, 19 + 3 * k, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, 0, 1 - 2 * k);
    ctx.restore();
  }
}

function drawAim() {
  if (!alive || !me || phase !== 'play') return;
  const ready = performance.now() >= nextSlashAt;
  const aim = aimAngle();
  ctx.save();
  ctx.translate(me.x, me.y);
  ctx.strokeStyle = ready ? 'rgba(87,227,137,0.55)' : 'rgba(255,90,60,0.35)';
  ctx.lineWidth = 2; ctx.setLineDash([5, 6]);
  ctx.beginPath(); ctx.arc(0, 0, myReach() + C.R, aim - C.SLASH_ARC / 2, aim + C.SLASH_ARC / 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function draw(t) {
  const W = innerWidth, H = innerHeight;
  cam.s = Math.max(Math.min(W / 1150, H / 700), W / 1500, H / 1100);
  const focus = alive && me ? me : deadAt;
  cam.x += (focus.x - cam.x) * 0.25;
  cam.y += (focus.y - cam.y) * 0.25;

  ctx.fillStyle = '#1b1814';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.s, cam.s);
  ctx.translate(-cam.x, -cam.y);

  drawFloor();
  for (const d of fx.decals) drawDecal(d, t);
  drawLevels();
  drawObstacles();
  drawPickups(t);

  const boxes = visibleBoxes.slice();
  if (alive && me) boxes.push({ x: me.x, y: me.y, z: me.z, a: me.a, v: me.variant, cut: 0, self: true });
  boxes.sort((a, b) => a.z - b.z || a.y - b.y);
  const radarOn = powered('radar') && t - radarAt < 500;
  for (const b of boxes) drawBox(b.x, b.y, b.a, b.v, b.cut, { self: b.self, z: b.z, radar: radarOn && radarKeys.has(b.key) });

  for (const p of fx.particles) {
    ctx.save();
    ctx.globalAlpha = clamp((p.life - p.age) / 0.4, 0, 1);
    ctx.translate(p.x, p.y); ctx.rotate(p.r);
    ctx.fillStyle = p.color;
    if (p.confetti) { ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
    else if (p.peanut) { ctx.beginPath(); ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.strokeStyle = '#7d552c'; ctx.lineWidth = 1; ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h); }
    ctx.restore();
  }
  for (const s of fx.slashes) drawSlash(s, t);
  drawAim();

  for (const s of fx.texts) {
    const age = (t - s.t) / 1200;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = s.color; ctx.font = `${s.size || 22}px Bungee, Impact, sans-serif`; ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
    ctx.strokeText(s.text, s.x, s.y - age * 40); ctx.fillText(s.text, s.x, s.y - age * 40);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function updateHud(t) {
  UI.updateHud({
    phase,
    timeLeft: Math.max(0, timeLeft - (t - timeLeftAt) / 1000),
    cdLeft: Math.max(0, nextSlashAt - t) / 1000,
    cdTotal: slashCdTotal,
    stamina: stamina / C.STAMINA_MAX,
    exhausted,
    respawnIn: alive ? null : (respawnAt - t) / 1000,
  });
  UI.renderPowers(powers, t);
}

let last = performance.now();
function frame(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  visibleBoxes = interpolated();
  updateLocal(dt);
  updateFx(dt);
  draw(t);
  updateHud(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
