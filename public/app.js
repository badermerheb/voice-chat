const socket = io();

// State
let localStream = null;
let audioContext = null;
let myUsername = '';
let isMuted = false;
let isDeafened = false;

// Map of peerId -> { pc, gainNode, audioEl, source, username }
const peers = new Map();

// ICE servers - fetched dynamically (includes TURN if configured)
let iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

async function fetchIceServers() {
  try {
    const res = await fetch('/api/ice-servers');
    const servers = await res.json();
    iceConfig = { iceServers: servers };
    const hasTurn = servers.some((s) => s.urls?.toString().includes('turn'));
    dbg(`ICE servers loaded: ${servers.length} servers, TURN: ${hasTurn ? 'YES' : 'NO (STUN only)'}`);
  } catch (e) {
    dbg(`Failed to fetch ICE servers: ${e.message}, using defaults`);
  }
}

// ─── Debug Logger ───
const debugLog = document.getElementById('debug-log');
function dbg(msg) {
  console.log(msg);
  if (debugLog) {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    debugLog.appendChild(line);
    debugLog.parentElement.scrollTop = debugLog.parentElement.scrollHeight;
  }
}

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

  // Fetch TURN credentials before connecting
  await fetchIceServers();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    dbg(`Mic access granted. Tracks: ${localStream.getAudioTracks().length}, enabled: ${localStream.getAudioTracks()[0]?.enabled}`);
  } catch (err) {
    alert('Microphone access is required. Please allow it and try again.');
    dbg(`Mic DENIED: ${err.message}`);
    return;
  }

  audioContext = new AudioContext();
  dbg(`AudioContext state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate}`);
  myUsername = name;

  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');

  socket.emit('join', name);
  dbg(`Emitted join as "${name}", socket id: ${socket.id}`);
}

// ─── Socket Events ───

socket.on('connect', () => {
  dbg(`Socket connected: ${socket.id}`);
});

socket.on('disconnect', (reason) => {
  dbg(`Socket disconnected: ${reason}`);
});

// Existing users already in the room
socket.on('existing-users', (users) => {
  dbg(`Got existing-users: ${users.length} users`);
  users.forEach((user) => {
    dbg(`  existing user: ${user.username} (${user.id})`);
    addUserToUI(user.id, user.username, user.muted, user.deafened);
    createPeerConnection(user.id, true); // We are the offerer
  });
  updateUserCount();
});

// New user joins
socket.on('user-joined', (user) => {
  dbg(`user-joined: ${user.username} (${user.id})`);
  addUserToUI(user.id, user.username, user.muted, user.deafened);
  createPeerConnection(user.id, false); // They will send us an offer
  updateUserCount();
});

// User leaves
socket.on('user-left', (peerId) => {
  dbg(`user-left: ${peerId}`);
  removePeer(peerId);
  updateUserCount();
});

// WebRTC signaling
socket.on('offer', async ({ from, offer }) => {
  dbg(`Got OFFER from ${from}`);
  let peer = peers.get(from);
  if (!peer) {
    dbg(`  No peer found for ${from}, creating one...`);
    await createPeerConnection(from, false);
    peer = peers.get(from);
  }
  if (!peer) {
    dbg(`  STILL no peer for ${from}, aborting`);
    return;
  }
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
    dbg(`  setRemoteDescription OK`);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    dbg(`  Sending ANSWER to ${from}`);
    socket.emit('answer', { to: from, answer: peer.pc.localDescription });
  } catch (e) {
    dbg(`  ERROR handling offer: ${e.message}`);
  }
});

socket.on('answer', async ({ from, answer }) => {
  dbg(`Got ANSWER from ${from}`);
  const peer = peers.get(from);
  if (!peer) {
    dbg(`  No peer for ${from}`);
    return;
  }
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    dbg(`  setRemoteDescription(answer) OK`);
  } catch (e) {
    dbg(`  ERROR handling answer: ${e.message}`);
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    dbg(`ICE candidate error from ${from}: ${e.message}`);
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
    card.querySelector('.user-status').textContent = deafened ? 'Deafened' : '';
  }
});

// Someone force-muted us
socket.on('force-mute', () => {
  if (!isMuted) toggleMute();
});

// ─── WebRTC ───

