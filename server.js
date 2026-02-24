const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Game state
const games = {};
const players = {};

class Player {
  constructor(id, name, teamIndex, tankType) {
    this.id = id;
    this.name = name;
    this.teamIndex = teamIndex;
    this.tankType = tankType;
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.hp = 100;
    this.maxHp = 100;
    this.lives = 3;
    this.kills = 0;
    this.deaths = 0;
    this.ammo = 10;
    this.maxAmmo = 10;
    this.isReloading = false;
    this.reloadStartTime = 0;
    this.alive = true;
  }
}

class Projectile {
  constructor(x, y, angle, playerId, playerName, teamIndex) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * 8;
    this.vy = Math.sin(angle) * 8;
    this.playerId = playerId;
    this.playerName = playerName;
    this.teamIndex = teamIndex;
    this.damage = 20;
    this.lifetime = 500; // frames
    this.age = 0;
  }
}

class Game {
  constructor(gameId, mapId) {
    this.gameId = gameId;
    this.mapId = mapId || 0;
    this.players = {};
    this.projectiles = [];
    this.state = 'lobby'; // 'lobby', 'playing'
    this.teamCounts = [0, 0, 0, 0];
    this.scores = [0, 0, 0, 0];
    this.gameStartTime = null;
    this.mapIndex = mapId || 0;
  }

  addPlayer(player) {
    this.players[player.id] = player;
    this.teamCounts[player.teamIndex]++;
  }

  removePlayer(playerId) {
    const player = this.players[playerId];
    if (player) {
      this.teamCounts[player.teamIndex]--;
      delete this.players[playerId];
    }
  }

  canStartGame() {
    return Object.keys(this.players).length >= 2;
  }

  startGame() {
    this.state = 'playing';
    this.gameStartTime = Date.now();
    this.spawnAllPlayers();
  }

  spawnAllPlayers() {
    const spawnPoints = this.getSpawnPoints();
    let spawnIndex = 0;
    
    for (let playerId in this.players) {
      const player = this.players[playerId];
      const spawn = spawnPoints[spawnIndex % spawnPoints.length];
      player.x = spawn.x;
      player.y = spawn.y;
      player.angle = spawn.angle || 0;
      player.hp = player.maxHp;
      player.alive = true;
      spawnIndex++;
    }
  }

  getSpawnPoints() {
    const points = [
      { x: 100, y: 100, angle: 0 },
      { x: 700, y: 100, angle: Math.PI },
      { x: 100, y: 500, angle: Math.PI / 2 },
      { x: 700, y: 500, angle: -Math.PI / 2 },
      { x: 400, y: 100, angle: 0 },
      { x: 400, y: 500, angle: Math.PI },
      { x: 100, y: 300, angle: Math.PI / 2 },
      { x: 700, y: 300, angle: -Math.PI / 2 }
    ];
    return points;
  }

  update() {
    if (this.state !== 'playing') return;

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.x += proj.vx;
      proj.y += proj.vy;
      proj.age++;

      // Check if projectile is out of bounds or expired
      if (proj.x < 0 || proj.x > 800 || proj.y < 0 || proj.y > 600 || proj.age >= proj.lifetime) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Check collision with players
      for (let playerId in this.players) {
        const target = this.players[playerId];
        if (target.id === proj.playerId || !target.alive) continue;

        const dx = target.x - proj.x;
        const dy = target.y - proj.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
          // Hit!
          target.hp -= proj.damage;

          if (target.hp <= 0) {
            target.hp = 0;
            target.alive = false;
            target.deaths++;

            const shooter = this.players[proj.playerId];
            if (shooter) {
              shooter.kills++;
              this.scores[proj.teamIndex] += 20;
            }
          } else {
            this.scores[proj.teamIndex] += 1;
          }

          this.projectiles.splice(i, 1);
          break;
        }
      }
    }

    // Respawn dead players
    for (let playerId in this.players) {
      const player = this.players[playerId];
      if (!player.alive && player.lives > 0) {
        player.lives--;
        if (player.lives >= 0) {
          const spawnPoints = this.getSpawnPoints();
          const spawn = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
          player.x = spawn.x;
          player.y = spawn.y;
          player.hp = player.maxHp;
          player.alive = true;
        }
      }
    }
  }

  getGameState() {
    return {
      state: this.state,
      players: Object.values(this.players).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        angle: p.angle,
        hp: p.hp,
        maxHp: p.maxHp,
        lives: p.lives,
        kills: p.kills,
        deaths: p.deaths,
        ammo: p.ammo,
        maxAmmo: p.maxAmmo,
        alive: p.alive,
        teamIndex: p.teamIndex,
        tankType: p.tankType
      })),
      projectiles: this.projectiles.map(p => ({
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy
      })),
      scores: this.scores,
      mapIndex: this.mapIndex
    };
  }
}

