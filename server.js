// server.js
// Serves /public/* statically AND runs WebSocket on same origin.

import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PORT = process.env.PORT || 3000;

// ---------- Static file serving ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".mp3":  "audio/mpeg",
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, urlPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }
  serveStatic(req, res);
});

// ---------- WebSocket game server ----------
const wss = new WebSocketServer({ server });

// ---- Config ----
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;

const MAX_HP = 100;
const RESPAWN_MS = 1200;

const PLAYER_RADIUS = 0.55;

const SPEED = 9.8;
const ACCEL = 28.0;
const FRICTION = 12.0;

// Damage per weapon (server authoritative)
const DAMAGE_BY_WEAPON = {
  shotgun: 33,
  smg: 20,
};

// Fire rate (server authoritative) — anti-fusk
// (sekunder mellan skott)
const FIRE_INTERVAL_BY_WEAPON = {
  shotgun: 0.70,
  // SMG: ändra här om du vill (t.ex. 3 skott/sek => 1/3 ≈ 0.333)
  smg: 0.10, // 10 skott/sek
};

// Max queued shots per player (för att undvika spam)
const MAX_PENDING_SHOTS = 6;

// ---- Level ----
const CELL = 4;
const MAP = [
  "####################",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "####################"
];
const MAP_H = MAP.length;
const MAP_W = MAP[0].length;

function isWallCell(cx, cz) {
  if (cx < 0 || cz < 0 || cx >= MAP_W || cz >= MAP_H) return true;
  return MAP[cz][cx] === "#";
}

function circleHitsWall(x, z, r) {
  const minCX = Math.floor((x - r) / CELL);
  const maxCX = Math.floor((x + r) / CELL);
  const minCZ = Math.floor((z - r) / CELL);
  const maxCZ = Math.floor((z + r) / CELL);
  for (let cz = minCZ; cz <= maxCZ; cz++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      if (!isWallCell(cx, cz)) continue;
      const x0 = cx * CELL, x1 = x0 + CELL;
      const z0 = cz * CELL, z1 = z0 + CELL;
      const px = Math.max(x0, Math.min(x, x1));
      const pz = Math.max(z0, Math.min(z, z1));
      const dx = x - px, dz = z - pz;
      if (dx * dx + dz * dz < r * r) return true;
    }
  }
  return false;
}

function collideAndSlide(p, newX, newZ) {
  const r = PLAYER_RADIUS;
  if (!circleHitsWall(newX, p.z, r)) p.x = newX;
  if (!circleHitsWall(p.x, newZ, r)) p.z = newZ;
}

// ---- Rooms ----
const rooms = new Map();

function rid() { return crypto.randomBytes(4).toString("hex"); }
function nowMs() { return Date.now(); }
function nowSec() { return Date.now() / 1000; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function expSmoothingFactor(k, dt) { return 1 - Math.exp(-k * dt); }

function getOrCreateRoom(name) {
  const key = (name || "lobby").toLowerCase();
  let room = rooms.get(key);
  if (!room) {
    room = {
      name: key,
      players: new Map(),
      // pairKills: Map("killerId|victimId" -> count)
      pairKills: new Map(),
    };
    rooms.set(key, room);
  }
  return room;
}

function spawnPoint(room) {
  const base = [
    { x: 8,  z: 8  },
    { x: 68, z: 8  },
    { x: 8,  z: 52 },
    { x: 68, z: 52 },
    { x: 38, z: 28 },
  ];
  let sp = base[room.players.size % base.length];
  const cx = Math.floor(sp.x / CELL), cz = Math.floor(sp.z / CELL);
  if (isWallCell(cx, cz)) sp = { x: 8, z: 8 };
  return sp;
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function buildScoreboard(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    kills: p.kills || 0,
    deaths: p.deaths || 0,
  }));
}

function buildPairKills(room) {
  const out = [];
  for (const [key, count] of room.pairKills.entries()) {
    const [killerId, victimId] = key.split("|");
    const killer = room.players.get(killerId);
    const victim = room.players.get(victimId);
    out.push({
      killerId,
      victimId,
      killerName: killer?.name || "player",
      victimName: victim?.name || "player",
      count,
    });
  }
  out.sort((a,b)=> b.count - a.count);
  return out.slice(0, 12);
}

