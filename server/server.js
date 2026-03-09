const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');
const content = require('./content');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client')));
console.log('Serving client from:', path.join(__dirname, '../client'));

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

// ── ROOM HELPERS ──────────────────────────────────────────
const rooms = {};
const sqRooms = {};

function getRoomCode(store) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (store[code]);
  return code;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const EMOJIS = ['🎉','🔥','💀','😈','🍺','🎲','⚡','🌶️','💥','🤪','🥳','😏'];

// ══════════════════════════════════════════════════════════
// PARTY GAME ROOMS
// ══════════════════════════════════════════════════════════
function getCard(game) {
  switch(game) {
    case 'nhie':   return { type:'nhie',   data: pick(content.neverHaveIEver) };
    case 'wyr':    return { type:'wyr',    data: pick(content.wouldYouRather) };
    case 'mlt':    return { type:'mlt',    data: pick(content.mostLikelyTo) };
    case 'trivia': return { type:'trivia', data: pick(content.trivia) };
    case 'hot':    return { type:'hot',    data: pick(content.hotTakes) };
    case 'rapid':  return { type:'rapid',  data: pick(content.rapidFire) };
    case 'spin':   return { type:'spin',   data: null };
    default:       return null;
  }
}

io.on('connection', (socket) => {

  // ── PARTY GAME ────────────────────────────────────────
  socket.on('create_room', ({ name, games }) => {
    const code = getRoomCode(rooms);
    rooms[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name, emoji: '👑', score: 0, isHost: true }],
      games: games || ['nhie','wyr','mlt','trivia','hot','rapid','spin'],
      state: 'lobby', currentCard: null, votes: {}, spinResult: null,
    };
    socket.join(code);
    socket.data.room = code; socket.data.name = name; socket.data.type = 'party';
    io.to(code).emit('room_update', rooms[code]);
    socket.emit('joined', { code, playerId: socket.id });
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.length >= 12) { socket.emit('error', 'Room is full'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    const used = room.players.map(p => p.emoji);
    const emoji = EMOJIS.find(e => !used.includes(e)) || '🎮';
    room.players.push({ id: socket.id, name, emoji, score: 0, isHost: false });
    socket.join(code.toUpperCase());
    socket.data.room = code.toUpperCase(); socket.data.name = name; socket.data.type = 'party';
    io.to(code.toUpperCase()).emit('room_update', room);
    socket.emit('joined', { code: code.toUpperCase(), playerId: socket.id });
  });

  socket.on('start_game', () => {
    const code = socket.data.room; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'playing'; nextCard(room);
    io.to(code).emit('room_update', room);
  });

  socket.on('next_card', () => {
    const code = socket.data.room; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.votes = {}; room.spinResult = null; nextCard(room);
    io.to(code).emit('room_update', room);
  });

  socket.on('vote', ({ value }) => {
    const code = socket.data.room; const room = rooms[code];
    if (!room) return;
    room.votes[socket.id] = value;
    io.to(code).emit('votes_update', { votes: room.votes, total: room.players.length, count: Object.keys(room.votes).length });
    if (Object.keys(room.votes).length === room.players.length) revealVotes(room, code);
  });

  socket.on('spin', () => {
    const code = socket.data.room; const room = rooms[code];
    if (!room) return;
    const others = room.players.filter(p => p.id !== socket.id);
    if (!others.length) return;
    room.spinResult = pick(others).name;
    io.to(code).emit('room_update', room);
  });

  socket.on('give_point', ({ targetId }) => {
    const code = socket.data.room; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const player = room.players.find(p => p.id === targetId);
    if (player) player.score++;
    io.to(code).emit('room_update', room);
  });

  // ── SQUID GAME ROOMS ──────────────────────────────────
  socket.on('sq_create', ({ name }) => {
    const code = getRoomCode(sqRooms);
    sqRooms[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name, emoji: '👑', score: 0, isHost: true }],
      state: 'lobby', currentGame: null,
      progress: {}, bridgeStep: 0, bridgeSafe: [],
      marbleCount: {}, towScores: { A: 0, B: 0 }, towInterval: null,
    };
    sqRooms[code].marbleCount[socket.id] = 10;
    socket.join('sq_' + code);
    socket.data.sqRoom = code; socket.data.type = 'squid';
    socket.emit('sq_joined', { code, playerId: socket.id });
    socket.emit('sq_room', sqRooms[code]);
  });

  socket.on('sq_join', ({ name, code }) => {
    const room = sqRooms[code.toUpperCase()];
    if (!room) { socket.emit('sq_error', 'Room not found'); return; }
    if (room.players.length >= 12) { socket.emit('sq_error', 'Room is full'); return; }
    const used = room.players.map(p => p.emoji);
    const emoji = EMOJIS.find(e => !used.includes(e)) || '🦑';
    room.players.push({ id: socket.id, name, emoji, score: 0, isHost: false });
    room.marbleCount[socket.id] = 10;
    socket.join('sq_' + code.toUpperCase());
    socket.data.sqRoom = code.toUpperCase(); socket.data.type = 'squid';
    socket.emit('sq_joined', { code: code.toUpperCase(), playerId: socket.id });
    io.to('sq_' + code.toUpperCase()).emit('sq_room', room);
  });

  socket.on('sq_start_game', ({ game }) => {
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'playing'; room.currentGame = game;
    room.progress = {}; room.votes = {};
    room.players.forEach(p => { room.progress[p.id] = 0; });

    io.to('sq_' + code).emit('sq_room', room);

    if (game === 'rlgl') startRLGL(code, room);
    else if (game === 'tow') startTOW(code, room);
    else if (game === 'bridge') startBridge(code, room);
    else if (game === 'marble') startMarble(code, room);
  });

  // ── RLGL taps ────────────────────────────────────────
  socket.on('sq_tap', ({ game }) => {
    if (game !== 'rlgl') return;
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room || room.rlglIsRed) return;
    room.progress[socket.id] = Math.min(100, (room.progress[socket.id] || 0) + 8);
    io.to('sq_' + code).emit('sq_rlgl_progress', { progress: room.progress, caught: [] });
    if (room.progress[socket.id] >= 100) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) player.score += 3;
      io.to('sq_' + code).emit('sq_room', room);
    }
  });

  // ── Bridge choice ────────────────────────────────────
  socket.on('sq_bridge_choose', ({ side }) => {
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room) return;
    const playerState = room.bridgePlayerState || {};
    const step = playerState[socket.id] || 0;
    if (step >= 8) return;
    const safe = room.bridgeSafe[step] === side;
    if (safe) {
      playerState[socket.id] = step + 1;
      room.bridgePlayerState = playerState;
      socket.emit('sq_bridge_result', { playerId: socket.id, side, safe: true, step: step + 1 });
    } else {
      socket.emit('sq_bridge_result', { playerId: socket.id, side, safe: false, step });
    }
  });

  socket.on('sq_bridge_survived', () => {
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.score += 3;
    io.to('sq_' + code).emit('sq_room', room);
  });

  // ── Tug of War tap ───────────────────────────────────
  socket.on('sq_tow_tap', ({ team }) => {
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room || !room.towRunning) return;
    room.towScores[team] = (room.towScores[team] || 0) + 1;
    io.to('sq_' + code).emit('sq_tow_update', { aScore: room.towScores.A, bScore: room.towScores.B });
  });

  // ── Marble guess ─────────────────────────────────────
  socket.on('sq_marble_guess', ({ guess, bet }) => {
    const code = socket.data.sqRoom; const room = sqRooms[code];
    if (!room) return;
    // Find an opponent
    const others = room.players.filter(p => p.id !== socket.id);
    if (!others.length) return;
    const opp = pick(others);
    const oppCount = room.marbleCount[opp.id] || 10;
    const hidden = Math.max(1, Math.floor(Math.random() * Math.min(oppCount, 5)) + 1);
    const isOdd = hidden % 2 === 1;
    const correct = (guess === 'odd' && isOdd) || (guess === 'even' && !isOdd);
    const myCount = room.marbleCount[socket.id] || 10;

    if (correct) {
      room.marbleCount[socket.id] = myCount + bet;
      room.marbleCount[opp.id] = Math.max(0, oppCount - bet);
    } else {
      room.marbleCount[socket.id] = Math.max(0, myCount - bet);
      room.marbleCount[opp.id] = oppCount + bet;
    }

    socket.emit('sq_marble_result', {
      correct, hidden, isOdd, bet,
      myNewCount: room.marbleCount[socket.id],
      oppNewCount: room.marbleCount[opp.id]
    });

    if (correct) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) player.score++;
    }
    io.to('sq_' + code).emit('sq_room', room);
  });

  // ── DISCONNECT ────────────────────────────────────────
  socket.on('disconnect', () => {
    // Party rooms
    const pcode = socket.data.room;
    if (pcode && rooms[pcode]) {
      const r = rooms[pcode];
      r.players = r.players.filter(p => p.id !== socket.id);
      if (r.players.length === 0) { delete rooms[pcode]; }
      else {
        if (r.host === socket.id) { r.host = r.players[0].id; r.players[0].isHost = true; }
        io.to(pcode).emit('room_update', r);
      }
    }
    // Squid rooms
    const scode = socket.data.sqRoom;
    if (scode && sqRooms[scode]) {
      const r = sqRooms[scode];
      r.players = r.players.filter(p => p.id !== socket.id);
      if (r.players.length === 0) { delete sqRooms[scode]; }
      else {
        if (r.host === socket.id) { r.host = r.players[0].id; r.players[0].isHost = true; }
        io.to('sq_' + scode).emit('sq_room', r);
      }
    }
  });
});

