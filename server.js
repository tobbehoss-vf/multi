const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Classes
class Player {
  constructor(id, name, teamIndex, tankType) {
    this.id = id;
    this.name = name;
    this.teamIndex = teamIndex;
    this.tankType = tankType;
    this.x = 700;
    this.y = 300;
    this.angle = 0;
    this.maxHp = 100;
    this.hp = 100;
    this.lives = 5;
    this.kills = 0;
    this.deaths = 0;
    this.maxAmmo = 10;
    this.ammo = 10;
    this.alive = true;
    this.isReloading = false;
    this.reloadStartTime = 0;
    this.reloadTime = 1000;
    this.deathTime = null;
    
    // NEW: Spawn shield & momentum
    this.spawnShield = 3; // 3 seconds of invulnerability
    this.spawnTime = Date.now();
    this.velocityX = 0;
    this.velocityY = 0;
    this.acceleration = 0.8;
    this.friction = 0.85;
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
    this.lifetime = 2000;
    this.age = 0;
  }
}

// NEW: Power-up class
class PowerUp {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type; // 'health', 'ammo', 'speed'
    this.radius = 15;
    this.respawnTime = 10000; // 10 seconds
    this.pickedUpTime = null;
  }

  respawn() {
    this.pickedUpTime = null;
  }

  isActive() {
    if (!this.pickedUpTime) return true;
    return Date.now() - this.pickedUpTime > this.respawnTime;
  }
}

class Game {
  constructor(gameId, mapId) {
    this.gameId = gameId;
    this.mapId = mapId || 0;
    this.players = {};
    this.projectiles = [];
    this.powerUps = [];
    this.state = 'lobby';
    this.teamCounts = [0, 0, 0, 0];
    this.scores = [0, 0, 0, 0];
    this.gameStartTime = null;
    this.mapIndex = mapId || 0;
    this.hitThisFrame = false;
    this.collisionThisFrame = false;
    this.wallCollisionThisFrame = false;
    
    // NEW: Win condition
    this.winTarget = 10; // First to 10 kills
    this.gameEndTime = null;
    this.winner = null;
    
    this.generateRandomObstacles();
    this.generatePowerUps();
  }

  generateRandomObstacles() {
    this.obstacles = [];
    
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

  // NEW: Generate power-ups
  generatePowerUps() {
    this.powerUps = [];
    const types = ['health', 'ammo', 'speed'];
    
    for (let i = 0; i < 6; i++) {
      let x, y, valid = false;
      for (let attempts = 0; attempts < 20; attempts++) {
        x = Math.random() * 1300 + 50;
        y = Math.random() * 500 + 50;
        if (!this.isColliding(x, y, 20)) {
          valid = true;
          break;
        }
      }
      if (valid) {
        this.powerUps.push(new PowerUp(x, y, types[i % 3]));
      }
    }
  }

  addPlayer(player) {
    this.players[player.id] = player;
    this.teamCounts[player.teamIndex]++;
    
    const spawn = this.getRandomSpawnPoint();
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = spawn.angle || 0;
    player.hp = player.maxHp;
    player.alive = true;
    player.spawnTime = Date.now();
    player.spawnShield = 3;
  }

  removePlayer(playerId) {
    const player = this.players[playerId];
    if (player) {
      this.teamCounts[player.teamIndex]--;
      delete this.players[playerId];
    }
  }

  isColliding(x, y, radius = 12) {
    for (let obstacle of this.obstacles) {
      if (x + radius > obstacle.x && x - radius < obstacle.x + obstacle.w &&
          y + radius > obstacle.y && y - radius < obstacle.y + obstacle.h) {
        return true;
      }
    }
    return false;
  }

  projectileHitObstacle(x, y, vx, vy, prevX, prevY) {
    for (let obs of this.obstacles) {
      if (x >= obs.x && x <= obs.x + obs.w &&
          y >= obs.y && y <= obs.y + obs.h) {
        return true;
      }
      
      if (prevX >= obs.x && prevX <= obs.x + obs.w &&
          prevY >= obs.y && prevY <= obs.y + obs.h) {
        return true;
      }
      
      const minX = Math.min(prevX, x) - 1;
      const maxX = Math.max(prevX, x) + 1;
      const minY = Math.min(prevY, y) - 1;
      const maxY = Math.max(prevY, y) + 1;
      
      if (minX <= obs.x + obs.w && maxX >= obs.x &&
          minY <= obs.y + obs.h && maxY >= obs.y) {
        return true;
      }
    }
    return false;
  }

  damageWall(projX, projY) {
    for (let obstacle of this.obstacles) {
      if (projX >= obstacle.x && projX <= obstacle.x + obstacle.w &&
          projY >= obstacle.y && projY <= obstacle.y + obstacle.h) {
        
        if (obstacle.w > obstacle.h) {
          obstacle.h -= 5;
          if (obstacle.h <= 0) {
            this.obstacles = this.obstacles.filter(o => o !== obstacle);
          }
        } else {
          obstacle.w -= 5;
          if (obstacle.w <= 0) {
            this.obstacles = this.obstacles.filter(o => o !== obstacle);
          }
        }
        return true;
      }
    }
    return false;
  }

  getRandomSpawnPoint() {
    let attempts = 0;
    let x, y;
    
    while (attempts < 50) {
      x = Math.random() * (1400 - 100) + 50;
      y = Math.random() * (600 - 100) + 50;
      
      if (!this.isColliding(x, y)) {
        return { x, y, angle: 0 };
      }
      attempts++;
    }
    
    return { x: 100, y: 100, angle: 0 };
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
      player.spawnTime = Date.now();
      player.spawnShield = 3;
    }
  }

