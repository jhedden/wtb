// What The Box? clone — 3D (three.js) client with a third-person camera behind your box.
// Same rules and server protocol as the top-down client; the map's (x, y) plane is three.js (x, z).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const { C, POWERS, ROOMS, OBSTACLES, DOORS, PLATFORMS, STAIRS, ZONES, LANES, groundAt, groundUnder, moveBox, turnToward, angleDiff, inSlash, clamp } = window.Shared;
const { $, esc, addFeed } = window.UI;

const CAM_DIST = 125;                 // how far the camera trails behind your box
const CAM_TARGET_H = 42;              // the camera orbits a point just above your box
const JUMP_V = 300, GRAVITY = 900;    // ~50 units high, ~0.67s in the air
const LEVEL_GAP = 30;                 // boxes further apart in height than this don't bump (matches the server)
const DOOR_H = 150;                   // doorway opening height
const WALL_H = 260;
const FOG_NEAR = 220, FOG_FAR = 900;  // the server treats anything past ~950 as out of sight
const SENS = 0.0022;
const KEY_TURN = 2.4;                 // rad/s for arrow-key turning

// ---------- state ----------
let ws = null;
let myId = null;
let joined = false;
let me = null;          // locally predicted own box {x, y, a, key, seq, variant}
let alive = false;
let deadAt = { x: C.W / 2, y: C.H / 2, z: 0 };
let respawnAt = 0;
let stamina = C.STAMINA_MAX, exhausted = false, sprinting = false;
let nextSlashAt = 0, slashCdTotal = 1, lastLocalSlash = -1;
let snaps = [];         // [{T, boxes: Map(key -> [key, x, y, a, variant, cut])}]
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
let visibleBoxes = [];
let yaw = 0, elev = 0.3, locked = false; // elev: camera elevation angle around your box
let camDist = CAM_DIST, jumpV = 0;

const fx = { slashes: [], particles: [], decals: [], icons: [] };
const keys = new Set();

// ---------- renderer / scene ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const BG = 0x2e2924;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, FOG_NEAR, FOG_FAR);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 1, 2500);
scene.add(camera);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

scene.add(new THREE.HemisphereLight(0xfff2dd, 0x4a4036, 2.7));
const sun = new THREE.DirectionalLight(0xffefd6, 2.2);
sun.position.set(C.W / 2 - 500, 1400, C.H / 2 - 400);
sun.target.position.set(C.W / 2, 0, C.H / 2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -2100, right: 2100, top: 1700, bottom: -1700, near: 200, far: 3600 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// ---------- textures ----------
const maxAniso = renderer.capabilities.getMaxAnisotropy();

function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// deterministic pseudo-random so the map looks the same for everyone
function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

const CARD = ['#c99a5e', '#c4925a', '#d0a46b', '#bf8f55'];
const TAPE = 'rgba(231,214,168,0.92)';

function cardboard(g, w, h, base) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const r = seeded(w * 31 + base.charCodeAt(3));
  for (let i = 0; i < 600; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(60,35,10,${r() * 0.08})` : `rgba(255,240,210,${r() * 0.08})`;
    g.fillRect(r() * w, r() * h, 2, 2);
  }
  g.strokeStyle = 'rgba(110,72,36,0.95)';
  g.lineWidth = 5;
  g.strokeRect(2, 2, w - 4, h - 4);
}

// BoxGeometry face order: +x, -x, +y (top), -y, +z, -z. The top face's u runs along x,
// so tape across the top along x wraps down onto the ±x faces.
const boxMats = CARD.map((base, v) => {
  const top = canvasTex(128, 128, (g, w, h) => {
    cardboard(g, w, h, base);
    g.fillStyle = TAPE; g.fillRect(0, 52, w, 24);
    if (v === 1) g.fillRect(52, 0, 24, h);
    g.strokeStyle = 'rgba(90,60,30,0.6)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, 64); g.lineTo(w, 64); g.stroke();
    if (v === 2) {
      g.fillStyle = '#b4302a';
      for (const ox of [36, 92]) { g.beginPath(); g.moveTo(ox, 14); g.lineTo(ox + 10, 32); g.lineTo(ox - 10, 32); g.fill(); }
    } else if (v === 3) {
      g.fillStyle = '#f5f1e6'; g.fillRect(74, 86, 40, 30);
      g.fillStyle = '#555'; g.fillRect(80, 93, 28, 3); g.fillRect(80, 101, 18, 3);
    }
  });
  const sideX = canvasTex(128, 128, (g, w, h) => {
    cardboard(g, w, h, base);
    g.fillStyle = TAPE; g.fillRect(52, 0, 24, 44);
  });
  const sideZ = canvasTex(128, 128, (g, w, h) => {
    cardboard(g, w, h, base);
    if (v === 1) { g.fillStyle = TAPE; g.fillRect(52, 0, 24, 44); }
    g.textAlign = 'center';
    if (v === 0) {
      g.strokeStyle = 'rgba(70,45,20,0.55)'; g.lineWidth = 5;
      g.beginPath(); g.arc(64, 76, 20, 0.3, Math.PI * 1.7); g.stroke();
    } else if (v === 2) {
      g.fillStyle = '#b4302a'; g.font = 'bold 20px Inter, sans-serif';
      g.fillText('FRAGILE', 64, 98);
      for (const ox of [44, 84]) { g.beginPath(); g.moveTo(ox, 42); g.lineTo(ox + 11, 62); g.lineTo(ox - 11, 62); g.fill(); g.fillRect(ox - 4, 62, 8, 12); }
    } else if (v === 3) {
      g.fillStyle = '#f5f1e6'; g.fillRect(24, 56, 80, 50);
      g.fillStyle = '#333';
      for (let x = 30; x < 98; x += 3 + (x % 7 === 0 ? 2 : 0)) g.fillRect(x, 82, (x % 5) ? 1.5 : 3, 18);
      g.fillRect(30, 62, 50, 4); g.fillRect(30, 70, 34, 4);
    }
  });
  const bottom = canvasTex(64, 64, (g, w, h) => cardboard(g, w, h, base));
  const m = t => new THREE.MeshLambertMaterial({ map: t });
  const [mx, mt, mz, mb] = [m(sideX), m(top), m(sideZ), m(bottom)];
  return [mx, mx, mt, mb, mz, mz];
});

const cutMat = new THREE.MeshLambertMaterial({
  map: canvasTex(128, 128, g => {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,230,190,0.75)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(16, 26); g.lineTo(52, 58); g.lineTo(66, 60); g.lineTo(112, 100); g.stroke();
    g.strokeStyle = '#2e1b0b'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(16, 32); g.lineTo(52, 64); g.lineTo(66, 66); g.lineTo(112, 106); g.stroke();
  }),
  transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
});

const floorTex = canvasTex(2048, Math.round(2048 * C.H / C.W), (g, w, h) => {
  g.scale(w / C.W, h / C.H);
  g.fillStyle = '#8f908a'; g.fillRect(0, 0, C.W, C.H);
  g.strokeStyle = 'rgba(0,0,0,0.1)'; g.lineWidth = 3;
  g.beginPath();
  for (let x = 0; x <= C.W; x += 100) { g.moveTo(x, 0); g.lineTo(x, C.H); }
  for (let y = 0; y <= C.H; y += 100) { g.moveTo(0, y); g.lineTo(C.W, y); }
  g.stroke();
  const r = seeded(42);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(30,25,20,${0.03 + r() * 0.05})`;
    g.beginPath(); g.arc(r() * C.W, r() * C.H, 20 + r() * 70, 0, Math.PI * 2); g.fill();
  }
  for (const z of ZONES) {
    if (z.kind === 'carpet') {
      g.fillStyle = '#56616d'; g.fillRect(z.x, z.y, z.w, z.h);
      g.strokeStyle = 'rgba(0,0,0,0.14)'; g.lineWidth = 2;
      g.beginPath();
      for (let x = z.x; x <= z.x + z.w; x += 60) { g.moveTo(x, z.y); g.lineTo(x, z.y + z.h); }
      for (let y = z.y; y <= z.y + z.h; y += 60) { g.moveTo(z.x, y); g.lineTo(z.x + z.w, y); }
      g.stroke();
    } else {
      g.fillStyle = 'rgba(40,38,34,0.12)'; g.fillRect(z.x, z.y, z.w, z.h);
    }
  }
  g.strokeStyle = 'rgba(240,200,40,0.65)'; g.lineWidth = 8; g.setLineDash([40, 30]);
  g.beginPath();
  for (const [x1, y1, x2, y2] of LANES) { g.moveTo(x1, y1); g.lineTo(x2, y2); }
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.font = '56px Bungee, Impact, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const room of ROOMS) g.fillText(room.name, room.lx, room.ly);
});