// ---- Hitscan ----
function yawPitchToDir(yaw, pitch) {
  // Same convention as client: forward = -Z
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  const x = -sy * cp;
  const y = sp;
  const z = -cy * cp;

  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

function rayBlockedByWall(ox, oz, dx, dz, maxDist) {
  const step = 0.35;
  let t = 0;
  while (t <= maxDist) {
    const cx = Math.floor((ox + dx * t) / CELL);
    const cz = Math.floor((oz + dz * t) / CELL);
    if (isWallCell(cx, cz)) return true;
    t += step;
  }
  return false;
}

function rayHitsPlayer(shooter, target, dirX, dirZ, maxDist = 60) {
  const ox = shooter.x, oz = shooter.z;
  const cx = target.x, cz = target.z;
  const r = PLAYER_RADIUS;
  const mx = cx - ox, mz = cz - oz;
  const t = mx * dirX + mz * dirZ;
  if (t < 0 || t > maxDist) return null;
  const px = ox + dirX * t;
  const pz = oz + dirZ * t;
  if ((cx - px) ** 2 + (cz - pz) ** 2 > r * r) return null;
  if (rayBlockedByWall(ox, oz, dirX, dirZ, t)) return null;
  return t;
}

function normalizeWeapon(w) {
  const s = String(w || "");
  return (s === "smg" || s === "shotgun") ? s : "shotgun";
}

// ---- WebSocket ----
wss.on("connection", (ws) => {
  let player = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }

    if (msg.t === "join") {
      const room = getOrCreateRoom(msg.room || "lobby");
      const id = rid();
      const sp = spawnPoint(room);

      player = {
        id, ws,
        room: room.name,
        name: String(msg.name || "player").slice(0, 16),
        x: sp.x, z: sp.z,
        yaw: 0, pitch: 0,
        hp: MAX_HP,
        lastHeardMs: nowMs(),
        vx: 0, vz: 0,
        inX: 0, inZ: 0,

        // NEW: shot queue + rate limit
        pendingShots: 0,
        nextShotAt: 0,        // seconds (server time)
        shootYaw: 0,
        shootPitch: 0,
        shootWeapon: "shotgun",

        weapon: "shotgun",
        kills: 0,
        deaths: 0,
      };

      room.players.set(id, player);

      ws.send(JSON.stringify({
        t: "welcome",
        id,
        room: room.name,
        you: { x: player.x, z: player.z, hp: player.hp },
        players: [...room.players.values()].map(p => ({
          id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, weapon: p.weapon
        })),
        scoreboard: buildScoreboard(room),
        pairKills: buildPairKills(room),
        ts: nowMs()
      }));

      broadcast(room, {
        t: "player_join",
        p: { id, name: player.name, x: player.x, z: player.z, yaw: 0, pitch: 0, hp: player.hp, weapon: player.weapon },
        scoreboard: buildScoreboard(room),
        pairKills: buildPairKills(room),
        ts: nowMs()
      });
      return;
    }

    if (!player) return;
    player.lastHeardMs = nowMs();

    if (msg.t === "input") {
      player.inX   = clamp(Number(msg.ix) || 0, -1, 1);
      player.inZ   = clamp(Number(msg.iz) || 0, -1, 1);
      player.yaw   = Number(msg.yaw) || 0;
      player.pitch = clamp(Number(msg.pitch) || 0, -1.4, 1.4);
      return;
    }

    if (msg.t === "weapon") {
      const w = normalizeWeapon(msg.weapon || "shotgun");
      player.weapon = w;

      const room = getOrCreateRoom(player.room);
      broadcast(room, { t:"weapon", id: player.id, weapon: player.weapon, ts: nowMs() });
      return;
    }

    if (msg.t === "shoot") {
      // Enqueue shot (droppa inte skott mellan ticks)
      if (player.hp <= 0) return;

      player.shootYaw   = Number(msg.yaw)   || player.yaw;
      player.shootPitch = clamp(Number(msg.pitch) || player.pitch, -1.4, 1.4);

      // Ta weapon från msg om den finns, annars spelarens val
      player.shootWeapon = normalizeWeapon(msg.weapon || player.weapon || "shotgun");

      // Anti-spam: cap queue
      player.pendingShots = Math.min(MAX_PENDING_SHOTS, player.pendingShots + 1);
      return;
    }

    if (msg.t === "name") {
      player.name = String(msg.name || player.name).slice(0, 16);
      const room = getOrCreateRoom(player.room);
      broadcast(room, {
        t: "player_name",
        id: player.id,
        name: player.name,
        scoreboard: buildScoreboard(room),
        pairKills: buildPairKills(room),
        ts: nowMs()
      });
      return;
    }
  });

  ws.on("close", () => {
    if (!player) return;
    const room = rooms.get(player.room);
    if (!room) return;
    room.players.delete(player.id);
    broadcast(room, { t: "player_leave", id: player.id, scoreboard: buildScoreboard(room), pairKills: buildPairKills(room), ts: nowMs() });
    if (room.players.size === 0) rooms.delete(room.name);
  });
});

