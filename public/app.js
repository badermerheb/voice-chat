const socket = io();

// State
let localStream = null;
let audioContext = null;
let myUsername = '';
let isMuted = false;
let isDeafened = false;

// Map of peerId -> { pc, gainNode, audioElement, username }
const peers = new Map();

// ICE servers (STUN + free TURN fallback for symmetric NAT)
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// ─── DOM Elements ───
const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const usersList = document.getElementById('users-list');
const userCount = document.getElementById('user-count');
const muteBtn = document.getElementById('mute-btn');
const deafenBtn = document.getElementById('deafen-btn');
const leaveBtn = document.getElementById('leave-btn');

// ─── Join ───
joinBtn.addEventListener('click', join);
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

async function join() {
  const name = usernameInput.value.trim();
  if (!name) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    alert('Microphone access is required. Please allow it and try again.');
    return;
  }

  audioContext = new AudioContext();
  myUsername = name;

  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');

  socket.emit('join', name);
}

// ─── Socket Events ───

// Existing users already in the room
socket.on('existing-users', (users) => {
  users.forEach((user) => {
    addUserToUI(user.id, user.username, user.muted, user.deafened);
    createPeerConnection(user.id, true); // We are the offerer
  });
  updateUserCount();
});

// New user joins
socket.on('user-joined', (user) => {
  addUserToUI(user.id, user.username, user.muted, user.deafened);
  createPeerConnection(user.id, false); // They will send us an offer
  updateUserCount();
});

// User leaves
socket.on('user-left', (peerId) => {
  removePeer(peerId);
  updateUserCount();
});

// WebRTC signaling
socket.on('offer', async ({ from, offer }) => {
  const peer = peers.get(from);
  if (!peer) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

socket.on('answer', async ({ from, answer }) => {
  const peer = peers.get(from);
  if (!peer) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    // Ignore ICE errors silently
  }
});

// Remote state changes
socket.on('user-mute-changed', ({ id, muted }) => {
  const card = document.querySelector(`.user-card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('is-muted', muted);
    card.querySelector('.user-status').textContent = muted ? 'Muted' : '';
  }
});

socket.on('user-deafen-changed', ({ id, deafened }) => {
  const card = document.querySelector(`.user-card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('is-deafened', deafened);
    const status = card.querySelector('.user-status');
    status.textContent = deafened ? 'Deafened' : '';
  }
});

// Someone force-muted us
socket.on('force-mute', () => {
  if (!isMuted) {
    toggleMute();
  }
});

// ─── WebRTC ───

function createPeerConnection(peerId, isOfferer) {
  const pc = new RTCPeerConnection(iceConfig);

  // Add our audio track
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Handle incoming audio
  pc.ontrack = (event) => {
    const remoteStream = event.streams[0];
    if (!remoteStream) return;

    // Resume audio context if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    // Use Web Audio API for per-user volume control
    // Route: source → gainNode → destinationNode → <audio> element
    const source = audioContext.createMediaStreamSource(remoteStream);
    const gainNode = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    gainNode.gain.value = isDeafened ? 0 : 1;
    source.connect(gainNode);
    gainNode.connect(destination);

    // Create an <audio> element to actually play the sound
    const audioEl = document.createElement('audio');
    audioEl.srcObject = destination.stream;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {});

    const peer = peers.get(peerId);
    if (peer) {
      peer.gainNode = gainNode;
      peer.source = source;
      peer.audioEl = audioEl;
    }
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: peerId, candidate: event.candidate });
    }
  };

  // Create offer if we're the initiator
  if (isOfferer) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer });
      } catch (e) {
        console.error('Error creating offer:', e);
      }
    };
  }

  // Store peer
  const existing = peers.get(peerId);
  peers.set(peerId, {
    pc,
    gainNode: existing?.gainNode || null,
    source: existing?.source || null,
    username: existing?.username || '',
  });

  return pc;
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.pc.close();
    if (peer.source) peer.source.disconnect();
    if (peer.gainNode) peer.gainNode.disconnect();
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    peers.delete(peerId);
  }
  const card = document.querySelector(`.user-card[data-id="${peerId}"]`);
  if (card) card.remove();
}

