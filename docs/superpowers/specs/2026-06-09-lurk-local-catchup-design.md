# lurk — local catch-up with frictionless capture (design)

Date: 2026-06-09

## Problem

The current lurk web app works but is clunky: you dig your Discord token out of
DevTools, copy channel IDs around, add channels by hand, click export, get a raw
JSON file, then feed that JSON to an LLM yourself. The main use case is keeping
up with high-volume servers — TTRPG campaigns especially, where a lot happens
and the history gets confusing without help.

This design covers a self-hostable version of lurk that:

- runs on a host you control (your laptop *or* your own server),
- captures the token and current channel automatically via a browser extension,
- pulls only what's new since you last looked,
- cleans the messages into a compact, LLM-friendly JSON archive,
- and surfaces a prominent consent pathway about the Discord ToS / account-ban
  risk of using a user token.

It deliberately stops at clean files. In-app summarization is a later phase.

## Goals

- One-click "catch me up on this channel," no DevTools, no copy-pasting IDs.
- Cleaned, token-efficient JSON suitable to drop into an LLM conversation
  alongside prior context.
- A running per-channel archive so "catch me up" means "everything since the
  marker."
- An unmissable consent gate about user-token / self-bot ban risk.
- Single codebase that runs identically locally or on the user's server; the
  extension chooses where to send.

## Non-goals (explicitly out of scope)

- **In-app LLM summaries.** Deferred to a later phase. This build produces files.
- **Redaction / anonymization of other people's messages.** Consent here is
  scoped to ToS / account-ban risk, not third-party privacy tooling.
- **Multi-user / hosting-for-others.** Single-user assumption: it's your host,
  your campaigns, your archive.

## Architecture

Three components, with the lurk app as the hub.

### 1. Browser extension (capture arm)

- Injects/has a "Catch me up" action while you're viewing a Discord channel.
- Content script reads the Discord token from the client (Discord scrubs the
  direct `localStorage` accessor, so use the standard iframe-`contentWindow`
  technique) and reads `guild_id` / `channel_id` from the URL
  (`discord.com/channels/<guild>/<channel>`).
- POSTs `{ token, guild_id, channel_id }` to `<endpoint>/api/catchup`.
- **Options page** sets the lurk endpoint. Default `http://localhost:8111`;
  settable to `https://lurk.kautiontape.com` or any host the user trusts.
- After a pull, opens the app to the result or shows a small "got N new
  messages" confirmation.

### 2. lurk app (hub)

The existing FastAPI app (`app.py` + `static/`), extended. It performs the
Discord fetch, cleans the JSON, appends to the per-channel archive, advances the
last-seen pointer, and serves the consent / review / export UI. Runs wherever
the extension points — laptop or server, same code.

### 3. On-disk archive

Lives on whichever host runs the app. Per-channel cumulative history plus a
small state file and a saved-channels list.

### Token handling (carried over, load-bearing)

The token is used **per-request and never written to disk.** The extension holds
it only long enough to forward it; the backend uses it for the fetch and drops
it. The configurable endpoint changes *where the fetch happens*, never *where
the token rests*. Running on the server means message archives live on the
server; the token still never does.

## Consent / ToS pathway

The priority concern: make the **user-token = self-bot = bannable** risk
impossible to miss.

- **First-run gate (app):** a modal stating plainly that using your own user
  token to read messages is a self-bot, which violates Discord's ToS and *can
  get your account banned*; that lurk runs on your own host, uses the token only
  for the fetch, and never stores it. Explicit checkbox + "I understand the
  risk" button. Acknowledgment persists; a compact banner remains visible each
  session.
- **Extension:** the same warning on install and in the popup. The "Catch me up"
  action shows **where it's about to send** (the configured endpoint) and that
  it's reading your token — the extension is the part that actually touches the
  token inside the Discord tab.
- **Transparency log:** every pull records channel, count, time, and endpoint, so
  there's an inspectable trail and nothing is hidden.

## Capture flow

