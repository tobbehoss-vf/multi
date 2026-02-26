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
    this.vx = Math.cos(angle) * 40;
    this.vy = Math.sin(angle) * 40;
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
    
    // Generate random obstacles each game
    this.generateRandomObstacles();
  }

  generateRandomObstacles() {
    // Create a random maze-like pattern
    this.obstacles = [];
    
    // Random vertical walls
    for (let x = 150; x < 1400; x += Math.random() * 150 + 100) {
      const startY = Math.random() * 200 + 50;
      const height = Math.random() * 250 + 100;
      if (startY + height < 550) {
        this.obstacles.push({
          x: x,
          y: startY,
          w: 10,
          h: height
        });
      }
    }
    
    // Random horizontal walls
    for (let y = 150; y < 550; y += Math.random() * 150 + 100) {
      const startX = Math.random() * 400 + 100;
      const width = Math.random() * 250 + 80;
      if (startX + width < 1350) {
        this.obstacles.push({
          x: startX,
          y: y,
          w: width,
          h: 10
        });
      }
    }
    
    // Add some random center obstacles
    for (let i = 0; i < 3; i++) {
      const x = Math.random() * 1000 + 200;
      const y = Math.random() * 400 + 100;
      const size = Math.random() * 60 + 30;
      this.obstacles.push({
        x: x,
        y: y,
        w: size,
        h: size
      });
    }
  }

  addPlayer(player) {
    this.players[player.id] = player;
    this.teamCounts[player.teamIndex]++;
    
    // Spawn player at random position (either new game or joining mid-game)
    const spawn = this.getRandomSpawnPoint();
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = spawn.angle || 0;
    player.hp = player.maxHp;
    player.alive = true;
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
    for (let playerId in this.players) {
      const player = this.players[playerId];
      const spawn = this.getRandomSpawnPoint();
      player.x = spawn.x;
      player.y = spawn.y;
      player.angle = spawn.angle || 0;
      player.hp = player.maxHp;
      player.alive = true;
    }
  }

  getRandomSpawnPoint() {
    // Try to find a random spawn point that doesn't collide with obstacles
    let attempts = 0;
    let x, y;
    
    while (attempts < 50) {
      x = Math.random() * (1400 - 100) + 50;  // Random between 50-1350
      y = Math.random() * (600 - 100) + 50;   // Random between 50-550
      
      // Check if this position is valid (not in obstacle)
      if (!this.isColliding(x, y)) {
        return { x, y, angle: 0 };
      }
      attempts++;
    }
    
    // Fallback - return a safe zone
    return { x: 100, y: 100, angle: 0 };
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
        
        // Tanks i samma lag kan inte skada varandra
        if (target.teamIndex === proj.teamIndex) continue;

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
              this.scores[proj.teamIndex] += 1; // 1 poäng för kill
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

    // Respawn dead players after delay
    for (let playerId in this.players) {
      const player = this.players[playerId];
      if (!player.alive && player.lives > 0) {
        if (!player.deathTime) {
          player.deathTime = Date.now();
        }
        
        // Wait 2 seconds before respawning
        if (Date.now() - player.deathTime > 2000) {
          player.lives--;
          if (player.lives >= 0) {
            const spawn = this.getRandomSpawnPoint();
            player.x = spawn.x;
            player.y = spawn.y;
            player.hp = player.maxHp;
            player.alive = true;
            player.deathTime = null;
          }
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
      mapIndex: this.mapIndex,
      obstacles: this.obstacles
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
    })).filter(game => game.state === 'lobby' || game.state === 'playing');
    callback(gameList);
  });

  socket.on('createGame', (mapId, callback) => {
    const gameId = 'game_' + Date.now();
    const game = new Game(gameId, mapId || 0);
    games[gameId] = game;
    callback(gameId);
  });

  socket.on('reconnectPlayer', (data, callback) => {
    const { gameId, playerId, name, teamIndex } = data;
    const game = games[gameId];

    if (game && game.players[playerId]) {
      // Spelet finns och spelaren finns - reconnect!
      const player = game.players[playerId];
      
      // Uppdatera socket ID för spelaren
      if (players[playerId]) {
        delete players[playerId];
      }
      players[socket.id] = { gameId, player, lastActivity: Date.now() };
      
      socket.join(gameId);
      io.to(gameId).emit('gameStateUpdate', game.getGameState());
      callback(true);
    } else {
      callback(false);
    }
  });

  socket.on('joinGame', (gameId, playerData, callback) => {
    if (!games[gameId]) {
      callback({ success: false, error: 'Game not found' });
      return;
    }

    const game = games[gameId];
    // Tillåt join både i lobby och playing states
    if (game.state !== 'lobby' && game.state !== 'playing') {
      callback({ success: false, error: 'Game not available' });
      return;
    }

    if (game.teamCounts[playerData.teamIndex] >= 2) {
      callback({ success: false, error: 'Team is full' });
      return;
    }

    const player = new Player(socket.id, playerData.name, playerData.teamIndex, playerData.tankType);
    game.addPlayer(player);
    players[socket.id] = { gameId, player, lastActivity: Date.now() };

    socket.join(gameId);
    io.to(gameId).emit('gameStateUpdate', game.getGameState());
    io.to(gameId).emit('playerJoined', { name: playerData.name, teamIndex: playerData.teamIndex });

    callback({ success: true, playerId: socket.id });
  });

  socket.on('startGame', (gameId, callback) => {
    const game = games[gameId];
    if (game && game.state === 'lobby') {
      game.startGame();
      io.to(gameId).emit('gameStateUpdate', game.getGameState());
      io.to(gameId).emit('gameStarted');
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Cannot start game' });
    }
  });

  socket.on('movePlayer', (direction, gameId) => {
    if (!players[socket.id]) return;
    players[socket.id].lastActivity = Date.now();
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
    players[socket.id].lastActivity = Date.now();
    const { gameId: pGameId, player } = players[socket.id];
    if (pGameId !== gameId) return;
    if (!player.alive || player.isReloading || player.ammo <= 0) return;

    const game = games[gameId];
    if (!game) {
      return;
    }

    const projectile = new Projectile(
      player.x + Math.cos(player.angle) * 40, // Offset framför tanken
      player.y + Math.sin(player.angle) * 40,
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
    players[socket.id].lastActivity = Date.now();
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

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const { gameId, player } = players[socket.id];
      const game = games[gameId];
      if (game) {
        game.removePlayer(socket.id);
        io.to(gameId).emit('gameStateUpdate', game.getGameState());
        
        // Ta bort spelet om det är tomt
        if (Object.keys(game.players).length === 0) {
          delete games[gameId];
          //console.log('Game deleted - no players left:', gameId);
        }
      }
      delete players[socket.id];
    }
  });
});

// Clean up inactive players every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (let playerId in players) {
    const playerData = players[playerId];
    if (playerData && playerData.lastActivity && (now - playerData.lastActivity) > 5000) {
      const { gameId, player } = playerData;
      const game = games[gameId];
      if (game) {
        game.removePlayer(playerId);
        io.to(gameId).emit('gameStateUpdate', game.getGameState());
        
        if (Object.keys(game.players).length === 0) {
          delete games[gameId];
        }
      }
      delete players[playerId];
    }
  }
}, 5000);

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
    
    // Uppdatera lastActivity för alla aktiva spelare i spelet
    for (let playerId in game.players) {
      if (players[playerId]) {
        players[playerId].lastActivity = Date.now();
      }
    }
  }
}, 1000 / 30); // 30 FPS - reducerad för mindre server load

server.listen(PORT, () => {
  //console.log(`Server running on port ${PORT}`);
});