const wallTex = len => {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5a5f66'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      const grad = g.createLinearGradient(x, 0, x + 16, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.08)'); grad.addColorStop(0.5, 'rgba(0,0,0,0.12)'); grad.addColorStop(1, 'rgba(255,255,255,0.08)');
      g.fillStyle = grad; g.fillRect(x, 0, 16, h);
    }
    g.fillStyle = '#3d4147'; g.fillRect(0, h - 30, w, 30);
    for (let x = -30; x < w; x += 30) {
      g.fillStyle = '#f2c230'; g.beginPath(); g.moveTo(x, h); g.lineTo(x + 15, h); g.lineTo(x + 30, h - 22); g.lineTo(x + 15, h - 22); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, 0, w, 14);
  }, true);
  t.repeat.set(len / 220, 1);
  return t;
};

// painted block walls between rooms
const innerWallTex = len => {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#b5ae9f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2;
    for (let y = 0, row = 0; y < h; y += 32, row++) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      for (let x = (row % 2) * 32; x < w; x += 64) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 32); g.stroke(); }
    }
    g.fillStyle = '#4a4e56'; g.fillRect(0, h - 18, w, 18);
  }, true);
  t.repeat.set(len / 220, 1);
  return t;
};

const plateTex = canvasTex(64, 64, (g, w, h) => {
  g.fillStyle = '#8d9096'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  for (let y = 4; y < h; y += 16) for (let x = (y / 16 % 2) * 8 + 2; x < w; x += 16) g.fillRect(x, y, 8, 3);
}, true);

const crateTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#8a5d34'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(50,28,10,0.5)'; g.lineWidth = 2;
  for (let y = 16; y < h; y += 22) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.strokeStyle = '#5a3a1e'; g.lineWidth = 12;
  g.strokeRect(6, 6, w - 12, h - 12);
  g.beginPath(); g.moveTo(10, 10); g.lineTo(w - 10, h - 10); g.stroke();
});

const hazardTex = canvasTex(128, 64, (g, w, h) => {
  g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#1d1d1d';
  for (let x = -h; x < w; x += 32) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 16 + h, 0); g.lineTo(x + h, 0); g.fill(); }
}, true);

// ---------- warehouse ----------
const lambert = c => new THREE.MeshLambertMaterial({ color: c });
const M = {
  upright: lambert(0x2b5c9e),
  beam: lambert(0xe8792b),
  deck: lambert(0x9a9c9e),
  concrete: lambert(0x7b7e82),
  ceiling: lambert(0x2a2826),
  lamp: new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
  crate: new THREE.MeshLambertMaterial({ map: crateTex }),
  hazard: new THREE.MeshLambertMaterial({ map: hazardTex }),
  items: ['#7d5a3a', '#5c6b7a', '#8a3b2e', '#6d7a4a', '#9b7a4c', '#3f5f8a'].map(lambert),
  platform: lambert(0x7d8086),
  trim: lambert(0xf2c230),
  step: lambert(0x6e7076),
  lintel: lambert(0xa9a293),
  wood: lambert(0x8b6a45),
  metal: lambert(0x7d848c),
  dark: lambert(0x26282c),
};

