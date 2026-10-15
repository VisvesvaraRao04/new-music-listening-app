import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const getServerUrl = () => localStorage.getItem('tt_server_url') || import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'
const getJiosaavnUrl = () => localStorage.getItem('tt_jiosaavn_url') || import.meta.env.VITE_JIOSAAVN_API_URL || 'http://127.0.0.1:8000'
const JAMENDO_ID = import.meta.env.VITE_JAMENDO_CLIENT_ID
const YOUTUBE_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY
const SAYA_API_URL = import.meta.env.VITE_SAYA_API_URL || 'http://127.0.0.1:8787'
const emptyRoom = { name: 'Listening room', hostId: null, queue: [], currentIndex: 0, isPlaying: false, currentTime: 0, users: [], messages: [], suggestions: [] }

const getVideoId = (value) => { try { const u = new URL(value); if (u.hostname.includes('youtu.be')) return u.pathname.slice(1); if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() } catch {} return value.trim() }
const formatTime = (value) => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`
const artFor = (track) => track?.source === 'youtube' ? (track?.videoId ? `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg` : track?.imageUrl) : track?.imageUrl

export default function App() {
  const socket = useRef(null); const yt = useRef(null); const audio = useRef(null); const syncTimer = useRef(null); const clockTimer = useRef(null)
  const [screen, setScreen] = useState('home')
  const [person, setPerson] = useState(() => localStorage.getItem('tt_person') || '')
  const [roomName, setRoomName] = useState('')
  const [joinCode, setJoinCode] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('room')?.toUpperCase() || localStorage.getItem('tt_room') || ''
  })
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem('tt_room') || '')
  const [room, setRoom] = useState(emptyRoom)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [source, setSource] = useState('audius')
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [chat, setChat] = useState('')
  const [showTools, setShowTools] = useState(true)
  const [displayTime, setDisplayTime] = useState(0)
  const [duration, setDuration] = useState(235)

  // Name prompt modal for asking username on joining/creating room
  const [nameModal, setNameModal] = useState({ open: false, action: 'room:join', code: '', title: '', subtitle: '' })
  const [modalInputName, setModalInputName] = useState('')
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)

  const commitSeek = (targetTime) => {
    setIsScrubbing(false)
    const time = Math.max(0, Math.min(Number(targetTime), duration || 0))
    if (!Number.isFinite(time)) return
    setDisplayTime(time)

    if (current?.source !== 'youtube') {
      if (audio.current) {
        try { audio.current.currentTime = time } catch {}
      }
    } else {
      yt.current?.seekTo?.(time, true)
    }

    sendAction('seek', time)
  }

  const current = room.queue[room.currentIndex]

  // Persist session on mount: auto-join without exiting if room is active
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlRoom = params.get('room')?.toUpperCase()
    const savedRoom = localStorage.getItem('tt_room')
    const targetRoom = urlRoom || savedRoom
    const savedPerson = localStorage.getItem('tt_person')?.trim()

    if (targetRoom) {
      setJoinCode(targetRoom)
      if (savedPerson) {
        connect('room:join', targetRoom, savedPerson)
      } else {
        setNameModal({
          open: true,
          action: 'room:join',
          code: targetRoom,
          title: `Join room ${targetRoom}`,
          subtitle: 'Please enter your name to join the listening room.'
        })
        setModalInputName('')
      }
    }
  }, [])

  useEffect(() => {
    if (screen !== 'room') return
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; document.body.appendChild(script); window.onYouTubeIframeAPIReady = createYouTube
    return () => { window.onYouTubeIframeAPIReady = null; clearInterval(syncTimer.current); clearInterval(clockTimer.current); yt.current?.destroy?.(); yt.current = null; script.remove() }
  }, [screen])

  useEffect(() => { if (screen === 'room' && window.YT?.Player && document.getElementById('youtube-player') && !yt.current) createYouTube() }, [screen])

  useEffect(() => {
    if (!current) {
      if (audio.current) {
        audio.current.pause()
        audio.current.src = ''
      }
      yt.current?.stopVideo?.()
      return
    }

    if (current.source !== 'youtube') {
      yt.current?.stopVideo?.()
      const player = audio.current
      if (player) {
        player.pause()
        player.src = current.audioUrl || ''
        player.currentTime = room.currentTime || 0
        player.load()

        const onCanPlay = () => {
          if (room.currentTime) {
            try { player.currentTime = room.currentTime } catch {}
          }
          if (room.isPlaying) {
            player.play().catch(() => {})
          }
        }

        player.addEventListener('canplay', onCanPlay, { once: true })
        if (room.isPlaying) {
          player.play().catch(() => {})
        }

        return () => {
          player.removeEventListener('canplay', onCanPlay)
        }
      }
    } else {
      if (audio.current) {
        audio.current.pause()
        audio.current.src = ''
      }
      if (yt.current?.loadVideoById) {
        yt.current.loadVideoById({ videoId: current.videoId, startSeconds: room.currentTime || 0 })
        if (room.isPlaying) {
          yt.current.playVideo?.()
        }
      } else if (window.YT?.Player) {
        createYouTube()
      }
    }
  }, [current?.trackId, current?.videoId, current?.audioUrl])

  useEffect(() => {
    if (!current) return
    if (current.source !== 'youtube') {
      const active = audio.current
      if (!active) return
      if (Math.abs((active.currentTime || 0) - (room.currentTime || 0)) > 1.2) {
        try { active.currentTime = room.currentTime || 0 } catch {}
      }
      if (room.isPlaying) {
        active.play().catch(() => {})
      } else {
        active.pause()
      }
    } else {
      const active = yt.current
      if (!active?.getCurrentTime) return
      const now = active.getCurrentTime()
      if (Math.abs((now || 0) - (room.currentTime || 0)) > 1.2) {
        active.seekTo?.(room.currentTime || 0, true)
      }
      if (room.isPlaying) {
        active.playVideo?.()
      } else {
        active.pauseVideo?.()
      }
    }
  }, [room.isPlaying, room.currentTime])

  useEffect(() => {
    clearInterval(clockTimer.current)
    setDisplayTime(room.currentTime || 0)
    if (!room.isPlaying || !current) return undefined
    const startedAt = Date.now(); const baseTime = room.currentTime || 0
    clockTimer.current = setInterval(() => {
      setDisplayTime(baseTime + (Date.now() - startedAt) / 1000)
      const mediaDuration = current.source === 'youtube' ? yt.current?.getDuration?.() : audio.current?.duration
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) setDuration(mediaDuration)
    }, 250)
    return () => clearInterval(clockTimer.current)
  }, [room.isPlaying, room.currentTime, current?.trackId, current?.videoId])

  useEffect(() => () => { socket.current?.disconnect(); clearInterval(syncTimer.current); clearInterval(clockTimer.current) }, [])

  function createYouTube() {
    if (!window.YT?.Player || !document.getElementById('youtube-player') || yt.current) return
    yt.current = new window.YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId: current?.videoId || '',
      playerVars: { playsinline: 1, controls: 1, rel: 0, origin: window.location.origin, enablejsapi: 1 },
      events: {
        onReady: () => {
          if (current?.source === 'youtube' && room.isPlaying) {
            yt.current.playVideo?.()
          }
          syncTimer.current = setInterval(() => {
            if (room.isPlaying && current?.source === 'youtube') {
              socket.current?.emit('player:action', { type: 'seek', value: yt.current.getCurrentTime() })
            }
          }, 5000)
        },
        onError: event => {
          setError(`This YouTube video cannot play inside the app (error ${event.data}). Choose another search result.`)
          setShowTools(true)
        }
      }
    })
  }

  function connect(action, code, nameToUse = person) {
    const activeName = (nameToUse || person || '').trim()
    if (!activeName) {
      setNameModal({
        open: true,
        action,
        code,
        title: code ? `Join room ${code}` : 'Enter your name',
        subtitle: 'Please enter your name to continue.'
      })
      setModalInputName('')
      return
    }

    setError('')
    if (socket.current) {
      socket.current.disconnect()
    }
    const currentServer = getServerUrl()
    const s = io(currentServer)
    socket.current = s

    s.on('room:state', next => {
      setRoom({
        ...emptyRoom,
        ...next,
        users: next.users || [],
        queue: next.queue || [],
        messages: next.messages || [],
        suggestions: next.suggestions || []
      })
    })

    s.on('connect_error', () => {
      if (window.location.protocol === 'https:' && currentServer.startsWith('http://')) {
        setError(`Browsers block connecting to ${currentServer} from HTTPS. Configure your backend URL below.`)
      } else {
        setError(`Could not connect to server at ${currentServer}.`)
      }
    })

    s.on('connect', () => {
      s.emit(
        action,
        {
          name: activeName,
          roomName: roomName.trim() || 'Listening room',
          ...(code ? { code } : {})
        },
        result => {
          if (result?.error) {
            setError(result.error)
            localStorage.removeItem('tt_room')
            window.history.replaceState(null, '', window.location.pathname)
            s.disconnect()
            setScreen('home')
            return
          }
          const validCode = result.code
          setRoomCode(validCode)
          setJoinCode(validCode)
          setScreen('room')
          // Persist room and name without exiting
          localStorage.setItem('tt_room', validCode)
          localStorage.setItem('tt_person', activeName)
          window.history.replaceState(null, '', `?room=${validCode}`)
        }
      )
    })
  }

  const handleCreateRoom = () => {
    const currentName = person.trim()
    if (!currentName) {
      setNameModal({
        open: true,
        action: 'room:create',
        code: '',
        title: 'Create a listening room',
        subtitle: 'What should your friends call you?'
      })
      setModalInputName('')
      return
    }
    connect('room:create', null, currentName)
  }

  const handleJoinRoom = () => {
    const code = joinCode.trim().toUpperCase()
    if (!code) {
      setError('Please enter a room code.')
      return
    }
    const currentName = person.trim()
    if (!currentName) {
      setNameModal({
        open: true,
        action: 'room:join',
        code,
        title: `Join room ${code}`,
        subtitle: 'Please enter your name to join the listening room.'
      })
      setModalInputName('')
      return
    }
    connect('room:join', code, currentName)
  }

  const submitNameModal = (e) => {
    e?.preventDefault()
    const trimmed = modalInputName.trim()
    if (!trimmed) return
    setPerson(trimmed)
    localStorage.setItem('tt_person', trimmed)
    const { action, code } = nameModal
    setNameModal({ open: false, action: '', code: '', title: '', subtitle: '' })
    connect(action, code, trimmed)
  }

  const leaveRoom = () => {
    localStorage.removeItem('tt_room')
    window.history.replaceState(null, '', window.location.pathname)
    socket.current?.emit('room:leave')
    socket.current?.disconnect()
    socket.current = null
    setRoom(emptyRoom)
    setRoomCode('')
    setScreen('home')
  }

  const sendAction = (type, value) => socket.current?.emit('player:action', { type, value })

  const addYoutube = e => {
    e.preventDefault()
    const value = url.trim()
    if (!value) return
    if (value.includes('youtube.com') || value.includes('youtu.be')) {
      const id = getVideoId(value)
      if (id) socket.current?.emit('queue:add', { source: 'youtube', videoId: id, trackId: id, title: `YouTube video • ${id}`, playNow: true })
      setUrl('')
    } else {
      setQuery(value)
      search(value)
    }
  }

  const addTrack = (track, suggestion = false) => {
    socket.current?.emit(suggestion ? 'queue:add' : 'suggestion:add', track)
  }

  const playTrack = track => {
    socket.current?.emit('queue:add', { ...track, playNow: true })
    setShowTools(true)
  }

  async function search(term = query) {
    if (!term.trim()) return; setSearching(true); setError('')
    try {
      let normalized = []
      if (source === 'audius') {
        const response = await fetch(`${getJiosaavnUrl()}/song/?query=${encodeURIComponent(term.trim())}&lyrics=false&songdata=true`); const items = await response.json()
        normalized = (Array.isArray(items) ? items : []).filter(t => t.media_url).map(t => ({ source: 'jiosaavn', trackId: String(t.id), title: t.song, artist: t.primary_artists || t.singers || 'Unknown artist', audioUrl: t.media_url, imageUrl: t.image, externalUrl: t.perma_url }))
      } else if (source === 'youtube') {
        if (!YOUTUBE_API_KEY) throw new Error('YouTube search key is missing. Add VITE_YOUTUBE_API_KEY to .env and restart Vite.')
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true&maxResults=10&q=${encodeURIComponent(term.trim())}&key=${YOUTUBE_API_KEY}`); const data = await response.json()
        if (data.error) throw new Error(data.error.message || 'YouTube search failed.')
        normalized = (data.items || []).filter(item => item.id?.videoId).map(item => ({ source: 'youtube', videoId: item.id.videoId, trackId: item.id.videoId, title: item.snippet.title, artist: item.snippet.channelTitle, imageUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url }))
      } else {
        if (!JAMENDO_ID) throw new Error('Jamendo key is missing. Add it to .env and restart Vite.')
        const response = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_ID}&format=json&limit=10&namesearch=${encodeURIComponent(term.trim())}`); const data = await response.json()
        if (data.headers?.status !== 'success') throw new Error(data.headers?.error_message || 'Jamendo rejected this client ID.')
        normalized = (data.results || []).map(t => ({ source: 'jamendo', trackId: String(t.id), title: t.name, artist: t.artist_name, audioUrl: t.audio, imageUrl: t.album_image || t.image }))
        if (!normalized.length) {
          const fallbackResponse = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_ID}&format=json&limit=10&order=popularity_total`); const fallback = await fallbackResponse.json()
          normalized = (fallback.results || []).map(t => ({ source: 'jamendo', trackId: String(t.id), title: t.name, artist: t.artist_name, audioUrl: t.audio, imageUrl: t.album_image || t.image }))
        }
      }
      setResults(normalized); if (!normalized.length) setError('No songs found. Try another search.')
    } catch (e) { setResults([]); setError(e.message || 'Music search failed.') } finally { setSearching(false) }
  }

  const invite = () => { navigator.clipboard?.writeText(`${location.origin}?room=${roomCode}`); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const sendChat = e => { e.preventDefault(); if (chat.trim()) socket.current?.emit('chat:send', chat); setChat('') }

  // Modal Component for asking user name when joining
  const NameModalElement = nameModal.open && (
    <div className="name-modal-overlay">
      <div className="name-modal">
        <h2>{nameModal.title}</h2>
        <p>{nameModal.subtitle}</p>
        <form onSubmit={submitNameModal}>
          <input
            autoFocus
            value={modalInputName}
            onChange={e => setModalInputName(e.target.value)}
            placeholder="Your name"
          />
          <div className="name-modal-actions">
            {screen === 'home' && (
              <button
                type="button"
                className="secondary"
                onClick={() => setNameModal({ open: false, action: '', code: '', title: '', subtitle: '' })}
              >
                Cancel
              </button>
            )}
            <button type="submit" className="primary" disabled={!modalInputName.trim()}>
              Join Room <span>→</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )

  if (screen === 'home') {
    return (
      <main className="landing">
        {NameModalElement}
        <div className="landing-inner">
          <header className="brandbar">
            <div className="brand">
              <span className="brand-mark">♫</span>
              <span>TogetherTunes</span>
            </div>
            <span className="eyebrow">Shared listening rooms</span>
          </header>
          <section className="landing-grid">
            <div className="landing-copy">
              <p className="eyebrow accent">LONG-DISTANCE LISTENING</p>
              <h1>One playlist.<br /><em>Two places.</em></h1>
              <p>Make the distance feel smaller. Start a room, invite your person, and listen to every song in perfect time.</p>
              <div className="feature-row">
                <span>✦ Live sync</span>
                <span>✦ Room chat</span>
                <span>✦ Free music</span>
              </div>
            </div>
            <div className="join-card">
              <label>Your name</label>
              <input
                value={person}
                onChange={e => {
                  setPerson(e.target.value)
                  localStorage.setItem('tt_person', e.target.value)
                }}
                placeholder="What should we call you?"
              />
              <label>Give your room a mood</label>
              <input
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
                placeholder="Late night drive"
              />
              <button className="primary wide" onClick={handleCreateRoom}>
                Create a listening room <span>→</span>
              </button>
              <div className="divider">
                <span>or join a friend</span>
              </div>
              <div className="join-row">
                <input
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="ROOM CODE"
                />
                <button className="secondary" onClick={handleJoinRoom}>
                  Join
                </button>
              </div>
              {error && (
                <div style={{ marginTop: '12px' }}>
                  <p className="error-text">{error}</p>
                  <button
                    type="button"
                    className="secondary"
                    style={{ marginTop: '8px', width: '100%', height: '36px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => {
                      const cur = getServerUrl()
                      const next = prompt('Enter your deployed backend server URL (e.g. https://your-server.onrender.com):', cur)
                      if (next && next.trim()) {
                        localStorage.setItem('tt_server_url', next.trim())
                        window.location.reload()
                      }
                    }}
                  >
                    ⚙️ Set Deployed Backend URL
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    )
  }

  const isHost = room.hostId === socket.current?.id; const artwork = artFor(current)
  return (
    <main className="room-app" style={artwork ? { '--art': `url(${artwork})` } : {}}>
      {NameModalElement}
      {showExitConfirm && (
        <div className="name-modal-overlay" onClick={() => setShowExitConfirm(false)}>
          <div className="name-modal" onClick={e => e.stopPropagation()}>
            <h2>Exit Listening Room?</h2>
            <p>Are you sure you want to leave <strong>{room.name || 'this room'}</strong>? Your music sync and shared room session will stop.</p>
            <div className="name-modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setShowExitConfirm(false)}
              >
                Stay in room
              </button>
              <button
                type="button"
                className="primary danger"
                onClick={() => {
                  setShowExitConfirm(false)
                  leaveRoom()
                }}
              >
                Exit Room <span>→</span>
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="room-backdrop" />
      <div className="room-shell">
        <header className="room-topbar">
          <button className="exit-btn" onClick={() => setShowExitConfirm(true)} title="Exit listening room">
            <span>←</span> Exit
          </button>
          <div className="room-title">
            <span className="eyebrow">LISTENING ROOM</span>
            <strong>{room.name}</strong>
          </div>
          <button className="icon-button" onClick={() => setShowTools(!showTools)}>•••</button>
        </header>

        <div className="room-code-line">
          <span>{room.users.length} listening together</span>
          <button onClick={invite}>{copied ? 'Link copied' : `Invite · ${roomCode}`}</button>
        </div>

        <section className="hero-player">
          <div className="hero-art-wrap">
            <div className="hero-art" style={artwork ? { backgroundImage: `url(${artwork})` } : {}}>
              {!artwork && <span>♫</span>}
            </div>
          </div>
          <div className="liked-pill">
            {room.users.slice(0, 3).map(u => <span className="avatar" key={u.id}>{u.name[0]}</span>)}
            <span>Listening with {room.users[0]?.name || 'your friend'} ♥</span>
          </div>
          <div className="track-panel">
            <div className="track-copy">
              <span className="eyebrow">NOW PLAYING · {current?.source === 'youtube' ? 'YOUTUBE' : current?.source?.toUpperCase() || 'READY'}</span>
              <h2>{current?.title || 'Choose a song to begin'}</h2>
              <p>{current?.artist || 'Your shared room is ready'}</p>
            </div>
            <div className="track-actions">
              <button onClick={() => sendAction(room.isPlaying ? 'pause' : 'play', current?.source === 'youtube' ? yt.current?.getCurrentTime?.() : audio.current?.currentTime)} className="play-button" disabled={!current}>
                {room.isPlaying ? '❚❚' : '▶'}
              </button>
              <button onClick={() => socket.current?.emit('queue:next')} className="next-button">Next ›</button>
            </div>
            <div className="progress-wrap">
              <input
                type="range"
                className="progress-range"
                min={0}
                max={Math.max(1, duration || 1)}
                step={0.1}
                value={isScrubbing ? scrubTime : Math.min(displayTime, duration || 0)}
                style={{ '--progress': `${duration > 0 ? Math.min(100, Math.max(0, ((isScrubbing ? scrubTime : displayTime) / duration) * 100)) : 0}%` }}
                disabled={!current}
                onPointerDown={e => {
                  setIsScrubbing(true)
                  setScrubTime(Number(e.target.value))
                }}
                onChange={e => {
                  setScrubTime(Number(e.target.value))
                }}
                onPointerUp={e => {
                  commitSeek(e.target.value)
                }}
                onKeyUp={e => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    commitSeek(e.target.value)
                  }
                }}
              />
            </div>
            <div className="time-row">
              <span>{formatTime(isScrubbing ? scrubTime : displayTime)}</span>
              <span>{isScrubbing ? 'Seeking...' : (current ? 'Together in sync' : 'Add a song below')}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          <div className="hidden-player">
            <div id="youtube-player" />
            <audio
              ref={audio}
              onLoadedMetadata={() => { if (audio.current?.duration) setDuration(audio.current.duration) }}
              onDurationChange={() => { if (audio.current?.duration) setDuration(audio.current.duration) }}
              controls
            />
          </div>
        </section>

        <section className="tool-drawer">
          <div className="drawer-tabs">
            <button className={showTools ? 'active' : ''} onClick={() => setShowTools(!showTools)}>{showTools ? 'Hide music tools' : 'Search & queue'}</button>
            <button onClick={invite}>Share room ↗</button>
          </div>
          {showTools && (
            <div className="tools-grid">
              <div className="music-tools">
                <div className="provider-tabs">
                  <button className={source === 'audius' ? 'active' : ''} onClick={() => setSource('audius')}>JioSaavn</button>
                  <button className={source === 'youtube' ? 'active' : ''} onClick={() => setSource('youtube')}>YouTube</button>
                </div>
                {source === 'youtube' ? (
                  <form onSubmit={addYoutube} className="search-row">
                    <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Search YouTube music or paste a link" />
                    <button className="primary" type="submit">{searching ? '...' : 'Search'}</button>
                  </form>
                ) : (
                  <form onSubmit={e => { e.preventDefault(); search() }} className="search-row">
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search JioSaavn music" />
                    <button className="primary" type="submit">{searching ? '...' : 'Search'}</button>
                  </form>
                )}
                {error && <p className="error-text">{error}</p>}
                <div className="search-results">
                  {results.map((t, idx) => {
                    const isSelected = current && ((current.trackId && current.trackId === t.trackId) || (current.videoId && current.videoId === t.videoId))
                    return (
                      <div
                        className={`result-row ${isSelected ? 'playing' : ''}`}
                        key={`${t.source}-${t.trackId || t.videoId}-${idx}`}
                        onClick={() => playTrack(t)}
                        title="Click to play"
                      >
                        <img src={t.imageUrl || 'https://placehold.co/38x38?text=♪'} alt="" />
                        <div>
                          <strong>{t.title}</strong>
                          <span>{t.artist}</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); playTrack(t) }}
                          className="play-small"
                          title="Play now"
                        >
                          ▶
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); addTrack(t) }}
                          className="suggest"
                          title="Suggest to room"
                        >
                          Suggest
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); addTrack(t, true) }}
                          className="add-small"
                          title="Add to queue"
                        >
                          +
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="queue-tools">
                <div className="section-heading">
                  <span>Up next</span>
                  <small>{room.queue.length} tracks</small>
                </div>
                {room.queue.map((t, i) => (
                  <div className={`queue-row ${i === room.currentIndex ? 'playing' : ''}`} key={`${t.trackId || t.videoId}-${i}`}>
                    <img src={artFor(t) || 'https://placehold.co/38x38?text=♪'} alt="" />
                    <button onClick={() => sendAction('load', i)}>
                      <strong>{t.title}</strong>
                      <span>{t.artist || t.source}</span>
                    </button>
                    <button onClick={() => socket.current?.emit('queue:remove', i)}>×</button>
                  </div>
                ))}
                {!room.queue.length && <p className="empty-copy">Your next song will appear here.</p>}
              </div>
            </div>
          )}
        </section>

        <section className="bottom-grid">
          <div className="suggestions">
            <div className="section-heading">
              <span>Room suggestions</span>
              <small>{room.suggestions.length} waiting</small>
            </div>
            {room.suggestions.length ? (
              room.suggestions.slice(-3).reverse().map(s => (
                <div className="suggestion-row" key={s.id}>
                  <div>
                    <strong>{s.title}</strong>
                    <span>{s.artist} · suggested by {s.by}</span>
                  </div>
                  <button onClick={() => socket.current?.emit('queue:add', { ...s, playNow: true })}>Play</button>
                </div>
              ))
            ) : (
              <p className="empty-copy">Ask your friend to suggest the next vibe.</p>
            )}
          </div>
          <div className="chat-box">
            <div className="section-heading">
              <span>Room chat</span>
              <small>{room.users.length} online</small>
            </div>
            <div className="messages">
              {room.messages.map(m => (
                <div key={m.id}>
                  <b>{m.name}</b>
                  <p>{m.text}</p>
                </div>
              ))}
              {!room.messages.length && <p className="empty-copy">Say hello 👋</p>}
            </div>
            <form onSubmit={sendChat}>
              <input value={chat} onChange={e => setChat(e.target.value)} placeholder="Write a message..." />
              <button>Send</button>
            </form>
          </div>
        </section>
        {isHost && (
          <button className="rename-room" onClick={() => { const next = prompt('New room name', room.name); if (next) socket.current?.emit('room:rename', next) }}>
            Rename room
          </button>
        )}
        <button className="exit-room-footer" onClick={() => setShowExitConfirm(true)}>
          Leave room
        </button>
      </div>
    </main>
  )
}