// ── GAME LOGIC ────────────────────────────────────────────
function startRLGL(code, room) {
  const phases = [];
  for (let i = 0; i < 12; i++) {
    phases.push({ phase: 'green', duration: 1500 + Math.random() * 2500 });
    phases.push({ phase: 'red', duration: 1200 + Math.random() * 1500 });
  }

  let idx = 0;
  room.rlglIsRed = false;

  function runPhase() {
    if (idx >= phases.length) return;
    const { phase, duration } = phases[idx++];
    room.rlglIsRed = phase === 'red';
    io.to('sq_' + code).emit('sq_rlgl_phase', { phase });

    if (phase === 'red') {
      const snapshotProgress = { ...room.progress };
      setTimeout(() => {
        const caught = [];
        room.players.forEach(p => {
          if (room.progress[p.id] > (snapshotProgress[p.id] || 0)) caught.push(p.id);
        });
        if (caught.length) {
          io.to('sq_' + code).emit('sq_rlgl_progress', { progress: room.progress, caught });
        }
        runPhase();
      }, duration);
    } else {
      setTimeout(runPhase, duration);
    }
  }

  setTimeout(runPhase, 2000);
}

function startBridge(code, room) {
  room.bridgeSafe = Array.from({length:8}, () => Math.random() < .5 ? 'left' : 'right');
  room.bridgePlayerState = {};
  room.players.forEach(p => { room.bridgePlayerState[p.id] = 0; });
  io.to('sq_' + code).emit('sq_room', room);
}