const camBlockers = []; // solid meshes the third-person camera shouldn't pass through

// Static geometry is merged per material to keep draw calls low.
const staticGeo = new Map();
function addBlock(mat, w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  if (!staticGeo.has(mat)) staticGeo.set(mat, []);
  staticGeo.get(mat).push(g);
}

function buildWarehouse() {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(C.W, C.H), new THREE.MeshLambertMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(C.W / 2, 0, C.H / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(C.W, C.H), M.ceiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(C.W / 2, WALL_H, C.H / 2);
  scene.add(ceiling);
  for (const room of ROOMS) {
    const nx = Math.max(1, Math.round(room.w / 520)), nz = Math.max(1, Math.round(room.h / 420));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      addBlock(M.lamp, Math.min(380, room.w / nx - 80), 3, 12, room.x + (i + 0.5) * room.w / nx, WALL_H - 3, room.y + (j + 0.5) * room.h / nz);
    }
  }

  // raised floors: a solid block with a steel top and a yellow safety edge
  for (const p of PLATFORMS) {
    addBlock(M.platform, p.w, p.top, p.h, p.x + p.w / 2, p.top / 2, p.y + p.h / 2);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshLambertMaterial({ map: plateTex.clone() }));
    plate.material.map.repeat.set(p.w / 64, p.h / 64);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(p.x + p.w / 2, p.top + 0.3, p.y + p.h / 2);
    plate.receiveShadow = true;
    scene.add(plate);
    addBlock(M.trim, p.w, 1, 6, p.x + p.w / 2, p.top + 0.5, p.y + 3);
    addBlock(M.trim, p.w, 1, 6, p.x + p.w / 2, p.top + 0.5, p.y + p.h - 3);
    addBlock(M.trim, 6, 1, p.h, p.x + 3, p.top + 0.5, p.y + p.h / 2);
    addBlock(M.trim, 6, 1, p.h, p.x + p.w - 3, p.top + 0.5, p.y + p.h / 2);
  }
  // stairs: real steps (collision treats them as a smooth ramp)
  for (const st of STAIRS) {
    const vert = st.up === 'n' || st.up === 's', len = vert ? st.h : st.w, wid = vert ? st.w : st.h;
    const n = Math.round(st.top / 10);
    for (let i = 0; i < n; i++) {
      const h = (i + 1) * st.top / n, a = (i + 0.5) * len / n; // distance of this step's middle from the bottom end
      const cx = st.up === 'e' ? st.x + a : st.up === 'w' ? st.x + st.w - a : st.x + st.w / 2;
      const cz = st.up === 's' ? st.y + a : st.up === 'n' ? st.y + st.h - a : st.y + st.h / 2;
      const [sx, sz] = vert ? [wid, len / n] : [len / n, wid];
      addBlock(M.step, sx, h, sz, cx, h / 2, cz);
      // yellow nosing on the front edge of each step
      const fx = st.up === 'e' ? -1 : st.up === 'w' ? 1 : 0, fz = st.up === 's' ? -1 : st.up === 'n' ? 1 : 0;
      addBlock(M.trim, vert ? wid : 3, 1, vert ? 3 : wid, cx + fx * (sx / 2 - 1.5), h + 0.4, cz + fz * (sz / 2 - 1.5));
    }
  }
  // door frames: wall above each doorway
  for (const d of DOORS) addBlock(M.lintel, d.w, WALL_H - DOOR_H, d.h, d.x + d.w / 2, DOOR_H + (WALL_H - DOOR_H) / 2, d.y + d.h / 2);

  const r = seeded(7);
  const SHELF_H = 172, LEVELS = [6, 62, 118, 172];
  for (const o of OBSTACLES) {
    const base = groundAt(o.x + o.w / 2, o.y + o.h / 2); // things up on a platform stand on it
    if (o.kind === 'wall') {
      const horiz = o.w > o.h;
      const outer = o.x === 0 || o.y === 0 || o.x + o.w === C.W || o.y + o.h === C.H;
      const tex = (outer ? wallTex : innerWallTex)(horiz ? o.w : o.h);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, WALL_H, o.h), new THREE.MeshLambertMaterial({ map: tex }));
      mesh.position.set(o.x + o.w / 2, WALL_H / 2, o.y + o.h / 2);
      mesh.receiveShadow = true;
      scene.add(mesh);
      camBlockers.push(mesh);
    } else if (o.kind === 'shelf') {
      // pallet racking: uprights, orange beams, decks, and stock you can peek between
      const horiz = o.w > o.h, L = horiz ? o.w : o.h, D = horiz ? o.h : o.w;
      const put = (mat, la, ld, h, a, d, y) => horiz
        ? addBlock(mat, la, h, ld, o.x + a, base + y, o.y + d)
        : addBlock(mat, ld, h, la, o.x + d, base + y, o.y + a);
      const n = Math.max(1, Math.round(L / 100));
      for (let i = 0; i <= n; i++) for (const d of [3, D - 3]) put(M.upright, 6, 6, SHELF_H, 3 + i * (L - 6) / n, d, SHELF_H / 2);
      for (const lv of LEVELS) {
        put(M.deck, L, D - 2, 3, L / 2, D / 2, lv);
        for (const d of [2, D - 2]) put(M.beam, L, 4, 7, L / 2, d, lv - 2);
      }
      for (const lv of LEVELS.slice(0, 3)) {
        let a = 8;
        while (a < L - 30) {
          const w = 18 + r() * 28;
          if (a + w > L - 6) break;
          if (r() < (lv === LEVELS[0] ? 0.6 : 0.8)) {
            const h = 14 + r() * 32, d = D - 10 - r() * 14;
            put(M.items[Math.floor(r() * M.items.length)], w, d, h, a + w / 2, D / 2, lv + 1.5 + h / 2);
          }
          a += w + 4 + r() * 16;
        }
      }
    } else if (o.kind === 'crate') {
      const big = o.w >= 120;
      const h = big ? 80 : o.w * 0.9;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(o.w, h, o.h), M.crate);
      crate.position.set(o.x + o.w / 2, base + h / 2, o.y + o.h / 2);
      crate.castShadow = crate.receiveShadow = true;
      scene.add(crate);
      camBlockers.push(crate);
      if (big) {
        const top = new THREE.Mesh(new THREE.BoxGeometry(84, 60, 84), M.crate);
        top.position.set(o.x + o.w / 2, base + h + 30, o.y + o.h / 2);
        top.rotation.y = 0.35;
        top.castShadow = top.receiveShadow = true;
        scene.add(top);
        camBlockers.push(top);
      }
    } else if (o.kind === 'pillar') {
      addBlock(M.concrete, o.w, WALL_H, o.h, o.x + o.w / 2, WALL_H / 2, o.y + o.h / 2);
      addBlock(M.hazard, o.w + 2, 70, o.h + 2, o.x + o.w / 2, 35, o.y + o.h / 2);
    } else if (o.kind === 'desk') {
      const cx = o.x + o.w / 2, cz = o.y + o.h / 2;
      addBlock(M.wood, o.w, 4, o.h, cx, 32, cz);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addBlock(M.dark, 4, 30, 4, cx + lx * (o.w / 2 - 5), 15, cz + lz * (o.h / 2 - 5));
      addBlock(M.wood, o.w - 10, 26, 3, cx, 17, o.y + 6); // modesty panel
      addBlock(M.dark, 44, 26, 3, cx, 49, o.y + 14);      // monitor
      addBlock(M.dark, 6, 10, 6, cx, 39, o.y + 16);
      addBlock(M.metal, 36, 2, 12, cx, 35, o.y + 44);     // keyboard
      addBlock(M.lintel, 22, 2, 28, o.x + 27, 35, o.y + 44); // papers
    } else if (o.kind === 'cabinet') {
      const horiz = o.w > o.h, n = Math.floor((horiz ? o.w : o.h) / 50);
      addBlock(M.metal, o.w, 100, o.h, o.x + o.w / 2, 50, o.y + o.h / 2);
      for (let i = 0; i < n; i++) for (const y of [25, 55, 85]) {
        // drawer handles on the room-facing side
        const a = (i + 0.5) / n;
        if (horiz) addBlock(M.dark, 14, 3, 2, o.x + a * o.w, y, o.y + o.h + 1);
        else addBlock(M.dark, 2, 3, 14, o.x - 1, y, o.y + a * o.h);
      }
    }
  }

  for (const [mat, geos] of staticGeo) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = mat !== M.lamp;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (mat !== M.lamp) camBlockers.push(mesh);
    geos.forEach(g => g.dispose());
  }
}
buildWarehouse();

