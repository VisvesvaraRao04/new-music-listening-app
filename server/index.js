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
const io = new Server(server, { cors: { origin: '*' } })
const rooms = new Map()

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }))

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/health') || req.path.startsWith('/socket.io')) return next()
    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => res.send('TogetherTunes server is running'))
}

const roomCode = () => crypto.randomBytes(3).toString('hex').toUpperCase()
const getRoom = (code, name = 'Listening room', hostId = null) => rooms.get(code) || { code, name, hostId, queue: [], currentIndex: 0, isPlaying: false, currentTime: 0, updatedAt: Date.now(), users: new Map(), messages: [], suggestions: [] }
const snapshot = (room) => ({ code: room.code, name: room.name, hostId: room.hostId, queue: room.queue, currentIndex: room.currentIndex, isPlaying: room.isPlaying, currentTime: room.currentTime + (room.isPlaying ? (Date.now() - room.updatedAt) / 1000 : 0), users: [...room.users.values()], messages: room.messages, suggestions: room.suggestions })
const broadcastState = (code) => io.to(code).emit('room:state', snapshot(rooms.get(code)))

const roomCleanupTimers = new Map()

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, roomName }, done) => {
    let code = roomCode()
    while (rooms.has(code)) code = roomCode()
    rooms.set(code, getRoom(code, roomName?.trim().slice(0, 48) || 'Listening room', socket.id))
    join(socket, code, name, done)
  })
  socket.on('room:join', ({ code, name }, done) => join(socket, code?.trim().toUpperCase(), name, done))

  socket.on('player:action', ({ type, value }) => {
    const code = socket.data.roomCode; const room = rooms.get(code); if (!room) return
    if (type === 'play' || type === 'pause') { room.isPlaying = type === 'play'; room.currentTime = Number(value ?? room.currentTime); room.updatedAt = Date.now() }
    if (type === 'seek') { room.currentTime = Number(value) || 0; room.updatedAt = Date.now() }
    if (type === 'load') { room.currentIndex = Number(value) || 0; room.currentTime = 0; room.isPlaying = true; room.updatedAt = Date.now() }
    broadcastState(code)
  })
  socket.on('queue:add', ({ videoId, title, source, trackId, artist, audioUrl, imageUrl, playNow }) => { const room = rooms.get(socket.data.roomCode); if (!room || (!videoId && !trackId)) return; const item = { source: source || 'youtube', videoId, trackId, title: title || 'YouTube video', artist, audioUrl, imageUrl }; const index = room.queue.push(item) - 1; if (playNow || room.queue.length === 1) { room.currentIndex = index; room.currentTime = 0; room.isPlaying = true; room.updatedAt = Date.now() } broadcastState(socket.data.roomCode) })
  socket.on('queue:remove', (index) => { const room = rooms.get(socket.data.roomCode); if (!room) return; room.queue.splice(Number(index), 1); room.currentIndex = Math.min(room.currentIndex, Math.max(0, room.queue.length - 1)); broadcastState(socket.data.roomCode) })
  socket.on('queue:next', () => { const room = rooms.get(socket.data.roomCode); if (!room || !room.queue.length) return; room.currentIndex = (room.currentIndex + 1) % room.queue.length; room.currentTime = 0; room.isPlaying = true; room.updatedAt = Date.now(); broadcastState(socket.data.roomCode) })
  socket.on('room:rename', (name) => { const room = rooms.get(socket.data.roomCode); if (!room || room.hostId !== socket.id || !name?.trim()) return; room.name = name.trim().slice(0, 48); broadcastState(socket.data.roomCode) })
  socket.on('suggestion:add', ({ title, artist, source, trackId, audioUrl }) => { const room = rooms.get(socket.data.roomCode); if (!room || !title) return; room.suggestions.push({ id: crypto.randomUUID(), title, artist, source, trackId, audioUrl, by: socket.data.name }); room.suggestions = room.suggestions.slice(-30); broadcastState(socket.data.roomCode) })
  socket.on('chat:send', (text) => { const code = socket.data.roomCode; const room = rooms.get(code); if (!room || !text?.trim()) return; room.messages.push({ id: crypto.randomUUID(), name: socket.data.name, text: text.trim().slice(0, 300), at: Date.now() }); room.messages = room.messages.slice(-80); broadcastState(code) })
  socket.on('room:leave', () => handleLeave(socket))
  socket.on('disconnect', () => handleLeave(socket))
})

function handleLeave(socket) {
  const code = socket.data.roomCode; if (!code) return
  const room = rooms.get(code); if (!room) return
  socket.leave(code); socket.data.roomCode = null
  room.users.delete(socket.id)
  if (room.users.size) {
    if (room.hostId === socket.id) room.hostId = room.users.keys().next().value
    broadcastState(code)
  } else {
    if (roomCleanupTimers.has(code)) clearTimeout(roomCleanupTimers.get(code))
    const timer = setTimeout(() => {
      rooms.delete(code)
      roomCleanupTimers.delete(code)
    }, 10 * 60 * 1000)
    roomCleanupTimers.set(code, timer)
  }
}

function join(socket, code, name, done = () => {}) {
  if (!code || !rooms.has(code)) return done({ error: 'Room not found. Create a new room or check the code.' })
  if (roomCleanupTimers.has(code)) {
    clearTimeout(roomCleanupTimers.get(code))
    roomCleanupTimers.delete(code)
  }
  const room = rooms.get(code)
  socket.join(code)
  socket.data.roomCode = code
  socket.data.name = (name || 'Guest').trim().slice(0, 24) || 'Guest'
  if (!room.hostId || !room.users.has(room.hostId)) room.hostId = socket.id
  room.users.set(socket.id, { id: socket.id, name: socket.data.name })
  done({ code, name: room.name, hostId: room.hostId })
  broadcastState(code)
}

const port = process.env.PORT || 3001
server.listen(port, () => console.log(`TogetherTunes server listening on ${port}`))