  update() {
    if (this.state !== 'playing') {
      return;
    }

    // Update power-ups
    this.powerUps.forEach(powerUp => {
      if (!powerUp.isActive()) return;
      
      for (let playerId in this.players) {
        const player = this.players[playerId];
        if (!player.alive) continue;
        
        const dx = player.x - powerUp.x;
        const dy = player.y - powerUp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 30) {
          if (powerUp.type === 'health') {
            player.hp = Math.min(player.hp + 40, player.maxHp);
          } else if (powerUp.type === 'ammo') {
            player.ammo = Math.min(player.ammo + 5, player.maxAmmo);
          } else if (powerUp.type === 'speed') {
            player.speedBoost = 1.5;
            setTimeout(() => { player.speedBoost = 1; }, 5000);
          }
          powerUp.pickedUpTime = Date.now();
        }
      }
    });

    const projectilesToKeep = [];
    
    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      
      const prevX = proj.x;
      const prevY = proj.y;
      
      proj.x += proj.vx;
      proj.y += proj.vy;
      proj.age++;

      if (proj.x < 0 || proj.x > 1400 || proj.y < 0 || proj.y > 600 || proj.age >= proj.lifetime) {
        continue;
      }

      if (this.projectileHitObstacle(proj.x, proj.y, proj.vx, proj.vy, prevX, prevY)) {
        this.damageWall(proj.x, proj.y);
        continue;
      }

      let hit = false;
      for (let playerId in this.players) {
        const target = this.players[playerId];
        if (target.id === proj.playerId || !target.alive) continue;
        
        if (target.teamIndex === proj.teamIndex) continue;
        
        // NEW: Skip if target has spawn shield
        if (Date.now() - target.spawnTime < target.spawnShield * 1000) continue;

        const dx = target.x - proj.x;
        const dy = target.y - proj.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < 900) {
          target.hp -= proj.damage;
          this.hitThisFrame = true;
          
          if (target.hp <= 0) {
            target.hp = 0;
            target.alive = false;
            target.deaths++;

            const shooter = this.players[proj.playerId];
            if (shooter) {
              shooter.kills++;
              this.scores[proj.teamIndex] += 1;
              
              // Check win condition
              if (shooter.kills >= this.winTarget && !this.winner) {
                this.winner = proj.teamIndex;
                this.gameEndTime = Date.now();
              }
            }
          }

          hit = true;
          break;
        }
      }

      if (!hit) {
        projectilesToKeep.push(proj);
      }
    }

    this.projectiles = projectilesToKeep;

    // Respawn dead players
    for (let playerId in this.players) {
      const player = this.players[playerId];
      if (!player.alive && player.lives > 0) {
        if (!player.deathTime) {
          player.deathTime = Date.now();
        }
        
        if (Date.now() - player.deathTime > 2000) {
          player.lives--;
          if (player.lives >= 0) {
            const spawn = this.getRandomSpawnPoint();
            player.x = spawn.x;
            player.y = spawn.y;
            player.hp = player.maxHp;
            player.alive = true;
            player.deathTime = null;
            player.spawnTime = Date.now();
            player.spawnShield = 3;
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
        tankType: p.tankType,
        hasSpawnShield: Date.now() - p.spawnTime < p.spawnShield * 1000
      })),
      projectiles: this.projectiles.map(p => ({
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy
      })),
      scores: this.scores,
      mapIndex: this.mapIndex,
      obstacles: this.obstacles,
      powerUps: this.powerUps.map(pu => ({
        x: pu.x,
        y: pu.y,
        type: pu.type,
        active: pu.isActive()
      })),
      winner: this.winner,
      gameEndTime: this.gameEndTime
    };
  }
}

