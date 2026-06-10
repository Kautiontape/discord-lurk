# lurk

Catch up on Discord channels — exports a channel's messages to JSON since the
last time you looked. Live at [lurk.kautiontape.com](https://lurk.kautiontape.com).

A thin FastAPI proxy in front of the Discord API plus a static single-page
frontend. The backend forwards your token to Discord on each request and never
stores it.

## Stack

- FastAPI + uvicorn (`app.py`)
- Static frontend in `static/`
- Docker + docker compose (deployment on ktn, port 8111)

## Develop

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Then open http://127.0.0.1:8000.

## Endpoints

- `POST /api/channel` — channel metadata for a token + channel ID
- `POST /api/messages` — raw messages for a channel (`after`/`before`/`limit`)
- `POST /api/catchup` — fetch new messages since the last pull, clean them, append
  to the per-channel archive, advance the last-seen pointer. Body:
  `{ token, channel_id, guild_id }`. Returns the cleaned new slice + counts.
- `GET /api/export?channel_id=&guild_id=&scope=all|since` — the archive as one
  downloadable JSON document (`since` = only the most recent pull).
- `GET /api/channels` — registered channels. `GET /api/log` — transparency log.

## Data

Archives and state live under `data/` (override with `LURK_DATA_DIR`):
`data/archives/<guild>/<channel>.jsonl`, `data/state.json`, `data/channels.json`,
`data/log.jsonl`. The Discord token is used per-request and never written to disk.

## Browser extension

`extension/` is a Chrome MV3 extension that captures the Discord channel you're
viewing and calls `POST /api/catchup` on your configured lurk instance — no
DevTools, no copy-pasting ids. See `extension/README.md` to load it.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

## Deploy

Pushes to `main` deploy automatically via the self-hosted ktn runner
(`.github/workflows/deploy.yml`): it pulls `/opt/services/discord-lurk`,
rebuilds the image, and restarts the container.
