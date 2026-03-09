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

// ── Get local IP ──────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Room state ────────────────────────────────────────────
const rooms = {};

function getRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getCard(game) {
  switch(game) {
    case 'nhie':    return { type:'nhie',    data: pick(content.neverHaveIEver) };
    case 'wyr':     return { type:'wyr',     data: pick(content.wouldYouRather) };
    case 'mlt':     return { type:'mlt',     data: pick(content.mostLikelyTo) };
    case 'trivia':  return { type:'trivia',  data: pick(content.trivia) };
    case 'hot':     return { type:'hot',     data: pick(content.hotTakes) };
    case 'rapid':   return { type:'rapid',   data: pick(content.rapidFire) };
    case 'spin':    return { type:'spin',    data: null };
    default:        return null;
  }
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('create_room', ({ name, games }) => {
    const code = getRoomCode();
    rooms[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name, emoji: '👑', score: 0, isHost: true }],
      games: games || ['nhie','wyr','mlt','trivia','hot','rapid','spin'],
      state: 'lobby',
      currentCard: null,
      votes: {},
      spinResult: null,
    };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    io.to(code).emit('room_update', rooms[code]);
    socket.emit('joined', { code, playerId: socket.id });
  });

  // Join room
  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.length >= 12) { socket.emit('error', 'Room is full (12 max)'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }

    const emojis = ['🎉','🔥','💀','😈','🍺','🎲','⚡','🌶️','💥','🤪','🥳','😏'];
    const used = room.players.map(p => p.emoji);
    const emoji = emojis.find(e => !used.includes(e)) || '🎮';

    room.players.push({ id: socket.id, name, emoji, score: 0, isHost: false });
    socket.join(code.toUpperCase());
    socket.data.room = code.toUpperCase();
    socket.data.name = name;
    io.to(code.toUpperCase()).emit('room_update', room);
    socket.emit('joined', { code: code.toUpperCase(), playerId: socket.id });
  });

  // Start game
  socket.on('start_game', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = 'playing';
    nextCard(room);
    io.to(code).emit('room_update', room);
  });

  // Next card
  socket.on('next_card', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.votes = {};
    room.spinResult = null;
    nextCard(room);
    io.to(code).emit('room_update', room);
  });

  // Vote (Most Likely To, Hot Takes, Trivia)
  socket.on('vote', ({ value }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    room.votes[socket.id] = value;
    io.to(code).emit('votes_update', {
      votes: room.votes,
      total: room.players.length,
      count: Object.keys(room.votes).length
    });
    // Auto-reveal when all voted
    if (Object.keys(room.votes).length === room.players.length) {
      revealVotes(room, code);
    }
  });

  // Spin
  socket.on('spin', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const players = room.players.filter(p => p.id !== socket.id);
    if (players.length === 0) return;
    room.spinResult = pick(players).name;
    io.to(code).emit('room_update', room);
  });

  // Give point
  socket.on('give_point', ({ targetId }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const player = room.players.find(p => p.id === targetId);
    if (player) player.score++;
    io.to(code).emit('room_update', room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[code]; return; }
    if (room.host === socket.id) {
      room.host = room.players[0].id;
      room.players[0].isHost = true;
    }
    io.to(code).emit('room_update', room);
  });
});

function nextCard(room) {
  const game = pick(room.games);
  room.currentCard = getCard(game);
  room.votes = {};
  room.spinResult = null;
}

function revealVotes(room, code) {
  const card = room.currentCard;
  if (!card) return;

  if (card.type === 'mlt') {
    // tally votes by player name
    const tally = {};
    Object.values(room.votes).forEach(name => { tally[name] = (tally[name]||0)+1; });
    const winner = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
    io.to(code).emit('vote_result', { type:'mlt', tally, winner: winner?.[0] });
    // give winner a point
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
      if (answer === correct) {
        const player = room.players.find(p => p.id === pid);
        if (player) player.score++;
      }
    });
    io.to(code).emit('vote_result', { type:'trivia', tally, correct, votes: room.votes });
    io.to(code).emit('room_update', room);
  } else if (card.type === 'wyr') {
    const a = Object.values(room.votes).filter(v=>v==='a').length;
    const b = Object.values(room.votes).filter(v=>v==='b').length;
    io.to(code).emit('vote_result', { type:'wyr', a, b, total: room.players.length });
  }
}

// QR code endpoint
app.get('/qr', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:3000`;
  const qr = await QRCode.toDataURL(url);
  res.json({ url, qr });
});

app.get('/ip', (req, res) => {
  res.json({ ip: getLocalIP() });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🎉 Party Game Server running!`);
  console.log(`\n📱 Share this with your friends:`);
  console.log(`   http://${ip}:${PORT}\n`);
});
