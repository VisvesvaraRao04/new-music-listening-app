
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.join(__dirname, '../dist')

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const rooms = new Map()
const roomCleanupTimers = new Map()

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size })
})

// Serve the frontend if the production build exists
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))

  // Express 5 wildcard syntax
  app.get('/{*splat}', (req, res, next) => {
    if (
      req.path.startsWith('/health') ||
      req.path.startsWith('/socket.io')
    ) {
      return next()
    }

    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.send('TogetherTunes server is running')
  })
}

// Generate a unique room code
const roomCode = () =>
  crypto.randomBytes(3).toString('hex').toUpperCase()

// Get room information
const getRoom = (
  code,
  name = 'Listening room',
  hostId = null
) =>
  rooms.get(code) || {
    code,
    name,
    hostId,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    currentTime: 0,
    updatedAt: Date.now(),
    users: new Map(),
    messages: [],
    suggestions: []
  }

// Room state snapshot
const snapshot = (room) => ({
  code: room.code,
  name: room.name,
  hostId: room.hostId,
  queue: room.queue,
  currentIndex: room.currentIndex,
  isPlaying: room.isPlaying,
  currentTime:
    room.currentTime +
    (room.isPlaying
      ? (Date.now() - room.updatedAt) / 1000
      : 0),
  users: [...room.users.values()],
  messages: room.messages,
  suggestions: room.suggestions
})

// Broadcast room state
const broadcastState = (code) => {
  const room = rooms.get(code)
  if (room) {
    io.to(code).emit('room:state', snapshot(room))
  }
}

// Handle user leaving a room
function handleLeave(socket) {
  const code = socket.data.roomCode
  if (!code) return

  const room = rooms.get(code)
  if (!room) {
    socket.data.roomCode = null
    return
  }

  socket.leave(code)
  socket.data.roomCode = null

  room.users.delete(socket.id)

  if (room.users.size > 0) {
    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value
    }

    broadcastState(code)
  } else {
    if (roomCleanupTimers.has(code)) {
      clearTimeout(roomCleanupTimers.get(code))
    }

    const timer = setTimeout(() => {
      rooms.delete(code)
      roomCleanupTimers.delete(code)
    }, 10 * 60 * 1000)

    roomCleanupTimers.set(code, timer)
  }
}

// Join a room
function join(socket, code, name, done = () => {}) {
  if (!code || !rooms.has(code)) {
    return done({
      error: 'Room not found. Create a new room or check the code.'
    })
  }

  if (roomCleanupTimers.has(code)) {
    clearTimeout(roomCleanupTimers.get(code))
    roomCleanupTimers.delete(code)
  }

  const room = rooms.get(code)

  socket.join(code)
  socket.data.roomCode = code
  socket.data.name =
    (name || 'Guest').trim().slice(0, 24) || 'Guest'

  if (!room.hostId || !room.users.has(room.hostId)) {
    room.hostId = socket.id
  }

  room.users.set(socket.id, {
    id: socket.id,
    name: socket.data.name
  })

  done({
    code,
    name: room.name,
    hostId: room.hostId
  })

  broadcastState(code)
}

// Socket.IO events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  // Create room
  socket.on('room:create', (data = {}, done = () => {}) => {
    let code = roomCode()

    while (rooms.has(code)) {
      code = roomCode()
    }

    rooms.set(
      code,
      getRoom(
        code,
        data.roomName?.trim().slice(0, 48) ||
          data.name?.trim().slice(0, 48) ||
          'Listening room',
        socket.id
      )
    )

    join(socket, code, data.name, done)
  })

  // Join room
  socket.on('room:join', (data = {}, done = () => {}) => {
    join(
      socket,
      data.code?.trim().toUpperCase(),
      data.name,
      done
    )
  })

  // Player actions
  socket.on('player:action', ({ type, value } = {}) => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room) return

    if (type === 'play' || type === 'pause') {
      room.isPlaying = type === 'play'
      room.currentTime = Number(value ?? room.currentTime)
      room.updatedAt = Date.now()
    }

    if (type === 'seek') {
      room.currentTime = Number(value) || 0
      room.updatedAt = Date.now()
    }

    if (type === 'load') {
      room.currentIndex = Number(value) || 0
      room.currentTime = 0
      room.isPlaying = true
      room.updatedAt = Date.now()
    }

    broadcastState(code)
  })

  // Add music to queue
  socket.on('queue:add', (data = {}) => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room || (!data.videoId && !data.trackId)) return

    const item = {
      source: data.source || 'youtube',
      videoId: data.videoId,
      trackId: data.trackId,
      title: data.title || 'YouTube video',
      artist: data.artist,
      audioUrl: data.audioUrl,
      imageUrl: data.imageUrl
    }

    const index = room.queue.push(item) - 1

    if (data.playNow || room.queue.length === 1) {
      room.currentIndex = index
      room.currentTime = 0
      room.isPlaying = true
      room.updatedAt = Date.now()
    }

    broadcastState(code)
  })

  // Remove music from queue
  socket.on('queue:remove', (index) => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room) return

    const position = Number(index)

    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position >= room.queue.length
    ) {
      return
    }

    room.queue.splice(position, 1)

    if (room.queue.length === 0) {
      room.currentIndex = 0
      room.currentTime = 0
      room.isPlaying = false
    } else {
      room.currentIndex = Math.min(
        room.currentIndex,
        room.queue.length - 1
      )
    }

    broadcastState(code)
  })

  // Play next track
  socket.on('queue:next', () => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room || !room.queue.length) return

    room.currentIndex =
      (room.currentIndex + 1) % room.queue.length

    room.currentTime = 0
    room.isPlaying = true
    room.updatedAt = Date.now()

    broadcastState(code)
  })

  // Rename room (host only)
  socket.on('room:rename', (name) => {
    const room = rooms.get(socket.data.roomCode)

    if (
      !room ||
      room.hostId !== socket.id ||
      !name?.trim()
    ) {
      return
    }

    room.name = name.trim().slice(0, 48)

    broadcastState(socket.data.roomCode)
  })

  // Add music suggestion
  socket.on('suggestion:add', (data = {}) => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room || !data.title) return

    room.suggestions.push({
      id: crypto.randomUUID(),
      title: data.title,
      artist: data.artist,
      source: data.source,
      trackId: data.trackId,
      audioUrl: data.audioUrl,
      by: socket.data.name
    })

    room.suggestions = room.suggestions.slice(-30)

    broadcastState(code)
  })

  // Send chat message
  socket.on('chat:send', (text) => {
    const code = socket.data.roomCode
    const room = rooms.get(code)

    if (!room || typeof text !== 'string' || !text.trim()) {
      return
    }

    room.messages.push({
      id: crypto.randomUUID(),
      name: socket.data.name,
      text: text.trim().slice(0, 300),
      at: Date.now()
    })

    room.messages = room.messages.slice(-80)

    broadcastState(code)
  })

  // Leave room
  socket.on('room:leave', () => handleLeave(socket))

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
    handleLeave(socket)
  })
})

// Start server
const port = process.env.PORT || 3001

server.listen(port, () => {
  console.log(`TogetherTunes server listening on ${port}`)
})
