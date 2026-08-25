const socket = io();

let player = null;
let playerReady = false;
let isHost = false;
let roomCode = null;
let isSyncing = false;

// Stable per-browser identity so the host can reclaim their role after a reload
let userId = sessionStorage.getItem('ytjam_uid');
if (!userId) {
  userId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  sessionStorage.setItem('ytjam_uid', userId);
}

function saveSession(code) { sessionStorage.setItem('ytjam_room', code); }
function clearSession()    { sessionStorage.removeItem('ytjam_room'); }

// Seek detection
let lastPos = 0;
let lastCheckAt = 0;
let seekInterval = null;

// ── YouTube IFrame API ──

const ytScript = document.createElement('script');
ytScript.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytScript);

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('player', {
    height: '100%', width: '100%',
    playerVars: { rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; if (roomCode) socket.emit('requestSync'); },
      onStateChange: onPlayerStateChange,
    },
  });
};

function onPlayerStateChange(event) {
  if (isSyncing) return;
  const state = event.data;
  const videoId = player.getVideoData()?.video_id;
  const position = player.getCurrentTime();

  if (state === YT.PlayerState.PLAYING) {
    socket.emit('play', { videoId, position });
    startSeekDetection();
  } else if (state === YT.PlayerState.PAUSED) {
    socket.emit('pause', { position });
    stopSeekDetection();
  } else if (state === YT.PlayerState.ENDED) {
    stopSeekDetection();
    socket.emit('songEnded', { videoId });
  }
}

function startSeekDetection() {
  stopSeekDetection();
  lastPos = player.getCurrentTime();
  lastCheckAt = Date.now();
  seekInterval = setInterval(() => {
    if (!player || !playerReady) return;
    const now = Date.now();
    const elapsed = (now - lastCheckAt) / 1000;
    const current = player.getCurrentTime();
    if (Math.abs(current - (lastPos + elapsed)) > 2.5) {
      socket.emit('seek', { position: current });
    }
    lastPos = current;
    lastCheckAt = now;
  }, 800);
}

function stopSeekDetection() {
  if (seekInterval) { clearInterval(seekInterval); seekInterval = null; }
}

// ── Socket events ──

socket.on('play', ({ videoId, position, sentAt }) => {
  const latency = (Date.now() - sentAt) / 1000;
  applySynced(() => {
    if (player.getVideoData()?.video_id !== videoId) {
      player.loadVideoById({ videoId, startSeconds: position + latency });
    } else {
      player.seekTo(position + latency, true);
      player.playVideo();
    }
  });
});

socket.on('pause', ({ position }) => {
  applySynced(() => { player.seekTo(position, true); player.pauseVideo(); });
});

socket.on('seek', ({ position }) => {
  applySynced(() => player.seekTo(position, true));
});

socket.on('changeTrack', ({ videoId, title, thumbnail, channel }) => {
  applySynced(() => player.loadVideoById(videoId));
  updateNowPlaying({ videoId, title, thumbnail, channel });
});

socket.on('nowPlaying', (info) => {
  updateNowPlaying(info);
});

socket.on('syncState', ({ videoId, title, thumbnail, channel, playing, position }) => {
  if (!videoId) return;
  applySynced(() => {
    if (playing) player.loadVideoById({ videoId, startSeconds: position });
    else player.cueVideoById({ videoId, startSeconds: position });
  });
  updateNowPlaying({ videoId, title, thumbnail, channel });
});

socket.on('queueUpdated', ({ queue }) => renderQueue(queue));

socket.on('listenerJoined', () => { setFriendStatus('🟢 Friend joined', 'status-joined'); });
socket.on('listenerLeft',   () => { setFriendStatus('🔴 Friend left', 'status-left'); });

function setFriendStatus(text, cls) {
  const el = $('friendStatus');
  el.textContent = text;
  el.className = 'friend-status ' + cls;
  // Pulse animation
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = 'statusPulse 0.4s ease';
}
socket.on('hostLeft', () => { clearSession(); alert('The host left. Room closed.'); location.reload(); });

// Auto-rejoin saved room after a page reload
socket.on('connect', () => {
  const savedCode = sessionStorage.getItem('ytjam_room');
  if (!savedCode || roomCode) return; // already in a room or nothing saved
  socket.emit('joinRoom', { code: savedCode, userId }, ({ error, isHost: returnedAsHost }) => {
    if (error) { clearSession(); return; }
    roomCode = savedCode;
    isHost = !!returnedAsHost;
    enterRoom(roomCode);
    if (playerReady) socket.emit('requestSync');
  });
});

function applySynced(fn) {
  isSyncing = true;
  fn();
  setTimeout(() => { isSyncing = false; }, 600);
}

// ── UI helpers ──

const $ = (id) => document.getElementById(id);

function updateNowPlaying({ title, thumbnail, channel, videoId }) {
  const thumb = thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '');
  if (!title && !thumb) return;
  $('npTitle').textContent = title || 'Now Playing';
  $('npChannel').textContent = channel || '';
  $('npThumb').src = thumb;
  $('nowPlayingBar').classList.remove('hidden');
}