// ---- One authoritative shot resolve ----
function resolveOneShot(room, shooter) {
  const weapon = normalizeWeapon(shooter.shootWeapon || shooter.weapon || "shotgun");
  const dmg = DAMAGE_BY_WEAPON[weapon] ?? DAMAGE_BY_WEAPON.shotgun;

  const dir = yawPitchToDir(shooter.shootYaw, shooter.shootPitch);
  let bestId = null, bestT = Infinity;

  // hitscan uses XZ for collision; pitch is mostly visual
  for (const target of room.players.values()) {
    if (target.id === shooter.id || target.hp <= 0) continue;
    const t = rayHitsPlayer(shooter, target, dir.x, dir.z, 60);
    if (t !== null && t < bestT) { bestT = t; bestId = target.id; }
  }

  if (bestId) {
    const victim = room.players.get(bestId);
    if (victim) {
      victim.hp -= dmg;

      if (victim.hp <= 0) {
        victim.hp = 0;

        shooter.kills = (shooter.kills || 0) + 1;
        victim.deaths = (victim.deaths || 0) + 1;

        const key = `${shooter.id}|${victim.id}`;
        room.pairKills.set(key, (room.pairKills.get(key) || 0) + 1);
        const pairCount = room.pairKills.get(key);

        broadcast(room, {
          t: "kill",
          killer: shooter.id,
          victim: victim.id,
          killerName: shooter.name,
          victimName: victim.name,
          pairCount,
          scoreboard: buildScoreboard(room),
          pairKills: buildPairKills(room),
          ts: nowMs()
        });

        setTimeout(() => {
          if (!room.players.has(victim.id)) return;
          const sp = spawnPoint(room);
          victim.x = sp.x; victim.z = sp.z;
          victim.vx = 0; victim.vz = 0;
          victim.hp = MAX_HP;

          broadcast(room, {
            t: "respawn",
            id: victim.id,
            x: victim.x,
            z: victim.z,
            hp: victim.hp,
            scoreboard: buildScoreboard(room),
            pairKills: buildPairKills(room),
            ts: nowMs()
          });
        }, RESPAWN_MS);
      }

      broadcast(room, {
        t: "hit",
        from: shooter.id,
        to: victim.id,
        hp: victim.hp,
        weapon,
        dmg,
        scoreboard: buildScoreboard(room),
        pairKills: buildPairKills(room),
        ts: nowMs()
      });
    }
  }

  // Broadcast visual shot for tracers (yaw + pitch!)
  broadcast(room, {
    t: "shot",
    id: shooter.id,
    yaw: shooter.shootYaw,
    pitch: shooter.shootPitch,
    weapon,
    scoreboard: buildScoreboard(room),
    pairKills: buildPairKills(room),
    ts: nowMs()
  });
}

// ---- Game tick ----
setInterval(() => {
  for (const room of rooms.values()) {
    // Movement
    for (const p of room.players.values()) {
      if (nowMs() - p.lastHeardMs > 30000) {
        try { p.ws.close(); } catch {}
        room.players.delete(p.id);
        broadcast(room, { t: "player_leave", id: p.id, scoreboard: buildScoreboard(room), pairKills: buildPairKills(room), ts: nowMs() });
        continue;
      }

      let ix = p.inX, iz = p.inZ;
      const il = Math.hypot(ix, iz);
      if (il > 1e-6) { ix /= il; iz /= il; } else { ix = 0; iz = 0; }

      if (ix !== 0 || iz !== 0) {
        const t = expSmoothingFactor(ACCEL, DT);
        p.vx = lerp(p.vx, ix * SPEED, t);
        p.vz = lerp(p.vz, iz * SPEED, t);
      } else {
        const t = expSmoothingFactor(FRICTION, DT);
        p.vx = lerp(p.vx, 0, t);
        p.vz = lerp(p.vz, 0, t);
      }

      const minX = 0.5, maxX = MAP_W * CELL - 0.5;
      const minZ = 0.5, maxZ = MAP_H * CELL - 0.5;
      collideAndSlide(p, clamp(p.x + p.vx * DT, minX, maxX), clamp(p.z + p.vz * DT, minZ, maxZ));
    }

    // Shooting (queue + rate limit)
    const tNow = nowSec();
    for (const shooter of room.players.values()) {
      if (shooter.hp <= 0) { shooter.pendingShots = 0; continue; }
      if (shooter.pendingShots <= 0) continue;

      const w = normalizeWeapon(shooter.shootWeapon || shooter.weapon || "shotgun");
      const interval = FIRE_INTERVAL_BY_WEAPON[w] ?? FIRE_INTERVAL_BY_WEAPON.shotgun;

      // Process as many as allowed this tick, but only if interval permits
      let safety = 6; // extra guard
      while (shooter.pendingShots > 0 && tNow >= shooter.nextShotAt && safety-- > 0) {
        shooter.pendingShots--;
        shooter.nextShotAt = tNow + interval;
        resolveOneShot(room, shooter);
      }
    }

    // State snapshot
    broadcast(room, {
      t: "state",
      ts: nowMs(),
      scoreboard: buildScoreboard(room),
      pairKills: buildPairKills(room),
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, weapon: p.weapon
      }))
    });
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => console.log("Listening on", PORT));
