const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
    socket.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    socket.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    socket.to(to).emit('ice-candidate', { from: socket.id, candidate });
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
