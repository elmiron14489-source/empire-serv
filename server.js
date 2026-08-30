const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- GAME CONSTANTS ----------
const COLS = 6, ROWS = 5;
const CONTINENT_BONUS = { A: 3, B: 3, C: 3 };
const PLAYER_COLORS = ['#c9a15a', '#a1453a', '#4a7ba8', '#4a9463', '#8a63a8', '#c97a34'];

function territoryId(c, r) { return c + '_' + r; }
function continentOf(c) { return c < 2 ? 'A' : c < 4 ? 'B' : 'C'; }
function neighborsOf(col, row) {
  const even = [[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[0,1]];
  const odd  = [[1,1],[1,0],[0,-1],[-1,0],[-1,1],[0,1]];
  const deltas = (col % 2 === 0) ? even : odd;
  const out = [];
  for (const [dc, dr] of deltas) {
    const c = col + dc, r = row + dr;
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS) out.push(territoryId(c, r));
  }
  return out;
}
const ADJ = {};
for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) ADJ[territoryId(c, r)] = neighborsOf(c, r);

function roll() { return 1 + Math.floor(Math.random() * 6); }
function rollN(n) { const a = []; for (let i = 0; i < n; i++) a.push(roll()); return a.sort((x, y) => y - x); }
function code(len = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- IN-MEMORY ROOM STORE ----------
// rooms[roomCode] = full game state object
const rooms = {};

function playerById(state, id) { return state.players.find(p => p.id === id); }
function ownedTerritories(state, id) { return Object.entries(state.territories).filter(([, v]) => v.owner === id).map(([k]) => k); }

function calcReinforcements(state, playerId) {
  const owned = ownedTerritories(state, playerId);
  let base = Math.max(3, Math.floor(owned.length / 3));
  for (const key of Object.keys(CONTINENT_BONUS)) {
    const tiles = Object.keys(state.territories).filter(t => state.territories[t].continent === key);
    if (tiles.length && tiles.every(t => state.territories[t].owner === playerId)) base += CONTINENT_BONUS[key];
  }
  return base;
}
function addLog(state, text) {
  state.log = state.log || [];
  state.log.unshift(text);
  if (state.log.length > 60) state.log.length = 60;
}
function checkEliminationsAndWin(state) {
  for (const p of state.players) {
    if (ownedTerritories(state, p.id).length === 0 && state.turnOrder.includes(p.id)) {
      state.turnOrder = state.turnOrder.filter(id => id !== p.id);
      addLog(state, `☠ ${p.name} выбывает из игры.`);
      if (state.currentTurnIndex >= state.turnOrder.length) state.currentTurnIndex = 0;
    }
  }
  if (state.turnOrder.length === 1) {
    state.phase = 'ended';
    state.winner = state.turnOrder[0];
    addLog(state, `👑 ${playerById(state, state.winner).name} побеждает и правит миром!`);
  }
}
function broadcast(roomCode) {
  if (rooms[roomCode]) io.to(roomCode).emit('state', rooms[roomCode]);
}
function isTurn(state, playerId) {
  return state.phase === 'playing' && state.turnOrder[state.currentTurnIndex] === playerId;
}

// ---------- SOCKET HANDLERS ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let myPlayerId = null;

  socket.on('create-room', ({ name, color, playerId }) => {
    const roomCode = code();
    myPlayerId = playerId;
    const state = {
      roomCode, phase: 'lobby',
      players: [{ id: playerId, name, color, host: true }],
      turnOrder: [], currentTurnIndex: 0, turnPhase: null,
      reinforcements: 0, fortifyUsed: false,
      territories: {}, log: [`${name} создал(а) комнату.`]
    };
    rooms[roomCode] = state;
    currentRoom = roomCode;
    socket.join(roomCode);
    socket.emit('joined', { roomCode, playerId });
    broadcast(roomCode);
  });

  socket.on('join-room', ({ code: roomCode, name, color, playerId }) => {
    roomCode = (roomCode || '').trim().toUpperCase();
    const state = rooms[roomCode];
    if (!state) return socket.emit('error-msg', 'Комната не найдена. Проверьте код.');
    if (state.phase !== 'lobby' && !playerById(state, playerId)) {
      return socket.emit('error-msg', 'Игра уже началась в этой комнате.');
    }
    myPlayerId = playerId;
    currentRoom = roomCode;
    socket.join(roomCode);
    if (!playerById(state, playerId)) {
      if (state.players.length >= 6) return socket.emit('error-msg', 'Комната заполнена (макс. 6 игроков).');
      state.players.push({ id: playerId, name, color, host: false });
      addLog(state, `${name} присоединился(-ась) к игре.`);
    }
    socket.emit('joined', { roomCode, playerId });
    broadcast(roomCode);
  });

  socket.on('start-game', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || state.players.length < 2) return;
    const tiles = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) tiles.push(territoryId(c, r));
    for (let i = tiles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tiles[i], tiles[j]] = [tiles[j], tiles[i]]; }
    const players = state.players;
    const territories = {};
    tiles.forEach((tid, i) => {
      const [c] = tid.split('_').map(Number);
      territories[tid] = { owner: players[i % players.length].id, armies: 1, continent: continentOf(c) };
    });
    const pool = 15;
    for (const p of players) {
      const mine = Object.keys(territories).filter(t => territories[t].owner === p.id);
      for (let i = 0; i < pool; i++) territories[mine[Math.floor(Math.random() * mine.length)]].armies++;
    }
    const order = players.map(p => p.id);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    state.territories = territories;
    state.turnOrder = order;
    state.currentTurnIndex = 0;
    state.phase = 'playing';
    state.turnPhase = 'reinforce';
    state.fortifyUsed = false;
    state.reinforcements = calcReinforcements(state, order[0]);
    addLog(state, `🗺 Игра началась! Первый ход: ${playerById(state, order[0]).name}.`);
    broadcast(roomCode);
  });

  socket.on('place-reinforcement', ({ roomCode, tid }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId)) return;
    if (state.turnPhase !== 'reinforce' || state.reinforcements <= 0) return;
    const t = state.territories[tid];
    if (!t || t.owner !== myPlayerId) return;
    t.armies++;
    state.reinforcements--;
    if (state.reinforcements === 0) {
      state.turnPhase = 'attack';
      addLog(state, `${playerById(state, myPlayerId).name} завершил(а) подкрепление, начинается фаза атаки.`);
    }
    broadcast(roomCode);
  });

  socket.on('attack', ({ roomCode, from, to, diceCount }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'attack') return;
    const fromT = state.territories[from], toT = state.territories[to];
    if (!fromT || !toT || fromT.owner !== myPlayerId || toT.owner === myPlayerId) return;
    if (!ADJ[from].includes(to)) return;
    const dCount = Math.min(diceCount, fromT.armies - 1, 3);
    if (dCount < 1) return;
    const defCount = Math.min(2, toT.armies);
    const atkRolls = rollN(dCount), defRolls = rollN(defCount);
    let atkLoss = 0, defLoss = 0;
    for (let i = 0; i < Math.min(atkRolls.length, defRolls.length); i++) {
      if (atkRolls[i] > defRolls[i]) defLoss++; else atkLoss++;
    }
    fromT.armies -= atkLoss;
    toT.armies -= defLoss;
    const attackerName = playerById(state, myPlayerId).name;
    const defenderName = playerById(state, toT.owner).name;
    let text = `⚔ ${attackerName} атакует из [${from}] на [${to}]. 🎲 ${atkRolls.join(',')} vs 🎲 ${defRolls.join(',')} → атакующий -${atkLoss}, защитник -${defLoss}.`;
    if (toT.armies <= 0) {
      toT.owner = myPlayerId;
      toT.armies = dCount;
      fromT.armies -= dCount;
      if (fromT.armies < 1) fromT.armies = 1;
      text += ` 🏳 Территория [${to}] захвачена у ${defenderName}!`;
    }
    addLog(state, text);
    checkEliminationsAndWin(state);
    broadcast(roomCode);
  });

  socket.on('go-to-fortify', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'attack') return;
    state.turnPhase = 'fortify';
    addLog(state, `${playerById(state, myPlayerId).name} переходит к переброске войск.`);
    broadcast(roomCode);
  });

  socket.on('fortify', ({ roomCode, from, to, amount }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'fortify' || state.fortifyUsed) return;
    const fromT = state.territories[from], toT = state.territories[to];
    if (!fromT || !toT || fromT.owner !== myPlayerId || toT.owner !== myPlayerId) return;
    if (!ADJ[from].includes(to)) return;
    const amt = Math.min(amount, fromT.armies - 1);
    if (amt < 1) return;
    fromT.armies -= amt;
    toT.armies += amt;
    state.fortifyUsed = true;
    addLog(state, `🚚 ${playerById(state, myPlayerId).name} перебрасывает ${amt} армий из [${from}] в [${to}].`);
    broadcast(roomCode);
  });

  socket.on('end-turn', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId)) return;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
    state.turnPhase = 'reinforce';
    state.fortifyUsed = false;
    state.reinforcements = calcReinforcements(state, state.turnOrder[state.currentTurnIndex]);
    addLog(state, `➡ Ход переходит к ${playerById(state, state.turnOrder[state.currentTurnIndex]).name}.`);
    broadcast(roomCode);
  });

  socket.on('disconnect', () => {
    // Player stays in the game (their playerId persists client-side in localStorage),
    // so they can simply reload/rejoin the same room code to reconnect.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Empire Conquest server running on port ${PORT}`));
