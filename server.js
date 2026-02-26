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
    this.vx = Math.cos(angle) * 8; // Sänkt från 15
    this.vy = Math.sin(angle) * 8;
    this.playerId = playerId;
    this.playerName = playerName;
    this.teamIndex = teamIndex;
    this.damage = 20;
    this.lifetime = 2000; // frames - längre livslängd
    this.age = 0;
    //console.log(`Projectile created: angle=${angle.toFixed(2)}, vx=${this.vx.toFixed(2)}, vy=${this.vy.toFixed(2)}`);
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
    
    // Define obstacles (x, y, width, height)
    this.obstacles = [
      { x: 300, y: 150, w: 60, h: 300 },   // Left-middle vertical
      { x: 1040, y: 150, w: 60, h: 300 },  // Right-middle vertical
      { x: 550, y: 200, w: 300, h: 50 },   // Upper-middle horizontal
      { x: 550, y: 350, w: 300, h: 50 },   // Lower-middle horizontal
      { x: 650, y: 250, w: 100, h: 100 }   // Center square
    ];
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

  isColliding(x, y, radius = 12) {
    // Check collision with obstacles - smaller radius for easier movement
    for (let obs of this.obstacles) {
      if (x + radius > obs.x && x - radius < obs.x + obs.w &&
          y + radius > obs.y && y - radius < obs.y + obs.h) {
        return true;
      }
    }
    return false;
  }

  projectileHitObstacle(x, y) {
    // Same check for projectiles
    for (let obs of this.obstacles) {
      if (x >= obs.x && x <= obs.x + obs.w &&
          y >= obs.y && y <= obs.y + obs.h) {
        return true;
      }
    }
    return false;
  }

  canStartGame() {
    return Object.keys(this.players).length >= 1;
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
      { x: 1300, y: 100, angle: Math.PI },
      { x: 100, y: 500, angle: Math.PI / 2 },
      { x: 1300, y: 500, angle: -Math.PI / 2 },
      { x: 700, y: 100, angle: 0 },
      { x: 700, y: 500, angle: Math.PI },
      { x: 100, y: 300, angle: Math.PI / 2 },
      { x: 1300, y: 300, angle: -Math.PI / 2 }
    ];
    return points;
  }

  update() {
    if (this.state !== 'playing') {
      return;
    }

    // Update and filter projectiles
    const projectilesToKeep = [];
    //console.log(`[UPDATE START] ${this.projectiles.length} projectiles before update`);
    
    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      proj.x += proj.vx;
      proj.y += proj.vy;
      proj.age++;

      // Check if projectile is out of bounds or expired
      if (proj.x < 0 || proj.x > 1400 || proj.y < 0 || proj.y > 600 || proj.age >= proj.lifetime) {
        continue;
      }

      // Check if projectile hit an obstacle
      if (this.projectileHitObstacle(proj.x, proj.y)) {
        continue; // Remove projectile
      }

      // Check collision with players
      let hit = false;
      for (let playerId in this.players) {
        const target = this.players[playerId];
        if (target.id === proj.playerId || !target.alive) continue;

        const dx = target.x - proj.x;
        const dy = target.y - proj.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < 900) { // 30*30 = 900 (utan sqrt)
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

          hit = true;
          break;
        }
      }

      // Bara behåll projektil om den inte träffade och är inom kartan
      if (!hit) {
        projectilesToKeep.push(proj);
      }
    }

    // Ersätt projektil-arrayen med de som överlevde
    this.projectiles = projectilesToKeep;
    //console.log(`[UPDATE END] ${this.projectiles.length} projectiles after update`);

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
  //console.log('Player connected:', socket.id);

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

    // Starta spelet automatiskt om vi har minst en spelare
    if (game.canStartGame() && game.state === 'lobby') {
      game.startGame();
      io.to(gameId).emit('gameStateUpdate', game.getGameState());
      io.to(gameId).emit('gameStarted');
    }
  });

  socket.on('movePlayer', (direction, gameId) => {
    if (!players[socket.id]) return;
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;
    const game = games[gameId];
    if (!game) return;

    const speed = 5;
    const cos = Math.cos(player.angle);
    const sin = Math.sin(player.angle);
    let newX = player.x;
    let newY = player.y;

    if (direction === 'forward') {
      newX += cos * speed;
      newY += sin * speed;
    } else if (direction === 'backward') {
      newX -= cos * speed;
      newY -= sin * speed;
    } else if (direction === 'left') {
      player.angle -= 0.08;
    } else if (direction === 'right') {
      player.angle += 0.08;
    }

    // Check collision with separate X/Y checks for smoother movement
    // Try full movement first
    if (!game.isColliding(newX, newY)) {
      player.x = newX;
      player.y = newY;
    } else {
      // If full movement collides, try X-only movement
      if (!game.isColliding(newX, player.y)) {
        player.x = newX;
      }
      // Try Y-only movement
      else if (!game.isColliding(player.x, newY)) {
        player.y = newY;
      }
      // If both collide, don't move
    }

    // Keep player in bounds
    player.x = Math.max(45, Math.min(1355, player.x));
    player.y = Math.max(45, Math.min(555, player.y));
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
    if (!game) {
      return;
    }

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

    // Skicka event för att spela ljud bara när skott verkligen skjuts
    socket.emit('shotFired');

    if (player.ammo === 0) {
      player.isReloading = true;
      player.reloadStartTime = Date.now();
      player.reloadTime = 1000; // 1 sekund reload-tid
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
      }, 1000);
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
    //console.log('Player disconnected:', socket.id);
  });
});

// Game loop
let loopCount = 0;
setInterval(() => {
  loopCount++;
  for (let gameId in games) {
    const game = games[gameId];
    if (loopCount % 60 === 0) { // Log every 60 frames (1 sec)
      //console.log(`[GameLoop] Game ${gameId}: state=${game.state}, players=${game.players.length}, projectiles=${game.projectiles.length}`);
    }
    game.update();
    const state = game.getGameState();
    if (state.projectiles.length > 0) {
      //console.log(`[Update] Game ${gameId}: ${state.projectiles.length} projectiles after update`, state.projectiles.map(p => `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`));
    }
    io.to(gameId).emit('gameStateUpdate', state);
  }
}, 1000 / 30); // 30 FPS - reducerad för mindre server load

server.listen(PORT, () => {
  //console.log(`Server running on port ${PORT}`);
});
