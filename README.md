# Watch Party (Stremio Relay + Sync + Subtitles)

A lightweight watch-party app for syncing playback between viewers.

## What it does

- Syncs play / pause / seek across viewers (WebSocket room)
- Supports **relay mode** (host PC streams for everyone)
- Supports **local-first** (use local stream if available, fallback to relay)
- Includes mini chat
- Extracts subtitle tracks from stream and converts selected track to browser VTT

---

## Requirements (Host)

- Windows (or Node-compatible OS)
- Node.js 18+
- OpenSSH client (for localhost.run tunnel)
- FFmpeg + FFprobe (needed for subtitle track extraction/conversion)

Install FFmpeg on Windows:

```powershell
winget install --id Gyan.FFmpeg --scope user --accept-package-agreements --accept-source-agreements
```

---

## Run locally

```powershell
npm install
node server.js
```

App runs on:

- `http://localhost:3456`

Health check:

- `http://localhost:3456/health`

---

## Expose publicly (quick/free)

In a second terminal:

```powershell
ssh -o StrictHostKeyChecking=accept-new -R 80:localhost:3456 nokey@localhost.run
```

It prints a public URL like:

- `https://xxxx.lhr.life`

Share that URL.

> Note: free anonymous tunnel domains rotate / can expire.

---

## Stable domain (localhost.run)

For a fixed subdomain, localhost.run requires:

1. Account on localhost.run
2. SSH key linked in their admin panel
3. Connect using your plan/account form (per their docs)

Without this, tunnel links are temporary.

---

## Basic usage

### Host

1. Open public URL
2. Set room + stream URL
3. Keep Relay ON if you want host-streamed mode
4. Click **Join room**
5. Click **Copy room link** and share it with viewers

### Guest

1. Open invite link
2. It auto-joins room
3. They can optionally open **Show setup** for advanced controls

---

## Subtitles workflow

1. Paste stream URL
2. Click **Load subtitle tracks from stream**
3. Select a track from dropdown
4. Subtitle is auto-applied

The app also attempts auto-load/auto-pick in invite/autojoin flows.

---

## Local-first behavior

If enabled:

- Viewer tries local source first (better quality)
- If local source fails, auto-fallback to relay source

Useful when some people have local stream access and others are remote.

---

## Limitations

- Browser subtitle support depends on stream/container/codec
- Host upload bandwidth limits relay quality for viewers
- If host PC sleeps/stops, relay viewers lose stream
- Temporary tunnel links can go down and need rehosting

---

## Create GitHub repo (manual)

```powershell
git init
git add .
git commit -m "Initial watch-party release"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/<YOUR_REPO>.git
git push -u origin main
```

Any host can run:

```powershell
git clone https://github.com/<YOUR_USER>/<YOUR_REPO>.git
cd <YOUR_REPO>
npm install
node server.js
```
