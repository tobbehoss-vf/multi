// server.js
// Minimal authoritative-ish WebSocket server for a browser FPS.
// - Rooms
// - Player states (pos/yaw/pitch/hp)
// - Server tick broadcasts
// - Server-authoritative hitscan (simple sphere hit)
// NOTE: This is intentionally small. Not secure vs cheating; good for a prototype.

import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 3000;

// ---- Config ----
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;

const PLAYER_RADIUS = 0.55;
const PLAYER_EYE_Y = 1.7;
const MAX_HP = 100;

// movement tuning (Doom-ish)
const SPEED = 9.2;
const ACCEL = 24.0;
const FRICTION = 16.0;

// arena bounds (matches client tilemap-ish scale; keep generous)
const BOUNDS = { minX: 1, maxX: 95, minZ: 1, maxZ: 63 };

// ---- State ----
/** @type {Map<string, Room>} */
const rooms = new Map();

function rid() {
  return crypto.randomBytes(4).toString("hex");
}

function nowMs() {
  return Date.now();
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function vecLen(x, z) {
  return Math.sqrt(x * x + z * z);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function expSmoothingFactor(k, dt) {
  return 1 - Math.exp(-k * dt);
}

function getOrCreateRoom(name) {
  const key = (name || "lobby").toLowerCase();
  let room = rooms.get(key);
  if (!room) {
    room = {
      name: key,
      players: new Map(), // id -> player
    };
    rooms.set(key, room);
  }
  return room;
}

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {WebSocket} ws
 * @property {string} room
 * @property {string} name
 * @property {number} x
 * @property {number} z
 * @property {number} yaw
 * @property {number} pitch
 * @property {number} hp
 * @property {number} lastHeardMs
 * @property {number} vx
 * @property {number} vz
 * @property {number} inX
 * @property {number} inZ
 * @property {number} wantShoot
 * @property {number} shootYaw
 * @property {number} shootPitch
 */

function spawnPoint(room) {
  // simple deterministic-ish spawn positions
  const base = [
    { x: 8, z: 8 },
    { x: 84, z: 8 },
    { x: 8, z: 56 },
    { x: 84, z: 56 },
    { x: 46, z: 32 },
  ];
  const i = room.players.size % base.length;
  return base[i];
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

// ---- Hitscan: ray vs sphere in XZ plane with eye height fixed ----
function rayHitsPlayer(shooter, target, dirX, dirZ, maxDist = 60) {
  // Treat players as cylinders; in 2D (XZ) ray vs circle.
  // Ray origin = shooter (x,z)
  const ox = shooter.x;
  const oz = shooter.z;

  const cx = target.x;
  const cz = target.z;
  const r = PLAYER_RADIUS;

  // Solve closest approach along ray
  // t = dot((c-o), d)
  const dx = dirX;
  const dz = dirZ;
  const mx = cx - ox;
  const mz = cz - oz;
  const t = mx * dx + mz * dz;
  if (t < 0 || t > maxDist) return null;

  const px = ox + dx * t;
  const pz = oz + dz * t;
  const dist2 = (cx - px) ** 2 + (cz - pz) ** 2;
  if (dist2 <= r * r) return t;
  return null;
}

function yawPitchToDir(yaw, pitch) {
  // We ignore pitch for hit test in this simplified prototype (Doom-ish hitscan)
  // but keep it to allow future vertical aiming.
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  // normalize
  const l = Math.sqrt(dx * dx + dz * dz) || 1;
  return { dx: dx / l, dz: dz / l };
}

// ---- Server ----
const server = http.createServer((req, res) => {
  // basic health check
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  /** @type {Player|null} */
  let player = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    // JOIN
    if (msg.t === "join") {
      const room = getOrCreateRoom(msg.room || "lobby");
      const id = rid();
      const sp = spawnPoint(room);

      player = {
        id,
        ws,
        room: room.name,
        name: String(msg.name || "player").slice(0, 16),
        x: sp.x,
        z: sp.z,
        yaw: 0,
        pitch: 0,
        hp: MAX_HP,
        lastHeardMs: nowMs(),
        vx: 0,
        vz: 0,
        inX: 0,
        inZ: 0,
        wantShoot: 0,
        shootYaw: 0,
        shootPitch: 0,
      };

      room.players.set(id, player);

      // tell this client its id + current snapshot
      ws.send(
        JSON.stringify({
          t: "welcome",
          id,
          room: room.name,
          you: { x: player.x, z: player.z, hp: player.hp },
          players: [...room.players.values()].map((p) => ({
            id: p.id,
            name: p.name,
            x: p.x,
            z: p.z,
            yaw: p.yaw,
            pitch: p.pitch,
            hp: p.hp,
          })),
          ts: nowMs(),
        })
      );

      // tell others about new player
      broadcast(room, {
        t: "player_join",
        p: { id, name: player.name, x: player.x, z: player.z, yaw: 0, pitch: 0, hp: player.hp },
        ts: nowMs(),
      });
      return;
    }

    if (!player) return;

    player.lastHeardMs = nowMs();

    // INPUT (continuous)
    if (msg.t === "input") {
      // expect ix, iz in [-1..1], yaw/pitch in radians
      player.inX = clamp(Number(msg.ix) || 0, -1, 1);
      player.inZ = clamp(Number(msg.iz) || 0, -1, 1);
      player.yaw = Number(msg.yaw) || 0;
      player.pitch = clamp(Number(msg.pitch) || 0, -1.4, 1.4);
      return;
    }

    // SHOOT (edge)
    if (msg.t === "shoot") {
      player.wantShoot = 1;
      player.shootYaw = Number(msg.yaw) || player.yaw;
      player.shootPitch = Number(msg.pitch) || player.pitch;
      return;
    }

    // RENAME (optional)
    if (msg.t === "name") {
      player.name = String(msg.name || player.name).slice(0, 16);
      const room = getOrCreateRoom(player.room);
      broadcast(room, { t: "player_name", id: player.id, name: player.name, ts: nowMs() });
      return;
    }
  });

  ws.on("close", () => {
    if (!player) return;
    const room = rooms.get(player.room);
    if (!room) return;
    room.players.delete(player.id);
    broadcast(room, { t: "player_leave", id: player.id, ts: nowMs() });
    if (room.players.size === 0) rooms.delete(room.name);
  });
});

// ---- Tick loop ----
setInterval(() => {
  for (const room of rooms.values()) {
    // simulate
    for (const p of room.players.values()) {
      // simple timeout cleanup
      if (nowMs() - p.lastHeardMs > 30000) {
        try { p.ws.close(); } catch {}
        room.players.delete(p.id);
        broadcast(room, { t: "player_leave", id: p.id, ts: nowMs() });
        continue;
      }

      // movement: input is in camera-space on client, but we assume client already transforms to world-ish
      // Here we treat inX/inZ as world-space for simplicity; client sends in world-space.
      let ix = p.inX;
      let iz = p.inZ;

      // normalize input
      const il = Math.hypot(ix, iz);
      if (il > 1e-6) {
        ix /= il;
        iz /= il;
      } else {
        ix = 0; iz = 0;
      }

      const targetVx = ix * SPEED;
      const targetVz = iz * SPEED;

      if (ix !== 0 || iz !== 0) {
        const t = expSmoothingFactor(ACCEL, DT);
        p.vx = lerp(p.vx, targetVx, t);
        p.vz = lerp(p.vz, targetVz, t);
      } else {
        const t = expSmoothingFactor(FRICTION, DT);
        p.vx = lerp(p.vx, 0, t);
        p.vz = lerp(p.vz, 0, t);
      }

      p.x = clamp(p.x + p.vx * DT, BOUNDS.minX, BOUNDS.maxX);
      p.z = clamp(p.z + p.vz * DT, BOUNDS.minZ, BOUNDS.maxZ);
    }

    // handle shooting
    for (const shooter of room.players.values()) {
      if (!shooter.wantShoot) continue;
      shooter.wantShoot = 0;

      if (shooter.hp <= 0) continue;

      const { dx, dz } = yawPitchToDir(shooter.shootYaw, shooter.shootPitch);

      let best = { id: null, t: Infinity };
      for (const target of room.players.values()) {
        if (target.id === shooter.id) continue;
        if (target.hp <= 0) continue;

        const hitT = rayHitsPlayer(shooter, target, dx, dz, 60);
        if (hitT !== null && hitT < best.t) best = { id: target.id, t: hitT };
      }

      if (best.id) {
        const victim = room.players.get(best.id);
        if (victim) {
          victim.hp -= 10;
          if (victim.hp <= 0) {
            victim.hp = 0;

            // respawn after short delay
            setTimeout(() => {
              if (!room.players.has(victim.id)) return;
              const sp = spawnPoint(room);
              victim.x = sp.x;
              victim.z = sp.z;
              victim.vx = 0; victim.vz = 0;
              victim.hp = MAX_HP;
              // notify respawn
              broadcast(room, { t: "respawn", id: victim.id, x: victim.x, z: victim.z, hp: victim.hp, ts: nowMs() });
            }, 1200);
          }

          broadcast(room, {
            t: "hit",
            from: shooter.id,
            to: victim.id,
            hp: victim.hp,
            ts: nowMs(),
          });
        }
      }

      // broadcast shot event (for muzzle flash / sound later)
      broadcast(room, { t: "shot", id: shooter.id, yaw: shooter.shootYaw, ts: nowMs() });
    }

    // broadcast snapshot
    const snapshot = {
      t: "state",
      ts: nowMs(),
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        hp: p.hp,
      })),
    };
    broadcast(room, snapshot);
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});