// ---------- boxes ----------
const boxGeo = new THREE.BoxGeometry(C.BOX, C.BOX, C.BOX);
const cutGeo = new THREE.BoxGeometry(C.BOX + 0.8, C.BOX + 0.8, C.BOX + 0.8);
const boxMeshes = new Map(); // key -> mesh

// Floating icon/text sprites (power-up pops, X-ray markers). Textures are cached per label.
const labelTex = new Map();
function labelSprite(text, color = '#fff', depthTest = true) {
  if (!labelTex.has(text + color)) {
    labelTex.set(text + color, canvasTex(256, 128, (g, w, h) => {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `${[...text].length <= 2 ? 96 : 54}px Bungee, Impact, sans-serif`;
      g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, w / 2, h / 2);
      g.fillStyle = color; g.fillText(text, w / 2, h / 2);
    }));
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex.get(text + color), transparent: true, depthTest, fog: depthTest }));
  sp.scale.set(48, 24, 1);
  if (!depthTest) sp.renderOrder = 999; // drawn over walls
  return sp;
}

function syncBoxes(list, radarOn) {
  const seen = new Set();
  for (const b of list) {
    let m = boxMeshes.get(b.key);
    if (!m) {
      m = new THREE.Mesh(boxGeo, boxMats[b.v]);
      m.castShadow = m.receiveShadow = true;
      const cut = new THREE.Mesh(cutGeo, cutMat);
      cut.visible = false;
      m.add(cut);
      m.userData.cut = cut;
      scene.add(m);
      boxMeshes.set(b.key, m);
    }
    m.material = boxMats[b.v] || boxMats[0];
    m.position.set(b.x, C.BOX / 2 + b.z, b.y);
    m.rotation.y = -b.a; // map angles turn +x toward +y, which is three.js +z
    m.userData.cut.visible = !!b.cut;
    const marked = radarOn && radarKeys.has(b.key);
    if (marked && !m.userData.mark) {
      // x-ray marker, visible through walls
      m.userData.mark = labelSprite('▼', '#c77dff', false);
      m.userData.mark.position.y = 38;
      m.add(m.userData.mark);
    }
    if (m.userData.mark) m.userData.mark.visible = marked;
    seen.add(b.key);
  }
  for (const [k, m] of boxMeshes) if (!seen.has(k)) { scene.remove(m); boxMeshes.delete(k); }
}

// Floor power-ups: a spinning gem over a glowing ring, a beam of light to spot it from across
// the room, and the power-up's icon floating above.
const gemGeo = new THREE.OctahedronGeometry(10);
const pickupRingGeo = new THREE.RingGeometry(15, 22, 24);
const beamGeo = new THREE.CylinderGeometry(5, 9, 160, 12, 1, true);
beamGeo.translate(0, 80, 0);
const pickupMats = new Map(); // type -> { gem, ring }
const pickupMeshes = new Map(); // id -> group