1. You're viewing a Discord channel; click "Catch me up."
2. Content script reads the token + `guild_id` / `channel_id`.
3. It POSTs `{ token, guild_id, channel_id }` to `<endpoint>/api/catchup`.
4. The app fetches everything since your last pull; the extension opens the app
   to the result or shows a "got N new messages" confirmation.

CORS on `/api/catchup` is scoped to the extension origin so the browser permits
the cross-origin POST.

## Backend: fetch, clean, archive, state

### Endpoints

- `POST /api/catchup` (new): the one-click path. Looks up `last_seen_id` for the
  channel, pages the Discord API with `after=last_seen_id` (100 at a time,
  looping until drained), cleans each message, appends to the archive, sets
  `last_seen_id` to the newest fetched ID, and returns the new slice + counts +
  archive location. Auto-registers the channel in the saved-channels list.
- `POST /api/messages`, `POST /api/channel` (existing): retained for manual use.
- `GET /api/export` (new): emits a single clean JSON document — whole archive or
  just-since-last-catch-up. See Export.

### Cleaned message shape

Lean and token-efficient:

```json
{
  "id": "123…",
  "ts": "2026-06-09T20:42:00Z",
  "author": { "id": "…", "name": "Alice", "bot": false },
  "content": "text with @mentions resolved to names",
  "reply_to": "122…",
  "thread": { "id": "…", "name": "The Crypt" },
  "attachments": [ { "filename": "map.png", "url": "https://…" } ],
  "embeds": [ { "title": "Avrae", "description": "Attack roll: 18", "fields": [] } ]
}
```

- Mentions (`<@id>`, `<#id>`, `<@&id>`) resolved to names best-effort from the
  payload's resolved entities.
- Reactions dropped as noise.
- `ts` derived from the snowflake or the API `timestamp`.

### Storage layout

All under a gitignored `data/`:

- `data/archives/<guild_id>/<channel_id>.jsonl` — per-channel archive, append-only
  JSONL, deduped by message ID.
- `data/state.json` — per channel: `last_seen_id`, channel + guild names,
  `last_pull_at`.
- `data/channels.json` — saved/named channels; the extension auto-registers each
  one it captures.

JSONL is chosen for cheap appends and easy dedup on very active channels; export
consolidates it into a single JSON document on demand.

### Pagination & state

Discord message IDs are time-ordered snowflakes. Fetch with `after=last_seen_id`
in batches of 100, looping until a batch returns fewer than 100. Sort ascending
before storing. After a successful pull, `last_seen_id = max(fetched ids)`. A
first-ever pull with no stored marker fetches a bounded recent backfill rather
than the entire channel.

## Export & LLM hand-off

This build stops at clean files, not summaries. `GET /api/export` produces a
single clean JSON document — the whole archive or just since the last catch-up —
with a download button and a "copy to clipboard" in the UI so it drops straight
into a Claude/ChatGPT conversation alongside prior context. In-app
summarization is **Phase 2, deferred.**

## TTRPG-specific handling

The cleaning is tuned for the confusing-high-volume-channel case:

- **Threads** preserved (scenes often live in them); export can group by thread
  so a scene reads as a unit.
- **Reply chains** preserved via `reply_to`.
- **Mentions resolved** to names so it reads as "Alice", not `<@123>`.
- **Bot vs human** distinguished via `author.bot`.
- **Dice-bot embeds** preserved (Avrae, Dice Maiden — roll results live in embed
  title/description/fields, so we keep those rather than dropping embeds).

## Testing

- Unit tests on the cleaning transform: raw Discord payload fixtures → cleaned
  JSON (mentions resolution, embeds, attachments, reply_to, thread).
- Unit tests on pagination + state advancement (`after` looping, `last_seen_id`
  update, bounded first-pull backfill).
- Unit tests on archive append + dedup by message ID.
- FastAPI endpoint tests with mocked `httpx` for `/api/catchup` and `/api/export`.
- The extension's token-grab is verified manually against a live Discord tab
  (not automatable).

## Open items for implementation planning

- Exact bound for a first-ever backfill (e.g. last N messages or last X days).
- Extension manifest version / browser target (Chrome MV3 assumed).
- CORS configuration shape for the extension origin alongside the existing static
  mount.