// ─── UI ───

function addUserToUI(id, username, muted, deafened) {
  const card = document.createElement('div');
  card.className = 'user-card';
  if (muted) card.classList.add('is-muted');
  if (deafened) card.classList.add('is-deafened');
  card.dataset.id = id;

  const initial = username.charAt(0).toUpperCase();
  let statusText = '';
  if (deafened) statusText = 'Deafened';
  else if (muted) statusText = 'Muted';

  card.innerHTML = `
    <div class="user-avatar">${initial}</div>
    <div class="user-info">
      <div class="user-name">${escapeHtml(username)}</div>
      <div class="user-status">${statusText}</div>
    </div>
    <div class="user-controls">
      <input type="range" class="volume-slider" min="0" max="100" value="100" title="Volume">
      <button class="small-btn mute-other-btn" title="Mute this user">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
        </svg>
      </button>
    </div>
  `;

  // Volume slider
  const slider = card.querySelector('.volume-slider');
  slider.addEventListener('input', () => {
    const peer = peers.get(id);
    if (peer && peer.gainNode) {
      peer.gainNode.gain.value = slider.value / 100;
    }
  });

  // Remote mute button
  const muteOtherBtn = card.querySelector('.mute-other-btn');
  muteOtherBtn.addEventListener('click', () => {
    socket.emit('remote-mute', id);
  });

  // Store username in peer data
  const peer = peers.get(id);
  if (peer) peer.username = username;

  usersList.appendChild(card);
}

function updateUserCount() {
  const count = document.querySelectorAll('.user-card').length + 1; // +1 for self
  userCount.textContent = `${count} online`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Self Controls ───

muteBtn.addEventListener('click', toggleMute);
deafenBtn.addEventListener('click', toggleDeafen);
leaveBtn.addEventListener('click', leave);

function toggleMute() {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  muteBtn.classList.toggle('active', isMuted);
  muteBtn.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
  socket.emit('mute-toggle', isMuted);
}

function toggleDeafen() {
  isDeafened = !isDeafened;

  // Set all remote audio to 0 or restore
  for (const [id, peer] of peers) {
    if (peer.gainNode) {
      if (isDeafened) {
        peer.gainNode.gain.value = 0;
      } else {
        // Restore to slider value
        const card = document.querySelector(`.user-card[data-id="${id}"]`);
        const slider = card?.querySelector('.volume-slider');
        peer.gainNode.gain.value = slider ? slider.value / 100 : 1;
      }
    }
  }

  deafenBtn.classList.toggle('active', isDeafened);
  deafenBtn.querySelector('span').textContent = isDeafened ? 'Undeafen' : 'Deafen';
  socket.emit('deafen-toggle', isDeafened);

  // Auto-mute when deafening
  if (isDeafened && !isMuted) {
    toggleMute();
  }
}

function leave() {
  // Stop all tracks
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  // Close all peer connections
  for (const [id, peer] of peers) {
    peer.pc.close();
    if (peer.source) peer.source.disconnect();
    if (peer.gainNode) peer.gainNode.disconnect();
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
  }
  peers.clear();

  // Close audio context
  if (audioContext) audioContext.close();

  // Reset state
  isMuted = false;
  isDeafened = false;
  muteBtn.classList.remove('active');
  deafenBtn.classList.remove('active');
  muteBtn.querySelector('span').textContent = 'Mute';
  deafenBtn.querySelector('span').textContent = 'Deafen';
  usersList.innerHTML = '';

  // Disconnect and go back to join screen
  socket.disconnect();
  roomScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');

  // Reconnect socket for next join
  socket.connect();
}