function syncPickups(t) {
  const seen = new Set();
  for (const [id, x, y, z, type] of pickups) {
    let g = pickupMeshes.get(id);
    if (!g) {
      if (!pickupMats.has(type)) {
        const color = POWERS[type].color;
        pickupMats.set(type, {
          gem: new THREE.MeshBasicMaterial({ color }),
          ring: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
          beam: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
        });
      }
      const mats = pickupMats.get(type);
      g = new THREE.Group();
      const gem = new THREE.Mesh(gemGeo, mats.gem);
      gem.castShadow = true;
      const ring = new THREE.Mesh(pickupRingGeo, mats.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.7;
      const beam = new THREE.Mesh(beamGeo, mats.beam);
      const icon = labelSprite(POWERS[type].icon, POWERS[type].color);
      icon.scale.set(44, 22, 1);
      g.add(gem, ring, beam, icon);
      g.userData = { gem, ring, icon, phase: Math.random() * 6 };
      g.position.set(x, z, y);
      scene.add(g);
      pickupMeshes.set(id, g);
    }
    const u = g.userData, k = Math.sin(t / 300 + u.phase);
    u.gem.position.y = 20 + 3 * k;
    u.gem.rotation.y = t / 500;
    u.icon.position.y = 46 + 3 * k;
    u.ring.scale.setScalar(1 + 0.12 * k);
    seen.add(id);
  }
  for (const [id, g] of pickupMeshes) if (!seen.has(id)) { scene.remove(g); g.userData.icon.material.dispose(); pickupMeshes.delete(id); }
}

// Your own box, seen from behind.
const myMesh = new THREE.Mesh(boxGeo, boxMats[0]);
myMesh.castShadow = myMesh.receiveShadow = true;
myMesh.visible = false;
scene.add(myMesh);
// glow around your box while a power-up is active
const auraMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });
const aura = new THREE.Mesh(new THREE.BoxGeometry(C.BOX + 8, C.BOX + 8, C.BOX + 8), auraMat);
myMesh.add(aura);

// Floor marker showing your slash reach (only you see it).
const reachMat = new THREE.MeshBasicMaterial({ color: 0x57e389, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
const reachRing = r => new THREE.RingGeometry(r + C.R - 4, r + C.R, 24, 1, -C.SLASH_ARC / 2, C.SLASH_ARC);
const reachGeos = { normal: reachRing(C.SLASH_RANGE), long: reachRing(C.SLASH_RANGE * C.REACH_MULT) };
const reach = new THREE.Mesh(reachGeos.normal, reachMat);
reach.visible = false;
scene.add(reach);

function updateOwnBox(t) {
  const show = alive && !!me;
  myMesh.visible = show;
  reach.visible = show && phase === 'play';
  if (!show) return;
  myMesh.material = boxMats[me.variant] || boxMats[0];
  myMesh.position.set(me.x, C.BOX / 2 + me.z, me.y);
  myMesh.rotation.y = -me.a;
  const active = Object.keys(powers).filter(powered);
  aura.visible = active.length > 0;
  if (aura.visible) {
    auraMat.color.set(POWERS[active[0]].color);
    auraMat.opacity = 0.18 + 0.12 * Math.sin(t / 120);
  }
  reach.geometry = powered('reach') ? reachGeos.long : reachGeos.normal;
  // ring lies flat (angle t maps to (cos t, 0, sin t)); rotation.z spins it to face where you aim
  reach.rotation.set(Math.PI / 2, 0, yaw);
  reach.position.set(me.x, groundAt(me.x, me.y) + 0.8, me.y);
  const ready = t >= nextSlashAt;
  reachMat.color.set(ready ? 0x57e389 : 0xff5a3c);
  reachMat.opacity = ready ? 0.4 : 0.18;
}

// A box cutter that pops out of whichever box slashes and sweeps across the arc.
const cutterTemplate = new THREE.Group();
{
  const mat = c => new THREE.MeshLambertMaterial({ color: c });
  const handle = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 6.5), mat(0xf2c230));
  handle.position.z = 1.5;
  cutterTemplate.add(handle);
  for (const z of [0.6, 2.4, 4.0]) {
    const grip = new THREE.Mesh(new THREE.BoxGeometry(1.53, 1.13, 0.3), mat(0x3a3a3a));
    grip.position.z = z;
    cutterTemplate.add(grip);
  }
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0, 0.85); shape.lineTo(2.0, 0.85); shape.lineTo(2.9, 0); shape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
  bladeGeo.rotateY(Math.PI / 2); // point the blade forward (-z)
  const blade = new THREE.Mesh(bladeGeo, new THREE.MeshLambertMaterial({ color: 0xdfe6ec, emissive: 0x3a4148 }));
  blade.position.set(-0.06, -0.35, -1.75);
  cutterTemplate.add(blade);
  cutterTemplate.scale.setScalar(3.2);
}

// ---------- effects ----------
const slashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });

function spawnSlash(x, y, aim, h = 0, r = C.SLASH_RANGE) {
  const g = new THREE.RingGeometry(r - 30, r + 4, 20, 1, aim - C.SLASH_ARC / 2, C.SLASH_ARC);
  const m = new THREE.Mesh(g, slashMat.clone());
  m.rotation.x = Math.PI / 2; // ring lies flat; angle t maps to (cos t, 0, sin t)
  m.position.set(x, 24 + h, y);
  scene.add(m);
  const knife = cutterTemplate.clone();
  scene.add(knife);
  fx.slashes.push({ m, knife, x, y, h, aim, t: performance.now() });
}

const pieceGeo = new THREE.PlaneGeometry(9, 6);
const peanutGeo = new THREE.SphereGeometry(1.6, 6, 4);
peanutGeo.scale(1.6, 1, 1);
const decalTex = canvasTex(128, 128, g => {
  const s = 40;
  const rects = [[44, 44], [44, 4], [44, 84], [4, 44], [84, 44]];
  for (const [x, y] of rects) {
    g.fillStyle = '#b98a50'; g.fillRect(x, y, s, s);
    g.strokeStyle = '#6b4724'; g.lineWidth = 2; g.strokeRect(x, y, s, s);
  }
  g.strokeStyle = '#2e1b0b'; g.lineWidth = 5;
  g.beginPath(); g.moveTo(20, 30); g.lineTo(108, 98); g.stroke();
});

