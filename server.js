const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// TURN credentials endpoint - fetches from Metered.ca
const METERED_API_KEY = process.env.METERED_API_KEY || 'AkJDnFjQ9uvMfBOEurWK4RNboK99LL2Z7Dyqo0rrmSk68HGK';
const METERED_APP_NAME = process.env.METERED_APP_NAME || 'ortachat';

console.log(`[TURN] Config: app=${METERED_APP_NAME}, key=${METERED_API_KEY ? 'SET (' + METERED_API_KEY.substring(0, 6) + '...)' : 'NOT SET'}`);

app.get('/api/ice-servers', async (req, res) => {
  // Always include STUN
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  try {
    const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    console.log(`[TURN] Fetching from: ${url}`);
    const response = await fetch(url);
    const text = await response.text();
    console.log(`[TURN] Response status: ${response.status}, body: ${text.substring(0, 200)}`);
    const turnServers = JSON.parse(text);
    if (Array.isArray(turnServers) && turnServers.length > 0) {
      console.log(`[TURN] Got ${turnServers.length} TURN servers`);
      res.json([...iceServers, ...turnServers]);
    } else {
      console.log(`[TURN] Unexpected response, returning STUN only`);
      res.json(iceServers);
    }
  } catch (e) {
    console.error('[TURN] Failed to fetch Metered credentials:', e.message);
    res.json(iceServers);
  }
});

// Track connected users: socketId -> { username, muted, deafened }
const users = new Map();

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // User joins the room
  socket.on('join', (username) => {
    users.set(socket.id, { username, muted: false, deafened: false });
    socket.join('room');

    // Tell the new user about everyone already in the room
    const existingUsers = [];
    for (const [id, user] of users) {
      if (id !== socket.id) {
        existingUsers.push({ id, ...user });
      }
    }
    socket.emit('existing-users', existingUsers);

    // Tell everyone else about the new user
    socket.to('room').emit('user-joined', {
      id: socket.id,
      username,
      muted: false,
      deafened: false,
    });

    console.log(`${username} joined (${users.size} users online)`);
  });

  // WebRTC signaling
  socket.on('offer', ({ to, offer }) => {
    console.log(`[SIGNAL] offer from ${socket.id} -> ${to} (target exists: ${users.has(to)})`);
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    console.log(`[SIGNAL] answer from ${socket.id} -> ${to}`);
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Mute/deafen state changes
  socket.on('mute-toggle', (muted) => {
    const user = users.get(socket.id);
    if (user) {
      user.muted = muted;
      socket.to('room').emit('user-mute-changed', { id: socket.id, muted });
    }
  });

  socket.on('deafen-toggle', (deafened) => {
    const user = users.get(socket.id);
    if (user) {
      user.deafened = deafened;
      socket.to('room').emit('user-deafen-changed', { id: socket.id, deafened });
    }
  });

  // Remote mute: someone mutes another user
  socket.on('remote-mute', (targetId) => {
    io.to(targetId).emit('force-mute');
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`${user.username} left (${users.size - 1} users online)`);
      users.delete(socket.id);
      socket.to('room').emit('user-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice chat server running on http://localhost:${PORT}`);
});