function renderQueue(queue) {
  const list = $('queueList');
  $('queueCount').textContent = `${queue.length} song${queue.length !== 1 ? 's' : ''}`;
  if (queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">Queue is empty</div>';
    return;
  }
  list.innerHTML = queue.map((item, i) => `
    <div class="queue-item">
      <span class="queue-num">${i + 1}</span>
      <img class="queue-thumb" src="${item.thumbnail || `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}" alt="" loading="lazy" />
      <div class="queue-info">
        <div class="queue-item-title">${esc(item.title)}</div>
        <div class="queue-item-meta">${esc(item.channel)}${item.duration ? ' · ' + item.duration : ''}</div>
      </div>
      <div class="queue-item-actions">
        <button onclick="playFromQueue(${i})" title="Play now">▶</button>
        <button onclick="removeFromQueue(${i})" title="Remove">✕</button>
      </div>
    </div>
  `).join('');
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.playFromQueue = (index) => socket.emit('playFromQueue', { index });
window.removeFromQueue = (index) => socket.emit('removeFromQueue', { index });

// ── Landing ──

$('createBtn').addEventListener('click', () => {
  socket.emit('createRoom', { userId }, ({ code }) => {
    roomCode = code; isHost = true;
    saveSession(code);
    enterRoom(code);
  });
});

$('joinBtn').addEventListener('click', doJoin);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
$('codeInput').addEventListener('input', () => {
  $('codeInput').value = $('codeInput').value.toUpperCase();
});

function doJoin() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('joinRoom', { code, userId }, ({ error }) => {
    if (error) { alert('Room not found. Check the code.'); return; }
    roomCode = code; isHost = false;
    saveSession(code);
    enterRoom(code);
    if (playerReady) socket.emit('requestSync');
  });
}

function enterRoom(code) {
  $('landing').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent = code;
  $('hostSearch').classList.remove('hidden');
  $('listenerBanner').classList.add('hidden');
  $('leaveBtn').classList.toggle('hidden', isHost);
}

function leaveRoom() {
  clearSession();
  stopSeekDetection();
  if (player) player.stopVideo();
  // Reset state
  roomCode = null;
  isHost = false;
  isSyncing = false;
  // Reset UI
  $('room').classList.add('hidden');
  $('landing').classList.remove('hidden');
  $('hostSearch').classList.add('hidden');
  $('nowPlayingBar').classList.add('hidden');
  $('friendStatus').textContent = '';
  $('leaveBtn').classList.add('hidden');
  $('codeInput').value = '';
  // Disconnect triggers listenerLeft on server; reconnect for future rooms
  socket.disconnect();
  socket.connect();
}

$('leaveBtn').addEventListener('click', leaveRoom);

$('copyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    $('copyBtn').textContent = '✅';
    setTimeout(() => { $('copyBtn').textContent = '📋'; }, 1500);
  });
});

$('resyncBtn').addEventListener('click', () => socket.emit('requestSync'));

// ── URL paste ──

$('loadBtn').addEventListener('click', loadUrl);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl(); });

async function loadUrl() {
  const input = $('urlInput').value.trim();
  const videoId = extractVideoId(input);
  if (!videoId) { alert('Paste a valid YouTube or YouTube Music URL'); return; }
  $('urlInput').value = '';

  // Fetch metadata then play
  let title = '', thumbnail = '', channel = '';
  try {
    const r = await fetch(`/api/video-info?videoId=${encodeURIComponent(videoId)}`);
    const d = await r.json();
    title = d.title || ''; thumbnail = d.thumbnail || ''; channel = d.channel || '';
  } catch {}

  isSyncing = false;
  player.loadVideoById(videoId);
  socket.emit('changeTrack', { videoId, title, thumbnail, channel });
  updateNowPlaying({ videoId, title, thumbnail, channel });
}

// ── Search ──

let searchTimer = null;

$('searchInput').addEventListener('input', () => {
  const q = $('searchInput').value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { hideResults(); return; }
  showLoading();
  searchTimer = setTimeout(() => doSearch(q), 400);
});

$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideResults();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideResults();
});

async function doSearch(q) {
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const { results } = await r.json();
    renderResults(results);
  } catch {
    hideResults();
  }
}

function showLoading() {
  const el = $('searchResults');
  el.innerHTML = '<div class="search-loading">Searching…</div>';
  el.classList.remove('hidden');
}

function hideResults() {
  $('searchResults').classList.add('hidden');
}

function renderResults(results) {
  const el = $('searchResults');
  if (!results || results.length === 0) {
    el.innerHTML = '<div class="search-loading">No results found</div>';
    el.classList.remove('hidden');
    return;
  }
  el.innerHTML = results.map((item) => `
    <div class="result-item">
      <img class="result-thumb" src="${item.thumbnail}" alt="" loading="lazy" />
      <div class="result-info">
        <div class="result-title">${esc(item.title)}</div>
        <div class="result-meta">${esc(item.channel)}${item.duration ? ' · ' + item.duration : ''}</div>
      </div>
      <div class="result-actions">
        <button class="play-now" onclick='playNow(${JSON.stringify(JSON.stringify(item))})'>▶ Play</button>
        <button onclick='addToQueue(${JSON.stringify(JSON.stringify(item))})'>+ Queue</button>
      </div>
    </div>
  `).join('');
  el.classList.remove('hidden');
}

window.playNow = (itemJson) => {
  const item = JSON.parse(itemJson);
  isSyncing = false;
  player.loadVideoById(item.videoId);
  socket.emit('changeTrack', { videoId: item.videoId, title: item.title, thumbnail: item.thumbnail, channel: item.channel });
  updateNowPlaying(item);
  $('searchInput').value = '';
  hideResults();
};

window.addToQueue = (itemJson) => {
  const item = JSON.parse(itemJson);
  socket.emit('addToQueue', item);
  // Flash feedback
  const btn = event.target;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = '+ Queue'; }, 1000);
};

// ── Utilities ──

function extractVideoId(input) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.includes('youtube.com') || url.hostname.includes('music.youtube.com')) {
      return url.searchParams.get('v');
    }
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1).split('?')[0];
    }
  } catch {}
  return null;
}