function startTOW(code, room) {
  room.towScores = { A: 0, B: 0 };
  room.towRunning = false;
  let timeLeft = 10;

  setTimeout(() => {
    room.towRunning = true;
    io.to('sq_' + code).emit('sq_tow_start');
    const ti = setInterval(() => {
      timeLeft--;
      io.to('sq_' + code).emit('sq_tow_timer', { timeLeft });
      if (timeLeft <= 0) {
        clearInterval(ti);
        room.towRunning = false;
        const winner = room.towScores.A >= room.towScores.B ? 'A' : 'B';
        // Give points to winning team
        const mid = Math.floor(room.players.length / 2);
        const winners = winner === 'A' ? room.players.slice(0, mid) : room.players.slice(mid);
        winners.forEach(p => { p.score += 2; });
        io.to('sq_' + code).emit('sq_tow_end', { winner, aScore: room.towScores.A, bScore: room.towScores.B });
        io.to('sq_' + code).emit('sq_room', room);
      }
    }, 1000);
  }, 3000);
}

function startMarble(code, room) {
  room.players.forEach(p => { room.marbleCount[p.id] = 10; });
  io.to('sq_' + code).emit('sq_room', room);
}

// ── PARTY GAME HELPERS ────────────────────────────────────
function nextCard(room) {
  const game = pick(room.games);
  room.currentCard = getCard(game);
  room.votes = {}; room.spinResult = null;
}

function revealVotes(room, code) {
  const card = room.currentCard; if (!card) return;
  if (card.type === 'mlt') {
    const tally = {};
    Object.values(room.votes).forEach(name => { tally[name] = (tally[name]||0)+1; });
    const winner = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
    io.to(code).emit('vote_result', { type:'mlt', tally, winner: winner?.[0] });
    const wp = room.players.find(p => p.name === winner?.[0]);
    if (wp) wp.score++;
    io.to(code).emit('room_update', room);
  } else if (card.type === 'hot') {
    const agree = Object.values(room.votes).filter(v=>v==='agree').length;
    const disagree = Object.values(room.votes).filter(v=>v==='disagree').length;
    io.to(code).emit('vote_result', { type:'hot', agree, disagree, total: room.players.length });
  } else if (card.type === 'trivia') {
    const tally = {};
    Object.values(room.votes).forEach(a => { tally[a] = (tally[a]||0)+1; });
    const correct = card.data.a;
    Object.entries(room.votes).forEach(([pid, answer]) => {
      if (answer === correct) { const p = room.players.find(p=>p.id===pid); if(p) p.score++; }
    });
    io.to(code).emit('vote_result', { type:'trivia', tally, correct, votes: room.votes });
    io.to(code).emit('room_update', room);
  } else if (card.type === 'wyr') {
    const a = Object.values(room.votes).filter(v=>v==='a').length;
    const b = Object.values(room.votes).filter(v=>v==='b').length;
    io.to(code).emit('vote_result', { type:'wyr', a, b, total: room.players.length });
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:3000`;
  const qr = await QRCode.toDataURL(url);
  res.json({ url, qr });
});
app.get('/ip', (req, res) => res.json({ ip: getLocalIP() }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🎉 Party Zone running!\n📱 http://${ip}:${PORT}\n`);
});
 
