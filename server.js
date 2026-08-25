const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytsr = require('ytsr');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// roomCode -> { host, hostUserId, members, state, queue, reconnectTimer }
// state: { videoId, title, thumbnail, channel, playing, position, updatedAt }
// queue: [{ videoId, title, thumbnail, channel, duration }, ...]
const rooms = new Map();
const HOST_RECONNECT_MS = 20000; // 20s grace period for host to reconnect

app.use(express.static(path.join(__dirname, 'public')));

// ---- Search API ----
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    // ytsr v3 logs "type X is not known" for newer YouTube response shapes — suppress those
    const origError = console.error;
    console.error = () => {};
    const raw = await ytsr(q, { limit: 10 }).finally(() => { console.error = origError; });
    const results = raw.items
      .filter((item) => item.type === 'video')
      .slice(0, 8)
      .map((item) => ({
        videoId: item.id,
        title: item.title,
        thumbnail: item.bestThumbnail?.url || `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
        channel: item.author?.name || '',
        duration: item.duration || '',
      }));
    res.json({ results });
  } catch (e) {
    console.error('Search error:', e.message);
    res.json({ results: [] });
  }
});

// ---- Video info for pasted URLs ----
app.get('/api/video-info', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({});
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`
    );
    if (!r.ok) throw new Error('oembed failed');
    const d = await r.json();
    res.json({ title: d.title, thumbnail: d.thumbnail_url, channel: d.author_name });
  } catch {
    res.json({ title: '', thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`, channel: '' });
  }
});

// ---- Helpers ----
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function getRoom(socket) {
  return rooms.get(socket.roomCode);
}
function emitQueue(roomCode, room) {
  io.to(roomCode).emit('queueUpdated', { queue: room.queue });
}

// ---- Sockets ----
io.on('connection', (socket) => {

  socket.on('createRoom', ({ userId } = {}, callback) => {
    const code = generateCode();
    rooms.set(code, {
      host: socket.id,
      hostUserId: userId || null,
      members: [socket.id],
      state: { videoId: null, title: '', thumbnail: '', channel: '', playing: false, position: 0, updatedAt: Date.now() },
      queue: [],
      reconnectTimer: null,
    });
    socket.join(code);
    socket.roomCode = code;
    socket.userId = userId || null;
    callback({ code });
  });

  socket.on('joinRoom', ({ code, userId }, callback) => {
    const room = rooms.get(code);
    if (!room) return callback({ error: 'Room not found' });

    // Host reconnecting within grace period
    const isReturningHost = userId && room.hostUserId && userId === room.hostUserId;
    if (isReturningHost) {
      if (room.reconnectTimer) { clearTimeout(room.reconnectTimer); room.reconnectTimer = null; }
      room.host = socket.id;
    }

    socket.join(code);
    socket.roomCode = code;
    socket.userId = userId || null;
    room.members.push(socket.id);

    const elapsed = room.state.playing ? (Date.now() - room.state.updatedAt) / 1000 : 0;
    callback({ success: true, isHost: isReturningHost });
    if (!isReturningHost) io.to(room.host).emit('listenerJoined');
    socket.emit('syncState', { ...room.state, position: room.state.position + elapsed });
    socket.emit('queueUpdated', { queue: room.queue });
  });

  socket.on('play', ({ videoId, position }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.state = { ...room.state, videoId, playing: true, position, updatedAt: Date.now() };
    socket.to(socket.roomCode).emit('play', { videoId, position, sentAt: Date.now() });
  });

  socket.on('pause', ({ position }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.state.playing = false;
    room.state.position = position;
    room.state.updatedAt = Date.now();
    socket.to(socket.roomCode).emit('pause', { position });
  });

  socket.on('seek', ({ position }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.state.position = position;
    room.state.updatedAt = Date.now();
    socket.to(socket.roomCode).emit('seek', { position });
  });

  socket.on('changeTrack', ({ videoId, title, thumbnail, channel }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.state = { videoId, title: title || '', thumbnail: thumbnail || '', channel: channel || '', playing: true, position: 0, updatedAt: Date.now() };
    socket.to(socket.roomCode).emit('changeTrack', { videoId, title, thumbnail, channel });
    io.to(socket.roomCode).emit('nowPlaying', { videoId, title, thumbnail, channel });
  });

  socket.on('addToQueue', ({ videoId, title, thumbnail, channel, duration }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.queue.push({ videoId, title, thumbnail, channel, duration });
    emitQueue(socket.roomCode, room);
  });

  socket.on('removeFromQueue', ({ index }) => {
    const room = getRoom(socket);
    if (!room) return;
    room.queue.splice(index, 1);
    emitQueue(socket.roomCode, room);
  });

  socket.on('playFromQueue', ({ index }) => {
    const room = getRoom(socket);
    if (!room) return;
    const [item] = room.queue.splice(index, 1);
    room.state = { videoId: item.videoId, title: item.title, thumbnail: item.thumbnail, channel: item.channel, playing: true, position: 0, updatedAt: Date.now() };
    io.to(socket.roomCode).emit('changeTrack', { ...item });
    io.to(socket.roomCode).emit('nowPlaying', { ...item });
    emitQueue(socket.roomCode, room);
  });

  socket.on('songEnded', ({ videoId } = {}) => {
    const room = getRoom(socket);
    if (!room || room.queue.length === 0) return;
    // Ignore duplicate songEnded from other clients if track already advanced
    if (videoId && room.state.videoId !== videoId) return;
    const [item] = room.queue.splice(0, 1);
    room.state = { videoId: item.videoId, title: item.title, thumbnail: item.thumbnail, channel: item.channel, playing: true, position: 0, updatedAt: Date.now() };
    io.to(socket.roomCode).emit('changeTrack', { ...item });
    io.to(socket.roomCode).emit('nowPlaying', { ...item });
    emitQueue(socket.roomCode, room);
  });

  socket.on('requestSync', () => {
    const room = getRoom(socket);
    if (!room || !room.state.videoId) return;
    const elapsed = room.state.playing ? (Date.now() - room.state.updatedAt) / 1000 : 0;
    socket.emit('syncState', { ...room.state, position: room.state.position + elapsed });
    socket.emit('queueUpdated', { queue: room.queue });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.members = room.members.filter((id) => id !== socket.id);
    if (room.host === socket.id) {
      // Give the host a grace period to reload and reconnect before destroying the room
      room.reconnectTimer = setTimeout(() => {
        io.to(code).emit('hostLeft');
        rooms.delete(code);
      }, HOST_RECONNECT_MS);
    } else {
      io.to(room.host).emit('listenerLeft');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`YouTube Jam → http://localhost:${PORT}`));
