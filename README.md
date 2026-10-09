# What The Box? (clone)

A multiplayer hide-and-slash game for the browser. Every player is a cardboard box hiding in a warehouse full of identical decoy boxes. Find the boxes that are real players and cut them open with your box cutter before they get you.

There are two games with the same rules and separate arenas:

- **Top-down (2D)** at `/topdown.html`: a canvas view of the whole warehouse floor around you.
- **3D** at `/fps.html`: a three.js third-person view with the camera behind your box. Racking, crates and fog block your view, you can jump, and sounds pan left and right by direction.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000 and pick a mode. Other people on your network can join at `http://<your-ip>:3000`.

## Run it with Docker

```bash
docker compose up --build
```

Or without Compose:

```bash
docker build -t what-the-box-clone .
docker run --rm -p 3000:3000 what-the-box-clone
```

Then open http://localhost:3000. Pass any of the settings below with `-e`, for example `-e BOT_FILL=6 -e DECOYS_MOVE=1`, or edit them in `docker-compose.yml`. The image is based on `node:22-alpine`, runs as the unprivileged `node` user, and includes a health check.

## Deploy to Kubernetes (Traefik)

`k8s/` has a namespace, a ConfigMap with the game settings, a Deployment, a Service, and a standard `Ingress` for Traefik (`ingressClassName: traefik`). To deploy:

1. Build the image and push it somewhere your cluster can pull from, or load it into k3d or kind. Then set the image in `k8s/kustomization.yaml` (the `images:` block) or in `k8s/deployment.yaml`.
2. Set your hostname in `k8s/ingress.yaml`, and uncomment its `tls:` block if you want HTTPS.
3. Apply:

```bash
kubectl apply -k k8s/
```

Notes:

- **Keep `replicas: 1`.** All game state is in memory, so a second pod would be a separate warehouse and players would be split between them. The Deployment uses the `Recreate` strategy for the same reason.
- WebSockets (`/ws/topdown` and `/ws/fps`) go through Traefik with no extra configuration. Over HTTPS the client switches to `wss://` automatically.
- If your Traefik's IngressClass isn't named `traefik`, change `ingressClassName` to match (`kubectl get ingressclass`).
- Edit the ConfigMap to change settings, then restart: `kubectl -n what-the-box rollout restart deployment/what-the-box`.

## The warehouse

Both modes share one map with four rooms joined by doorways:

- **Main Hall**: pallet racking, pillars, a crate stack, and a **mezzanine** up a flight of stairs
- **Loading Dock**: a long raised **dock platform** with stairs at both ends
- **Office**: carpet, desks and filing cabinets
- **Storage**: tall racking and a **loft** reached by stairs

Stairs are the only way up. You can drop off any ledge, but you can't climb one. A slash only reaches boxes at roughly your own height.

## How to play

| Control | Top-down | 3D |
| --- | --- | --- |
| WASD | Move | Move / strafe relative to where you look |
| Arrow keys | Move | ↑↓ move, ←→ turn |
| Mouse | Aim | Orbit the camera (click to capture the mouse, Esc releases it) |
| Shift | Sprint (uses stamina) | Sprint |
| Left click | Slash toward the mouse | Slash toward the crosshair (it turns red when a box is in reach) |
| Space | Slash | Jump. You can clear other boxes, but decoys never jump |
| F | | Slash |
| Tab | Scoreboard | Scoreboard |
| M | Toggle moving decoys | Toggle moving decoys |

In 3D your box only turns when it moves, the same way decoys do, so looking around doesn't give you away.

- **Blend in.** About 90 decoy boxes stand still by default, so any box that moves is a player. Move when nobody's watching.
- **Moving decoys (optional).** Press **M** in game to let decoys wander at walking speed (they never sprint or jump). Anyone in the arena can toggle it, the kill feed says who did, and the HUD shows the current setting. Start a server with `DECOYS_MOVE=1` to have it on from the start.
- **Power-ups.** About 1 in 6 decoys secretly holds a power-up. Cut one open and it bursts into confetti and gives you the power-up. It also doesn't count as a whiff, so cutting a decoy becomes a gamble: the cooldown penalty against the chance of a prize. Everyone sees the box pop.

  | | Power-up | Effect |
  |---|---|---|
  | ⚡ | Turbo Tape (10s) | 35% faster, and sprinting doesn't use stamina |
  | 🗡️ | Long Blade (12s) | Slash reaches 60% further |
  | ✂️ | Fresh Blade (12s) | Misses don't slow your cutter |
  | 🫧 | Bubble Wrap (30s) | Blocks the next cut. The attacker sees "BLOCKED!" and now knows you're a player |
  | 👓 | X-Ray Specs (6s) | Real players are marked, through walls in 3D |

  Power-ups also turn up **on the floor**: up to 6 at a time, a new one every 4–10 seconds, on any level. Walk over one to grab it. They glow, and in 3D they send up a beam of light, so they're easy to spot. But decoys never move to them, so running over to grab one shows everyone you're a player. Decoys never collect them, and bots sometimes go for nearby ones.

  Power-ups are enforced by the server, and bots can find and use them too.
- **Slash carefully.** Cutting a player resets your cutter quickly. Missing, or cutting a decoy, means a long cooldown.
- **Every slash is visible to everyone**, so attacking shows where you are. Nearby decoys scatter when someone slashes, which gives you a little cover.
- When you're cut open you respawn after 3 seconds by taking over a random decoy, so nobody sees you appear.
- Rounds last 3 minutes. The box with the most cuts wins.

Bots ("Cardboard Carl", "Flap Jack", …) fill the lobby when there aren't enough humans.

## Config (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | HTTP and WebSocket port |
| `BOT_FILL` | 4 | Bots top up the lobby to this many players (0 = no bots) |
| `ROUND_SECONDS` | 180 | Round length |
| `DECOYS_MOVE` | off | `1` makes decoys wander from the start (players can still toggle it with M) |

The settings apply to both arenas.

## Code layout

- `server.js`: HTTP and static files (three.js is served from `node_modules`, so no CDN is needed), and routes `/ws/topdown` and `/ws/fps` to their arenas
- `game.js`: `createGame()` runs one arena: decoy and bot AI, slash hit checks, kills and respawns, rounds, 20 Hz snapshots
- `shared.js`: constants, the warehouse map (rooms, doors, platforms, stairs, floor paint), and collision including floor heights and ledges, used by the server and both clients
- `public/ui.js`: HUD helpers (kill feed, scoreboard, round end, timer and bars) shared by both clients
- `public/client.js`: top-down canvas client
- `public/fps.js`: 3D three.js client: third-person camera with wall collision, jumping, warehouse geometry, procedural cardboard textures, 3D effects, panned audio