const confettiGeo = new THREE.PlaneGeometry(3.5, 2.2);
const bubbleGeo = new THREE.SphereGeometry(3, 8, 6);

function burst(x, y, z, a, v, confettiColor) {
  const card = new THREE.MeshLambertMaterial({ color: CARD[v] || CARD[0], side: THREE.DoubleSide, transparent: true });
  const white = new THREE.MeshLambertMaterial({ color: 0xfffaf0, transparent: true });
  const party = new THREE.MeshBasicMaterial({ color: confettiColor || 0xffffff, side: THREE.DoubleSide, transparent: true });
  const life = 2.5 + Math.random(); // one lifetime per burst: its particles share (and fade) these materials together
  const n = confettiColor ? 60 : 30;
  for (let i = 0; i < n; i++) {
    const peanut = i >= 16 && i < 30, confetti = i >= 30;
    const m = new THREE.Mesh(confetti ? confettiGeo : peanut ? peanutGeo : pieceGeo, confetti ? party : peanut ? white : card);
    m.position.set(x, z + 18 + Math.random() * 16, y);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    m.castShadow = true;
    scene.add(m);
    const ang = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 200;
    fx.particles.push({ m, vx: Math.cos(ang) * sp, vy: 120 + Math.random() * 240, vz: Math.sin(ang) * sp,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(16), age: 0, life });
  }
  fx.particles.at(-1).mats = [card, white, party]; // disposed with the burst's last particle

  const decal = new THREE.Mesh(new THREE.PlaneGeometry(68, 68),
    new THREE.MeshLambertMaterial({ map: decalTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  decal.rotation.set(-Math.PI / 2, 0, -a);
  decal.position.set(x, z + 0.6, y);
  decal.receiveShadow = true;
  scene.add(decal);
  fx.decals.push({ m: decal, t: performance.now() });
  if (fx.decals.length > 30) removeDecal(fx.decals.shift());
}

// glittery puff when a floor power-up is grabbed
function sparkle(x, y, z, color) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true });
  for (let i = 0; i < 24; i++) {
    const m = new THREE.Mesh(confettiGeo, mat);
    m.position.set(x, z + 16, y);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    scene.add(m);
    const ang = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 120;
    fx.particles.push({ m, vx: Math.cos(ang) * sp, vy: 150 + Math.random() * 200, vz: Math.sin(ang) * sp,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(20), age: 0, life: 1.2 });
  }
  fx.particles.at(-1).mats = [mat];
}

// bubble wrap popping
function bubbles(x, y, z) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xe6f3ff, transparent: true, opacity: 0.8 });
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(bubbleGeo, mat);
    m.position.set(x, z + 20 + Math.random() * 10, y);
    scene.add(m);
    const ang = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 120;
    fx.particles.push({ m, vx: Math.cos(ang) * sp, vy: 80 + Math.random() * 160, vz: Math.sin(ang) * sp, spin: new THREE.Vector3(), age: 0, life: 0.9 });
  }
  fx.particles.at(-1).mats = [mat];
}

// a label that rises and fades, e.g. the power-up icon from a cracked box
function floatLabel(x, y, z, text, color) {
  const sp = labelSprite(text, color);
  sp.position.set(x, z + 50, y);
  scene.add(sp);
  fx.icons.push({ sp, y0: z + 50, t: performance.now() });
}

function removeDecal(d) { scene.remove(d.m); d.m.geometry.dispose(); d.m.material.dispose(); }

function updateFx(dt, t) {
  fx.slashes = fx.slashes.filter(s => {
    const age = (t - s.t) / 260;
    if (age >= 1) { scene.remove(s.m, s.knife); s.m.geometry.dispose(); s.m.material.dispose(); return false; }
    s.m.material.opacity = 0.85 * (1 - age);
    s.m.scale.setScalar(1 + age * 0.12);
    // sweep the knife around the box; blade points outward (map angle θ means rotation.y = -θ - π/2)
    const ang = s.aim - C.SLASH_ARC / 2 + C.SLASH_ARC * Math.min(1, age * 1.6);
    s.knife.position.set(s.x + Math.cos(ang) * 30, 22 + s.h, s.y + Math.sin(ang) * 30);
    s.knife.rotation.set(0, -ang - Math.PI / 2, 0);
    return true;
  });
  for (const p of fx.particles) {
    p.age += dt;
    const m = p.m;
    if (!p.landed) {
      p.vy -= 650 * dt;
      m.position.x += p.vx * dt; m.position.y += p.vy * dt; m.position.z += p.vz * dt;
      m.rotation.x += p.spin.x * dt; m.rotation.y += p.spin.y * dt; m.rotation.z += p.spin.z * dt;
      const floor = groundAt(m.position.x, m.position.z) + 1;
      if (m.position.y <= floor && p.vy < 0) { m.position.y = floor; m.rotation.x = -Math.PI / 2; p.landed = true; }
    }
    m.material.opacity = clamp((p.life - p.age) / 0.5, 0, 1);
  }
  fx.particles = fx.particles.filter(p => {
    if (p.age < p.life) return true;
    scene.remove(p.m);
    if (p.mats) p.mats.forEach(mt => mt.dispose());
    return false;
  });
  fx.icons = fx.icons.filter(ic => {
    const age = (t - ic.t) / 1400;
    if (age >= 1) { scene.remove(ic.sp); ic.sp.material.dispose(); return false; }
    ic.sp.position.y = ic.y0 + age * 40;
    ic.sp.material.opacity = 1 - age * age;
    return true;
  });
  for (const d of fx.decals) d.m.material.opacity = clamp(1 - (t - d.t - 12000) / 3000, 0, 1) * 0.95;
  while (fx.decals.length && t - fx.decals[0].t > 15000) removeDecal(fx.decals.shift());
}