async function createPeerConnection(peerId, isOfferer) {
  dbg(`createPeerConnection(${peerId}, offerer=${isOfferer})`);
  const pc = new RTCPeerConnection(iceConfig);

  // Store peer FIRST so handlers can find it
  peers.set(peerId, {
    pc,
    gainNode: null,
    source: null,
    audioEl: null,
    username: '',
  });

  // ICE candidates
  let iceCandidateCount = 0;
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      iceCandidateCount++;
      socket.emit('ice-candidate', { to: peerId, candidate: event.candidate });
    } else {
      dbg(`  ICE gathering done for ${peerId} (${iceCandidateCount} candidates)`);
    }
  };

  pc.onicegatheringstatechange = () => {
    dbg(`  ICE gathering: ${pc.iceGatheringState} for ${peerId}`);
  };

  pc.onconnectionstatechange = () => {
    dbg(`  Connection state: ${pc.connectionState} for ${peerId}`);
  };

  pc.oniceconnectionstatechange = () => {
    dbg(`  ICE connection: ${pc.iceConnectionState} for ${peerId}`);
  };

  pc.onsignalingstatechange = () => {
    dbg(`  Signaling state: ${pc.signalingState} for ${peerId}`);
  };

  // Handle incoming audio - DIRECT <audio> element (no Web Audio API routing)
  pc.ontrack = (event) => {
    dbg(`  ontrack from ${peerId}: kind=${event.track.kind}, readyState=${event.track.readyState}, streams=${event.streams.length}`);

    const remoteStream = event.streams[0] || new MediaStream([event.track]);

    // Direct <audio> element - most reliable playback method
    const audioEl = document.createElement('audio');
    audioEl.srcObject = remoteStream;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.volume = isDeafened ? 0 : 1.0;
    document.body.appendChild(audioEl);

    const playPromise = audioEl.play();
    if (playPromise) {
      playPromise
        .then(() => dbg(`  Audio element PLAYING for ${peerId}`))
        .catch((e) => dbg(`  Audio play FAILED for ${peerId}: ${e.message}`));
    }

    const peer = peers.get(peerId);
    if (peer) {
      peer.audioEl = audioEl;
    }

    dbg(`  Audio set up for ${peerId} (direct <audio> srcObject)`);
  };

  // Add our audio track AFTER handlers are set
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
    dbg(`  Added local track: ${track.kind}, enabled=${track.enabled}`);
  });

  // Explicitly create and send offer
  if (isOfferer) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
      dbg(`  OFFER sent to ${peerId} (type=${offer.type}, sdp length=${offer.sdp.length})`);
    } catch (e) {
      dbg(`  ERROR creating offer: ${e.message}`);
    }
  }

  return pc;
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    peer.pc.close();
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

  // Volume slider - controls <audio> element volume directly
  const slider = card.querySelector('.volume-slider');
  slider.addEventListener('input', () => {
    const peer = peers.get(id);
    if (peer && peer.audioEl) {
      peer.audioEl.volume = slider.value / 100;
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
  const count = document.querySelectorAll('.user-card').length + 1;
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

  for (const [id, peer] of peers) {
    if (peer.audioEl) {
      if (isDeafened) {
        peer.audioEl.volume = 0;
      } else {
        const card = document.querySelector(`.user-card[data-id="${id}"]`);
        const slider = card?.querySelector('.volume-slider');
        peer.audioEl.volume = slider ? slider.value / 100 : 1;
      }
    }
  }

  deafenBtn.classList.toggle('active', isDeafened);
  deafenBtn.querySelector('span').textContent = isDeafened ? 'Undeafen' : 'Deafen';
  socket.emit('deafen-toggle', isDeafened);

  if (isDeafened && !isMuted) {
    toggleMute();
  }
}

function leave() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  for (const [id, peer] of peers) {
    peer.pc.close();
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
  }
  peers.clear();

  if (audioContext) audioContext.close();

  isMuted = false;
  isDeafened = false;
  muteBtn.classList.remove('active');
  deafenBtn.classList.remove('active');
  muteBtn.querySelector('span').textContent = 'Mute';
  deafenBtn.querySelector('span').textContent = 'Deafen';
  usersList.innerHTML = '';

  socket.disconnect();
  roomScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');

  socket.connect();
}
