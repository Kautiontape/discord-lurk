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

- `POST /api/channel` — channel metadata for a given token + channel ID
- `POST /api/messages` — messages for a channel, with `after`/`before`/`limit`

## Deploy

Pushes to `main` deploy automatically via the self-hosted ktn runner
(`.github/workflows/deploy.yml`): it pulls `/opt/services/discord-lurk`,
rebuilds the image, and restarts the container.