const games = {};
const players = {};

io.on('connection', (socket) => {
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
      const player = game.players[playerId];
      
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
    if (game.state !== 'lobby' && game.state !== 'playing') {
      callback({ success: false, error: 'Game not available' });
      return;
    }

    if (game.teamCounts[playerData.teamIndex] >= 3) {
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
    const speedMultiplier = player.speedBoost || 1;
    const cos = Math.cos(player.angle);
    const sin = Math.sin(player.angle);
    let newX = player.x;
    let newY = player.y;

    if (direction === 'forward') {
      player.velocityX = cos * speed * speedMultiplier;
      player.velocityY = sin * speed * speedMultiplier;
    } else if (direction === 'backward') {
      player.velocityX = -cos * speed * speedMultiplier;
      player.velocityY = -sin * speed * speedMultiplier;
    } else if (direction === 'left') {
      player.angle -= 0.08;
    } else if (direction === 'right') {
      player.angle += 0.08;
    }

    newX += player.velocityX;
    newY += player.velocityY;

    player.velocityX *= player.friction;
    player.velocityY *= player.friction;

    let wallCollided = false;
    
    if (!game.isColliding(newX, newY)) {
      player.x = newX;
      player.y = newY;
    } else {
      wallCollided = true;
      if (!game.isColliding(newX, player.y)) {
        player.x = newX;
        wallCollided = false;
      }
      else if (!game.isColliding(player.x, newY)) {
        player.y = newY;
        wallCollided = false;
      }
    }

    // Tank-to-tank collisions
    for (let otherId in game.players) {
      if (otherId === player.id) continue;
      const other = game.players[otherId];
      if (!other.alive) continue;
      
      const dx = other.x - player.x;
      const dy = other.y - player.y;
      const distSq = dx * dx + dy * dy;
      
      if (distSq < 1024) {
        player.hp -= 3;
        other.hp -= 3;
        
        if (player.hp < 0) player.hp = 0;
        if (other.hp < 0) other.hp = 0;
        
        if (player.hp === 0) {
          player.alive = false;
          player.deaths++;
        }
        if (other.hp === 0) {
          other.alive = false;
          other.deaths++;
        }
        
        game.collisionThisFrame = true;
        
        const angle = Math.atan2(dy, dx);
        const pushDist = 5;
        player.x -= Math.cos(angle) * pushDist;
        player.y -= Math.sin(angle) * pushDist;
        other.x += Math.cos(angle) * pushDist;
        other.y += Math.sin(angle) * pushDist;
      }
    }

    if (wallCollided && player.alive) {
      player.hp -= 1;
      if (player.hp <= 0) {
        player.hp = 0;
        player.alive = false;
        player.deaths++;
      }
      game.wallCollisionThisFrame = true;
    }

    player.x = Math.max(45, Math.min(1355, player.x));
    player.y = Math.max(45, Math.min(555, player.y));
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
      player.x + Math.cos(player.angle) * 40,
      player.y + Math.sin(player.angle) * 40,
      player.angle,
      player.id,
      player.name,
      player.teamIndex
    );
    game.projectiles.push(projectile);
    player.ammo--;

    socket.emit('shotFired');

    if (player.ammo === 0) {
      player.isReloading = true;
      player.reloadStartTime = Date.now();
      player.reloadTime = 1000;
    }
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
        
        if (Object.keys(game.players).length === 0) {
          delete games[gameId];
        }
      }
      delete players[socket.id];
    }
  });
});

// Cleanup inactive players
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
    game.update();
    
    if (game.hitThisFrame) {
      io.to(gameId).emit('hitEvent');
      game.hitThisFrame = false;
    }
    
    if (game.collisionThisFrame) {
      io.to(gameId).emit('collisionEvent');
      game.collisionThisFrame = false;
    }
    
    if (game.wallCollisionThisFrame) {
      io.to(gameId).emit('wallCollisionEvent');
      game.wallCollisionThisFrame = false;
    }
    
    const state = game.getGameState();
    io.to(gameId).emit('gameStateUpdate', state);
    
    for (let playerId in game.players) {
      if (players[playerId]) {
        players[playerId].lastActivity = Date.now();
      }
    }
  }
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`🎮 Tank Battle server running on port ${PORT}`);
});
