# TogetherTunes

A responsive shared YouTube listening room built with React, Vite, Tailwind CSS, Express, and Socket.IO.

## Run locally

```bash
npm install
npm run dev:all
```

Open `http://localhost:5173` in two browser windows, create a room in one, and join with the room code in the other.

The app's main search uses the cloned `sayamusicapi` worker for Apple/iTunes metadata and previews, Audius streams, and JioSaavn results. `npm run dev:all` starts it automatically. If you prefer separate terminals:

```bash
cd sayamusicapi
npm install
npm run dev
```

It runs at `http://127.0.0.1:8787` by default. The frontend reads this from `VITE_SAYA_API_URL`.

Full-track JioSaavn search is provided by the cloned `jiosaavn-api` service at `http://127.0.0.1:8000`. It requires Python 3.11+ dependencies and is unofficial; availability can change if JioSaavn changes its internal service.

## Environment

Copy `.env.example` to `.env` if the backend is not running on the default local URL:

```env
VITE_SERVER_URL=http://localhost:3001
VITE_SAYA_API_URL=http://127.0.0.1:8787
```

## YouTube implementation

The app supports YouTube URL playback through the official YouTube IFrame Player API. YouTube text search requires a `VITE_YOUTUBE_API_KEY`; the cloned API is used for the main no-key music search. The app does not download, proxy, or copy YouTube audio.

## Current MVP

- Responsive laptop/mobile interface
- Create and join private room codes
- YouTube queue
- Synchronized load, play, pause, seek, and next controls
- Connected listener badges
- Real-time chat
- In-memory server state for development

## Production next steps

- Persist rooms and accounts with Supabase or Firebase
- Add authentication and room ownership
- Add host permissions and better clock synchronization
- Deploy the frontend to Vercel and the server to Render or Railway