// Socket connections
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('getGames', (callback) => {
    const gameList = Object.keys(games).map(id => ({
      id,
      playerCount: Object.keys(games[id].players).length,
      state: games[id].state
    }));
    callback(gameList);
  });

  socket.on('createGame', (mapId, callback) => {
    const gameId = 'game_' + Date.now();
    const game = new Game(gameId, mapId || 0);
    games[gameId] = game;
    callback(gameId);
  });

  socket.on('joinGame', (gameId, playerData, callback) => {
    if (!games[gameId]) {
      callback({ success: false, error: 'Game not found' });
      return;
    }

    const game = games[gameId];
    if (game.state !== 'lobby') {
      callback({ success: false, error: 'Game already started' });
      return;
    }

    if (game.teamCounts[playerData.teamIndex] >= 2) {
      callback({ success: false, error: 'Team is full' });
      return;
    }

    const player = new Player(socket.id, playerData.name, playerData.teamIndex, playerData.tankType);
    game.addPlayer(player);
    players[socket.id] = { gameId, player };

    socket.join(gameId);
    io.to(gameId).emit('gameStateUpdate', game.getGameState());
    io.to(gameId).emit('playerJoined', { name: playerData.name, teamIndex: playerData.teamIndex });

    callback({ success: true, playerId: socket.id });
  });

  socket.on('movePlayer', (direction, gameId) => {
    if (!players[socket.id]) return;
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;

    const speed = 3;
    const cos = Math.cos(player.angle);
    const sin = Math.sin(player.angle);

    if (direction === 'forward') {
      player.x += cos * speed;
      player.y += sin * speed;
    } else if (direction === 'backward') {
      player.x -= cos * speed;
      player.y -= sin * speed;
    } else if (direction === 'left') {
      player.angle -= 0.05;
    } else if (direction === 'right') {
      player.angle += 0.05;
    }

    // Keep player in bounds
    player.x = Math.max(20, Math.min(780, player.x));
    player.y = Math.max(20, Math.min(580, player.y));
  });

  socket.on('aim', (angle, gameId) => {
    if (!players[socket.id]) return;
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;
    player.angle = angle;
  });

  socket.on('shoot', (gameId) => {
    if (!players[socket.id]) return;
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;
    if (!player.alive || player.isReloading || player.ammo <= 0) return;

    const game = games[gameId];
    const projectile = new Projectile(
      player.x,
      player.y,
      player.angle,
      player.id,
      player.name,
      player.teamIndex
    );
    game.projectiles.push(projectile);
    player.ammo--;

    if (player.ammo === 0) {
      player.isReloading = true;
      player.reloadStartTime = Date.now();
    }

    io.to(gameId).emit('gameStateUpdate', game.getGameState());
  });

  socket.on('reload', (gameId) => {
    if (!players[socket.id]) return;
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;

    if (player.ammo < player.maxAmmo) {
      player.isReloading = true;
      player.reloadStartTime = Date.now();
      setTimeout(() => {
        player.ammo = player.maxAmmo;
        player.isReloading = false;
        io.to(gameId).emit('gameStateUpdate', games[gameId].getGameState());
      }, 2000);
    }
  });

  socket.on('startGame', (gameId, callback) => {
    const game = games[gameId];
    if (game && game.canStartGame()) {
      game.startGame();
      io.to(gameId).emit('gameStateUpdate', game.getGameState());
      io.to(gameId).emit('gameStarted');
      callback({ success: true });
    } else {
      callback({ success: false });
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const { gameId, player } = players[socket.id];
      const game = games[gameId];
      if (game) {
        game.removePlayer(socket.id);
        io.to(gameId).emit('gameStateUpdate', game.getGameState());
      }
      delete players[socket.id];
    }
    console.log('Player disconnected:', socket.id);
  });
});

// Game loop
setInterval(() => {
  for (let gameId in games) {
    const game = games[gameId];
    game.update();
    io.to(gameId).emit('gameStateUpdate', game.getGameState());
  }
}, 1000 / 60); // 60 FPS

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
