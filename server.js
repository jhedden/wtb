// What The Box? clone — HTTP server.
// Serves both clients and hosts two separate arenas: top-down (2D) and first-person (3D).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { C } = require('./shared');
const { createGame } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
if (process.env.ROUND_SECONDS) C.ROUND = Number(process.env.ROUND_SECONDS);
const BOT_FILL = process.env.BOT_FILL !== undefined ? Number(process.env.BOT_FILL) : 4; // bots top up each lobby to this many players
const MOVE_DECOYS = process.env.DECOYS_MOVE === '1'; // decoys stand still unless enabled (players can toggle it in game)

// ---------- static file server ----------
const PUBLIC = path.join(__dirname, 'public');
const THREE = path.join(__dirname, 'node_modules', 'three');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function staticPath(url) {
  if (url === '/shared.js') return path.join(__dirname, 'shared.js');
  // three.js is served straight from node_modules so the FPS client works offline
  if (url.startsWith('/vendor/three/')) {
    const file = path.join(THREE, url.slice('/vendor/three/'.length));
    return file.startsWith(THREE + path.sep) ? file : null;
  }
  const file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  return file.startsWith(PUBLIC + path.sep) ? file : null;
}

const server = http.createServer((req, res) => {
  const file = staticPath(decodeURIComponent(req.url.split('?')[0]));
  if (!file) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- arenas ----------
const games = {
  // the top-down camera shows roughly a 1500x1100 window around the player
  '/ws/topdown': createGame({
    botFill: BOT_FILL,
    moveDecoys: MOVE_DECOYS,
    canSee: (p, x, y) => Math.abs(p.x - x) < 760 && Math.abs(p.y - y) < 560,
  }),
  // the 3D view is limited by fog (opaque 900 units from the camera, which trails ~120 behind the box)
  '/ws/fps': createGame({
    botFill: BOT_FILL,
    moveDecoys: MOVE_DECOYS,
    canSee: (p, x, y) => (p.x - x) ** 2 + (p.y - y) ** 2 < 1100 * 1100,
  }),
};

server.on('upgrade', (req, socket, head) => {
  const game = games[req.url.split('?')[0]];
  if (!game) return socket.destroy();
  game.wss.handleUpgrade(req, socket, head, ws => game.wss.emit('connection', ws, req));
});

server.listen(PORT, () => {
  console.log(`What The Box? clone running at http://localhost:${PORT}`);
  console.log(`  top-down:     http://localhost:${PORT}/topdown.html`);
  console.log(`  first-person: http://localhost:${PORT}/fps.html`);
});

// exit promptly on `docker stop` / Ctrl-C (Node as PID 1 ignores these signals by default)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
