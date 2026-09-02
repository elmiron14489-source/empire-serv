const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PLAYER_COLORS = ['#c9a15a', '#a1453a', '#4a7ba8', '#4a9463', '#8a63a8', '#c97a34'];

function roll() { return 1 + Math.floor(Math.random() * 6); }
function rollN(n) { const a = []; for (let i = 0; i < n; i++) a.push(roll()); return a.sort((x, y) => y - x); }
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function code(len = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- REAL-WORLD TERRITORY DATA (loaded once at startup) ----------
// Territories = countries grouped by UN geographic subregion (e.g. "Western
// Europe", "Southern Africa"), so the map has ~20 large zones instead of one
// per country — similar in scale to classic Risk. Adjacency between zones is
// derived from real land borders between their member countries. Continents
// group the zones for classic Risk-style continent-control bonuses.
let WORLD_READY = false;
let TERRITORY_IDS = [];          // e.g. ['northern-america','western-europe', ...]
let TERRITORY_CONTINENT = {};    // tid -> continent key
let TERRITORY_DISPLAY_NAME = {}; // tid -> human-readable name (Russian)
let COUNTRY_TO_TERRITORY = {};   // cca2 -> tid
let NUMERIC_TO_TERRITORY = {};   // ISO 3166-1 numeric code (as Number) -> tid — matches world-atlas topojson feature ids
let ADJ = {};                    // tid -> [tid, ...]
let CONTINENTS = {};             // key -> { name, bonus, tiles: [tid,...] }

const CONTINENT_NAMES = {
  'north-america': 'Северная Америка',
  'south-america': 'Южная Америка',
  'europe': 'Европа',
  'africa': 'Африка',
  'asia': 'Азия',
  'oceania': 'Океания',
};

// UN M49 subregion -> our continent bucket, and -> Russian display name
const SUBREGION_INFO = {
  'Northern America': { continent: 'north-america', name: 'Северная Америка' },
  'Central America': { continent: 'north-america', name: 'Центральная Америка' },
  'Caribbean': { continent: 'north-america', name: 'Карибы' },
  'South America': { continent: 'south-america', name: 'Южная Америка' },
  'Northern Europe': { continent: 'europe', name: 'Северная Европа' },
  'Western Europe': { continent: 'europe', name: 'Западная Европа' },
  'Southern Europe': { continent: 'europe', name: 'Южная Европа' },
  'Eastern Europe': { continent: 'europe', name: 'Восточная Европа' },
  'Northern Africa': { continent: 'africa', name: 'Северная Африка' },
  'Western Africa': { continent: 'africa', name: 'Западная Африка' },
  'Middle Africa': { continent: 'africa', name: 'Центральная Африка' },
  'Eastern Africa': { continent: 'africa', name: 'Восточная Африка' },
  'Southern Africa': { continent: 'africa', name: 'Южная Африка' },
  'Central Asia': { continent: 'asia', name: 'Центральная Азия' },
  'Eastern Asia': { continent: 'asia', name: 'Восточная Азия' },
  'South-Eastern Asia': { continent: 'asia', name: 'Юго-Восточная Азия' },
  'Southern Asia': { continent: 'asia', name: 'Южная Азия' },
  'Western Asia': { continent: 'asia', name: 'Западная Азия' },
  'Australia and New Zealand': { continent: 'oceania', name: 'Австралия и Новая Зеландия' },
  'Melanesia': { continent: 'oceania', name: 'Меланезия' },
  'Micronesia': { continent: 'oceania', name: 'Микронезия' },
  'Polynesia': { continent: 'oceania', name: 'Полинезия' },
};

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

async function loadWorldData() {
  const res = await fetch('https://cdn.jsdelivr.net/gh/mledoze/countries/countries.json');
  const data = await res.json();

  const cca3ToCca2 = {};
  data.forEach(c => { if (c.cca3 && c.cca2) cca3ToCca2[c.cca3] = c.cca2.toLowerCase(); });

  const included = data.filter(c => c.cca2 && c.subregion && SUBREGION_INFO[c.subregion]);

  COUNTRY_TO_TERRITORY = {};
  NUMERIC_TO_TERRITORY = {};
  included.forEach(c => {
    const tid = slugify(c.subregion);
    COUNTRY_TO_TERRITORY[c.cca2.toLowerCase()] = tid;
    if (c.ccn3) NUMERIC_TO_TERRITORY[Number(c.ccn3)] = tid;
  });

  TERRITORY_IDS = [...new Set(Object.values(COUNTRY_TO_TERRITORY))];
  TERRITORY_CONTINENT = {};
  TERRITORY_DISPLAY_NAME = {};
  included.forEach(c => {
    const tid = slugify(c.subregion);
    TERRITORY_CONTINENT[tid] = SUBREGION_INFO[c.subregion].continent;
    TERRITORY_DISPLAY_NAME[tid] = SUBREGION_INFO[c.subregion].name;
  });

  // country-level borders -> territory-level adjacency
  const countryBorders = {};
  included.forEach(c => {
    countryBorders[c.cca2.toLowerCase()] = (c.borders || []).map(b => cca3ToCca2[b]).filter(Boolean);
  });
  const adjSets = {};
  TERRITORY_IDS.forEach(t => { adjSets[t] = new Set(); });
  included.forEach(c => {
    const myTid = COUNTRY_TO_TERRITORY[c.cca2.toLowerCase()];
    (countryBorders[c.cca2.toLowerCase()] || []).forEach(nb => {
      const nbTid = COUNTRY_TO_TERRITORY[nb];
      if (nbTid && nbTid !== myTid) adjSets[myTid].add(nbTid);
    });
  });
  ADJ = {};
  Object.keys(adjSets).forEach(k => { ADJ[k] = [...adjSets[k]]; });

  Object.keys(CONTINENT_NAMES).forEach(key => {
    const tiles = TERRITORY_IDS.filter(t => TERRITORY_CONTINENT[t] === key);
    CONTINENTS[key] = { name: CONTINENT_NAMES[key], tiles, bonus: Math.max(2, Math.round(tiles.length / 2)) };
  });

  WORLD_READY = true;
  console.log(`World data loaded: ${TERRITORY_IDS.length} territories (grouped by subregion) across ${Object.keys(CONTINENTS).length} continents.`);
  io.emit('world-info', { adj: ADJ, numericToTerritory: NUMERIC_TO_TERRITORY, names: TERRITORY_DISPLAY_NAME });
}
loadWorldData().catch(err => console.error('Failed to load world data:', err));

// ---------- IN-MEMORY ROOM STORE ----------
const rooms = {};

function playerById(state, id) { return state.players.find(p => p.id === id); }
function ownedTerritories(state, id) { return Object.entries(state.territories).filter(([, v]) => v.owner === id).map(([k]) => k); }

function calcReinforcements(state, playerId) {
  const owned = ownedTerritories(state, playerId);
  let base = Math.max(3, Math.floor(owned.length / 6));
  for (const key of Object.keys(CONTINENTS)) {
    const tiles = CONTINENTS[key].tiles;
    if (tiles.length && tiles.every(t => state.territories[t] && state.territories[t].owner === playerId)) base += CONTINENTS[key].bonus;
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
function tName(tid) { return TERRITORY_DISPLAY_NAME[tid] || tid; }

function broadcast(roomCode) { if (rooms[roomCode]) io.to(roomCode).emit('state', rooms[roomCode]); }
function isTurn(state, playerId) { return state.phase === 'playing' && state.turnOrder[state.currentTurnIndex] === playerId; }
function currentPlayer(state) { return playerById(state, state.turnOrder[state.currentTurnIndex]); }

// ---------- BOTS ----------
const BOT_NAMES = ['Álvaro', 'Ingrid', 'Chen Wei', 'Fatima', 'Sven', 'Kenji', 'Amara', 'Dmitri'];

function addBot(state) {
  if (state.players.length >= 5) return false;
  const usedColors = new Set(state.players.map(p => p.color));
  const color = PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[state.players.length % PLAYER_COLORS.length];
  const usedNames = new Set(state.players.map(p => p.name));
  const name = 'Бот ' + (BOT_NAMES.find(n => !usedNames.has('Бот ' + n)) || Math.floor(Math.random() * 1000));
  const id = 'bot_' + Math.random().toString(36).slice(2, 10);
  state.players.push({ id, name, color, host: false, isBot: true });
  addLog(state, `🤖 ${name} присоединился(-ась) к игре.`);
  return true;
}

function maybeScheduleBotTurn(roomCode) {
  const state = rooms[roomCode];
  if (!state || state.phase !== 'playing') return;
  const cp = currentPlayer(state);
  if (cp && cp.isBot) setTimeout(() => runBotTurn(roomCode), 900 + Math.random() * 600);
}

function runBotTurn(roomCode) {
  const state = rooms[roomCode];
  if (!state || state.phase !== 'playing') return;
  const bot = currentPlayer(state);
  if (!bot || !bot.isBot) return;
  const botId = bot.id;

  // --- Reinforce: prioritize border territories (touching an enemy) ---
  while (state.reinforcements > 0) {
    const owned = ownedTerritories(state, botId);
    if (owned.length === 0) break;
    const border = owned.filter(t => (ADJ[t] || []).some(n => state.territories[n] && state.territories[n].owner !== botId));
    const pool = border.length ? border : owned;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    state.territories[pick].armies++;
    state.reinforcements--;
  }
  state.turnPhase = 'attack';
  addLog(state, `${bot.name} завершил(а) подкрепление, начинается фаза атаки.`);
  broadcast(roomCode);
  setTimeout(() => botAttackStep(roomCode, botId, 20), 800 + Math.random() * 400);
}

function botAttackStep(roomCode, botId, attacksLeft) {
  const st = rooms[roomCode];
  if (!st || st.phase !== 'playing' || st.turnOrder[st.currentTurnIndex] !== botId) return;
  const bot = playerById(st, botId);

  let best = null;
  for (const from of ownedTerritories(st, botId)) {
    const fromT = st.territories[from];
    if (fromT.armies < 2) continue;
    for (const to of (ADJ[from] || [])) {
      const toT = st.territories[to];
      if (!toT || toT.owner === botId) continue;
      const advantage = fromT.armies - toT.armies;
      if (advantage >= 2 || (fromT.armies >= 3 && fromT.armies > toT.armies)) {
        if (!best || advantage > best.advantage) best = { from, to, advantage };
      }
    }
  }

  if (!best || attacksLeft <= 0 || Math.random() < 0.12) {
    st.turnPhase = 'fortify';
    broadcast(roomCode);
    setTimeout(() => botFortifyAndEnd(roomCode, botId), 700 + Math.random() * 500);
    return;
  }

  const fromT = st.territories[best.from], toT = st.territories[best.to];
  const dCount = Math.min(3, fromT.armies - 1);
  const defCount = Math.min(2, toT.armies);
  const atkRolls = rollN(dCount), defRolls = rollN(defCount);
  let atkLoss = 0, defLoss = 0;
  for (let i = 0; i < Math.min(atkRolls.length, defRolls.length); i++) {
    if (atkRolls[i] > defRolls[i]) defLoss++; else atkLoss++;
  }
  fromT.armies -= atkLoss;
  toT.armies -= defLoss;
  const defenderName = playerById(st, toT.owner).name;
  let text = `⚔ ${bot.name} атакует из [${tName(best.from)}] на [${tName(best.to)}]. 🎲 ${atkRolls.join(',')} vs 🎲 ${defRolls.join(',')} → атакующий -${atkLoss}, защитник -${defLoss}.`;
  if (toT.armies <= 0) {
    toT.owner = botId;
    toT.armies = dCount;
    fromT.armies -= dCount;
    if (fromT.armies < 1) fromT.armies = 1;
    text += ` 🏳 Территория [${tName(best.to)}] захвачена у ${defenderName}!`;
  }
  addLog(st, text);
  checkEliminationsAndWin(st);
  broadcast(roomCode);
  if (st.phase === 'ended') return;
  setTimeout(() => botAttackStep(roomCode, botId, attacksLeft - 1), 900 + Math.random() * 500);
}

function botFortifyAndEnd(roomCode, botId) {
  const st = rooms[roomCode];
  if (!st || st.phase !== 'playing' || st.turnOrder[st.currentTurnIndex] !== botId) return;
  const owned = ownedTerritories(st, botId);
  const interior = owned.filter(t => (ADJ[t] || []).every(n => st.territories[n] && st.territories[n].owner === botId) && st.territories[t].armies > 3);
  const border = owned.filter(t => (ADJ[t] || []).some(n => st.territories[n] && st.territories[n].owner !== botId));
  if (interior.length && border.length && !st.fortifyUsed) {
    const from = interior[Math.floor(Math.random() * interior.length)];
    const candidates = (ADJ[from] || []).filter(n => border.includes(n));
    if (candidates.length) {
      const to = candidates[Math.floor(Math.random() * candidates.length)];
      const amt = Math.max(1, Math.floor((st.territories[from].armies - 1) / 2));
      st.territories[from].armies -= amt;
      st.territories[to].armies += amt;
      st.fortifyUsed = true;
      addLog(st, `🚚 ${playerById(st, botId).name} перебрасывает ${amt} армий из [${tName(from)}] в [${tName(to)}].`);
    }
  }
  broadcast(roomCode);
  setTimeout(() => botEndTurn(roomCode, botId), 600 + Math.random() * 400);
}

function botEndTurn(roomCode, botId) {
  const st = rooms[roomCode];
  if (!st || st.phase !== 'playing' || st.turnOrder[st.currentTurnIndex] !== botId) return;
  st.currentTurnIndex = (st.currentTurnIndex + 1) % st.turnOrder.length;
  st.turnPhase = 'reinforce';
  st.fortifyUsed = false;
  st.reinforcements = calcReinforcements(st, st.turnOrder[st.currentTurnIndex]);
  addLog(st, `➡ Ход переходит к ${playerById(st, st.turnOrder[st.currentTurnIndex]).name}.`);
  broadcast(roomCode);
  maybeScheduleBotTurn(roomCode);
}

// ---------- SOCKET HANDLERS ----------
io.on('connection', (socket) => {
  let myPlayerId = null;
  if (WORLD_READY) socket.emit('world-info', { adj: ADJ, numericToTerritory: NUMERIC_TO_TERRITORY, names: TERRITORY_DISPLAY_NAME });

  socket.on('create-room', ({ name, color, playerId }) => {
    const roomCode = code();
    myPlayerId = playerId;
    const state = {
      roomCode, phase: 'lobby',
      players: [{ id: playerId, name, color, host: true }],
      turnOrder: [], currentTurnIndex: 0, turnPhase: null,
      reinforcements: 0, fortifyUsed: false, pendingCapture: null,
      territories: {}, log: [`${name} создал(а) комнату.`]
    };
    rooms[roomCode] = state;
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
    socket.join(roomCode);
    if (!playerById(state, playerId)) {
      if (state.players.length >= 5) return socket.emit('error-msg', 'Комната заполнена (нужно ровно 5 игроков).');
      state.players.push({ id: playerId, name, color, host: false });
      addLog(state, `${name} присоединился(-ась) к игре.`);
    }
    socket.emit('joined', { roomCode, playerId });
    broadcast(roomCode);
  });

  socket.on('add-bot', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || state.phase !== 'lobby') return;
    const me = playerById(state, myPlayerId);
    if (!me || !me.host) return;
    if (addBot(state)) broadcast(roomCode);
  });

  socket.on('fill-bots', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || state.phase !== 'lobby') return;
    const me = playerById(state, myPlayerId);
    if (!me || !me.host) return;
    let added = false;
    while (state.players.length < 5) { if (!addBot(state)) break; added = true; }
    if (added) broadcast(roomCode);
  });

  socket.on('remove-bot', ({ roomCode, botId }) => {
    const state = rooms[roomCode];
    if (!state || state.phase !== 'lobby') return;
    const me = playerById(state, myPlayerId);
    if (!me || !me.host) return;
    const target = playerById(state, botId);
    if (!target || !target.isBot) return;
    state.players = state.players.filter(p => p.id !== botId);
    addLog(state, `${target.name} удалён(а) из комнаты.`);
    broadcast(roomCode);
  });

  socket.on('start-game', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || state.players.length !== 5) return;
    if (!WORLD_READY) return socket.emit('error-msg', 'Карта мира ещё загружается, попробуйте через пару секунд.');
    const tiles = shuffle([...TERRITORY_IDS]);
    const players = state.players;
    const territories = {};
    tiles.forEach((tid, i) => {
      territories[tid] = { owner: players[i % players.length].id, armies: 1, continent: TERRITORY_CONTINENT[tid] };
    });
    const pool = 15;
    for (const p of players) {
      const mine = Object.keys(territories).filter(t => territories[t].owner === p.id);
      for (let i = 0; i < pool; i++) territories[mine[Math.floor(Math.random() * mine.length)]].armies++;
    }
    const order = shuffle(players.map(p => p.id));
    state.territories = territories;
    state.turnOrder = order;
    state.currentTurnIndex = 0;
    state.phase = 'playing';
    state.turnPhase = 'reinforce';
    state.fortifyUsed = false;
    state.reinforcements = calcReinforcements(state, order[0]);
    addLog(state, `🗺 Игра началась! Первый ход: ${playerById(state, order[0]).name}.`);
    broadcast(roomCode);
    maybeScheduleBotTurn(roomCode);
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
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'attack' || state.pendingCapture) return;
    const fromT = state.territories[from], toT = state.territories[to];
    if (!fromT || !toT || fromT.owner !== myPlayerId || toT.owner === myPlayerId) return;
    if (!ADJ[from] || !ADJ[from].includes(to)) return;
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
    let text = `⚔ ${attackerName} атакует из [${tName(from)}] на [${tName(to)}]. 🎲 ${atkRolls.join(',')} vs 🎲 ${defRolls.join(',')} → атакующий -${atkLoss}, защитник -${defLoss}.`;
    if (toT.armies <= 0) {
      toT.owner = myPlayerId;
      toT.armies = dCount; // minimum required transfer (Risk rule: at least the dice used)
      fromT.armies -= dCount;
      if (fromT.armies < 1) fromT.armies = 1;
      text += ` 🏳 Территория [${tName(to)}] захвачена у ${defenderName}!`;
      const maxExtra = Math.max(0, fromT.armies - 1); // can move more, but must leave ≥1 behind
      if (maxExtra > 0) state.pendingCapture = { from, to, maxExtra };
    }
    addLog(state, text);
    checkEliminationsAndWin(state);
    broadcast(roomCode);
  });

  socket.on('confirm-capture', ({ roomCode, amount }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || !state.pendingCapture) return;
    const { from, to, maxExtra } = state.pendingCapture;
    const amt = Math.max(0, Math.min(Number(amount) || 0, maxExtra));
    const fromT = state.territories[from], toT = state.territories[to];
    if (fromT && toT) {
      fromT.armies -= amt;
      toT.armies += amt;
      addLog(state, amt > 0
        ? `➕ ${playerById(state, myPlayerId).name} перебрасывает ещё ${amt} армий в [${tName(to)}].`
        : `${playerById(state, myPlayerId).name} оставляет гарнизон [${tName(from)}] без изменений.`);
    }
    state.pendingCapture = null;
    broadcast(roomCode);
  });

  socket.on('go-to-fortify', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'attack' || state.pendingCapture) return;
    state.turnPhase = 'fortify';
    addLog(state, `${playerById(state, myPlayerId).name} переходит к переброске войск.`);
    broadcast(roomCode);
  });

  socket.on('fortify', ({ roomCode, from, to, amount }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.turnPhase !== 'fortify' || state.fortifyUsed) return;
    const fromT = state.territories[from], toT = state.territories[to];
    if (!fromT || !toT || fromT.owner !== myPlayerId || toT.owner !== myPlayerId) return;
    if (!ADJ[from] || !ADJ[from].includes(to)) return;
    const amt = Math.min(amount, fromT.armies - 1);
    if (amt < 1) return;
    fromT.armies -= amt;
    toT.armies += amt;
    state.fortifyUsed = true;
    addLog(state, `🚚 ${playerById(state, myPlayerId).name} перебрасывает ${amt} армий из [${tName(from)}] в [${tName(to)}].`);
    broadcast(roomCode);
  });

  socket.on('end-turn', ({ roomCode }) => {
    const state = rooms[roomCode];
    if (!state || !isTurn(state, myPlayerId) || state.pendingCapture) return;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
    state.turnPhase = 'reinforce';
    state.fortifyUsed = false;
    state.reinforcements = calcReinforcements(state, state.turnOrder[state.currentTurnIndex]);
    addLog(state, `➡ Ход переходит к ${playerById(state, state.turnOrder[state.currentTurnIndex]).name}.`);
    broadcast(roomCode);
    maybeScheduleBotTurn(roomCode);
  });

  socket.on('disconnect', () => {
    // playerId persists client-side (localStorage), so reloading/rejoining the
    // same room reconnects them to the same player automatically.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Empire Conquest server running on port ${PORT}`));