// ---------- audio (panned by direction relative to where you're looking) ----------
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
function spatial(x, y) {
  const c = alive && me ? me : deadAt;
  const d = Math.hypot(x - c.x, y - c.y);
  return { vol: clamp(1 - d / 1000, 0, 1), pan: d < 5 ? 0 : Math.sin(angleDiff(yaw, Math.atan2(y - c.y, x - c.x))) };
}
function noise(x, y, gain, dur, type, f0, f1, rough) {
  const { vol: v, pan } = spatial(x, y);
  const vol = gain * v;
  if (!actx || vol <= 0.01) return;
  const t = actx.currentTime;
  const src = actx.createBufferSource(); src.buffer = noiseBuf;
  const filt = actx.createBiquadFilter(); filt.type = type; filt.Q.value = 1.2;
  filt.frequency.setValueAtTime(f0, t); filt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  if (rough) {
    for (let s = 0; s < dur; s += 0.025) g.gain.setValueAtTime(vol * (0.3 + Math.random() * 0.7) * (1 - s / dur), t + s);
  } else {
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const panner = actx.createStereoPanner(); panner.pan.value = pan;
  src.connect(filt).connect(g).connect(panner).connect(actx.destination);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}
function tone(x, y, gain, f0, f1, dur) {
  const { vol: v, pan } = x === null ? { vol: 1, pan: 0 } : spatial(x, y);
  const vol = gain * v;
  if (!actx || vol <= 0.01) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const panner = actx.createStereoPanner(); panner.pan.value = pan;
  o.connect(g).connect(panner).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
const sfx = {
  chime: () => { tone(null, null, 0.25, 660, 1320, 0.22); setTimeout(() => tone(null, null, 0.22, 990, 1980, 0.3), 90); },
  ding: (x, y) => tone(x, y, 0.22, 880, 1760, 0.18),
  pop: (x, y) => { noise(x, y, 0.6, 0.12, 'highpass', 1800, 900); tone(x, y, 0.2, 300, 900, 0.12); },
  swish: (x, y) => noise(x, y, 0.5, 0.16, 'bandpass', 4200, 900),
  rip: (x, y) => noise(x, y, 0.9, 0.5, 'lowpass', 2600, 500, true),
};

// ---------- menu / connection ----------
try { $('name').value = localStorage.getItem('wtb-name') || ''; } catch {}

function lockPointer() {
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch {}
}

function join() {
  const name = $('name').value.trim() || 'Box';
  try { localStorage.setItem('wtb-name', name); } catch {}
  initAudio();
  lockPointer();
  $('status').textContent = 'Connecting…';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/fps`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    joined = false;
    document.exitPointerLock?.();
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('status').textContent = 'Disconnected from the warehouse. Hit PLAY to rejoin.';
    alive = false; me = null; snaps = []; timeOffset = null; pickups = [];
    syncBoxes([]);
    updateLockOverlay();
  };
}
$('play').onclick = join;
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
// handy for console testing
window.join = join;
window.wtbDebug = () => ({ me, alive, yaw, phase, particles: fx.particles.length, decals: fx.decals.length, boxes: boxMeshes.size, keys: [...boxMeshes.keys()] });
window.wtbLook = (y, e = elev) => { yaw = y; elev = e; };
window.wtbHandle = msg => handle(msg); // replay a server message locally (effects testing)

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function faceCentre(p) { yaw = Math.atan2(C.H / 2 - p.y, C.W / 2 - p.x); }

function handle(m) {
  const t = performance.now();
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      joined = true;
      $('menu').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $('status').textContent = '';
      setPhase(m.phase, m.timeLeft);
      options = m.options;
      UI.renderOptions(options);
      updateLockOverlay();
      break;
    case 'options':
      options = m.options;
      UI.renderOptions(options);
      addFeed(`${esc(m.by)} turned decoy movement <b>${options.moveDecoys ? 'ON' : 'OFF'}</b>`);
      break;
    case 'spawn':
      me = { x: m.x, y: m.y, z: m.z, a: m.a, key: m.key, seq: m.seq, variant: m.variant };
      jumpV = 0;
      alive = true;
      stamina = C.STAMINA_MAX; exhausted = false;
      faceCentre(me);
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
      burst(m.x, m.y, m.z, m.a, m.variant, def.color);
      floatLabel(m.x, m.y, m.z, def.icon, def.color);
      sfx.pop(m.x, m.y);
      break;
    }
    case 'pickup': {
      // someone grabbed a floor power-up
      const def = POWERS[m.type];
      sparkle(m.x, m.y, m.z, def.color);
      floatLabel(m.x, m.y, m.z, def.icon, def.color);
      sfx.ding(m.x, m.y);
      break;
    }
    case 'blocked':
      bubbles(m.x, m.y, m.z);
      floatLabel(m.x, m.y, m.z, 'BLOCKED!', '#dff1ff');
      sfx.pop(m.x, m.y);
      break;
    case 'radar':
      radarKeys = new Set(m.keys);
      radarAt = t;
      break;
    case 'slash': {
      const mine = me && Math.hypot(m.x - me.x, m.y - me.y) < 50 && t - lastLocalSlash < 500;
      if (!mine) { spawnSlash(m.x, m.y, m.aim, m.z, m.r); sfx.swish(m.x, m.y); }
      break;
    }
    case 'kill': {
      burst(m.x, m.y, m.z, m.a, m.variant);
      sfx.rip(m.x, m.y);
      const mineK = m.kid === myId, mineV = m.vid === myId;
      addFeed(`<span class="k">${esc(m.killer)}</span> ✂ ${esc(m.victim)}`, mineK || mineV);
      if (mineK) {
        nextSlashAt = Math.min(nextSlashAt, t + C.SLASH_CD_HIT * 1000);
        slashCdTotal = C.SLASH_CD_HIT;
      }
      if (mineV) {
        alive = false;
        powers = {};
        deadAt = { x: m.x, y: m.y, z: m.z };
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
      while (fx.decals.length) removeDecal(fx.decals.shift());
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
function updateLockOverlay() { $('lock').classList.toggle('hidden', !joined || locked); }

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked) keys.clear();
  updateLockOverlay();
});
$('lock').addEventListener('click', lockPointer);
document.addEventListener('mousemove', e => {
  if (!locked) return;
  yaw += e.movementX * SENS;
  elev = clamp(elev + e.movementY * SENS, -0.1, 1.25);
});
canvas.addEventListener('mousedown', e => {
  if (!locked) return lockPointer();
  if (e.button === 0) trySlash();
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

addEventListener('keydown', e => {
  if (document.activeElement === $('name')) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) tryJump(); }
  if (e.code === 'KeyF' && !e.repeat) trySlash();
  if (e.code === 'KeyM' && !e.repeat) send({ t: 'opt', moveDecoys: !options.moveDecoys });
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
UI.bindScoreboardKey();

function trySlash() {
  const t = performance.now();
  if (!alive || !me || phase !== 'play' || t < nextSlashAt) return;
  send({ t: 'sl', aim: yaw });
  // assume a miss until the server tells us we cut someone
  const cd = powered('quick') ? C.SLASH_CD_HIT : C.SLASH_CD_MISS;
  nextSlashAt = t + cd * 1000;
  slashCdTotal = cd;
  lastLocalSlash = t;
  spawnSlash(me.x, me.y, yaw, me.z, myReach());
  sfx.swish(me.x, me.y);
}

function tryJump() {
  if (!alive || !me || me.z > groundUnder(me.x, me.y) + 0.5) return;
  jumpV = JUMP_V;
}

// ---------- simulation ----------
function updateLocal(dt) {
  const k = c => keys.has(c);
  yaw += ((k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0)) * KEY_TURN * dt;
  if (!alive || !me) return;

  const fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
  const side = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
  let mx = Math.cos(yaw) * fwd - Math.sin(yaw) * side;
  let my = Math.sin(yaw) * fwd + Math.cos(yaw) * side;
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
    // the box body turns toward where it moves (like decoys), not where you look
    me.a = turnToward(me.a, Math.atan2(my, mx), C.TURN * dt);
  }
  // shove out of boxes on our level (jumping clears them), then move: walls and high ledges block
  const min = C.R * 2;
  for (const b of visibleBoxes) {
    if (Math.abs(me.z - b.z) > LEVEL_GAP) continue;
    const ox = me.x - b.x, oy = me.y - b.y, d = Math.hypot(ox, oy);
    if (d < min && d > 0.01) { dx += (ox / d) * (min - d) * 0.5; dy += (oy / d) * (min - d) * 0.5; }
  }
  moveBox(me, dx, dy);
  // gravity: jumps, and dropping off ledges; walking down stairs just follows the floor
  const ground = groundUnder(me.x, me.y);
  if (jumpV > 0 || me.z - ground > C.STEP) {
    jumpV -= GRAVITY * dt;
    me.z += jumpV * dt;
    if (me.z <= ground) { me.z = ground; jumpV = 0; }
  } else {
    me.z = ground;
    jumpV = 0;
  }

  const t = performance.now();
  if (t - lastSend > 1000 / 30) {
    lastSend = t;
    send({ t: 'st', x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 100) / 100, z: Math.round(me.z), seq: me.seq, s: sprinting });
  }
}

function lerpAngle(a, b, f) { return a + angleDiff(a, b) * f; }

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

const lookTarget = new THREE.Vector3();
const camRay = new THREE.Raycaster();
const camDir = new THREE.Vector3();
function updateCamera(dt, t) {
  if (!joined) {
    // slow fly-over behind the menu
    const ang = t / 12000;
    camera.position.set(C.W / 2 + Math.cos(ang) * 700, 170, C.H / 2 + Math.sin(ang) * 450);
    camera.lookAt(C.W / 2, 30, C.H / 2);
    return;
  }
  if (alive && me) {
    // orbit behind your box; pull in if a wall, shelf or crate is in the way
    lookTarget.set(me.x, CAM_TARGET_H + me.z, me.y);
    camDir.set(-Math.cos(yaw) * Math.cos(elev), Math.sin(elev), -Math.sin(yaw) * Math.cos(elev));
    camRay.set(lookTarget, camDir);
    camRay.far = CAM_DIST;
    const hit = camRay.intersectObjects(camBlockers, false)[0];
    const want = hit ? Math.max(12, hit.distance - 8) : CAM_DIST;
    camDist = want < camDist ? want : camDist + (want - camDist) * (1 - Math.pow(0.02, dt));
    camera.position.copy(lookTarget).addScaledVector(camDir, camDist);
    // when pulled in tight, rise so you can still see over your own box
    camera.position.y = Math.max(camera.position.y + (CAM_DIST - camDist) * 0.3, groundAt(camera.position.x, camera.position.z) + 6);
    // aim the view a little ahead of the box so the crosshair points where you're facing
    camera.lookAt(me.x + Math.cos(yaw) * 60, CAM_TARGET_H * 0.75 + me.z, me.y + Math.sin(yaw) * 60);
  } else {
    // spectate your own remains from above the racking (172 tall), below the ceiling
    const k = 1 - Math.pow(0.05, dt);
    lookTarget.set(deadAt.x - Math.cos(yaw) * 60, 235, deadAt.y - Math.sin(yaw) * 60);
    camera.position.lerp(lookTarget, k);
    camera.lookAt(deadAt.x, deadAt.z, deadAt.y);
  }
}

function updateHud(t) {
  const hot = alive && me && phase === 'play' && visibleBoxes.some(b => Math.abs(b.z - me.z) < C.Z_REACH && inSlash(me.x, me.y, yaw, b.x, b.y, myReach()));
  $('crosshair').classList.toggle('hot', !!hot);
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
  syncBoxes(visibleBoxes, powered('radar') && t - radarAt < 500);
  syncPickups(t);
  updateOwnBox(t);
  updateCamera(dt, t);
  updateFx(dt, t);
  renderer.render(scene, camera);
  updateHud(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
