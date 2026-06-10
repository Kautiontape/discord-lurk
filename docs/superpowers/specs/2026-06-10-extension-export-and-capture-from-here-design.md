# Design: extension export + "capture from here"

Date: 2026-06-10
Status: approved, pre-implementation

## Context

`lurk` catches you up on Discord channels without opening Discord. The MV3
browser extension (`extension/`) captures the channel you're viewing and POSTs to
the backend's `/api/catchup`, which fetches new messages, cleans them, archives
them server-side, and returns counts. The backend also exposes `/api/export`
(downloadable JSON of the archive) and `/api/messages` (raw paginated messages,
used by the standalone web app in `static/index.html`).

Two gaps motivated this work:

1. The extension catches up but gives you no way to get the messages out of it,
   even though `/api/catchup` already returns the cleaned `messages` array
   (`app.py:142`) and the background worker simply discards them.
2. Capturing from a specific point requires copying a message id into the web
   app's "from message id…" flow (`static/index.html:670`). We want to pick that
   message directly from Discord.

This is **Phase 1 plumbing only**. No summarization / LLM work (Phase 2, where the
LLM runs, remains undecided in `PLAN.md`). "Capture from here" produces the
messages for that range; turning them into a summary is out of scope.

## Goals

- One-click **download of the just-caught messages** from the extension popup.
- A **Discord DOM hook** to capture messages from a chosen message forward to now,
  delivered as a downloaded JSON file.
- Reuse existing backend machinery (`discord_api.fetch_after`, dedupe-on-archive)
  rather than adding parallel fetch logic.

## Non-goals

- No summarization / LLM calls.
- No copy-to-clipboard, full-archive download, or "open web app" from the popup
  (only "download new-since-last JSON" was requested).
- No change to the standalone web app (`static/index.html`).

## Feature 1 — popup download of the just-caught messages

**Behavior.** After a successful catch-up, the popup shows a **"download json"**
link next to the success status. Clicking it downloads the messages this catch-up
fetched as `lurk-<channelId>-<timestamp>.json`.

**Implementation.**
- `background.js`: include the backend response's `messages` array in the object
  returned to the popup (today it returns only counts).
- `popup.js` / `popup.html`: on `result.ok`, if `result.messages?.length`, build a
  `Blob` of `JSON.stringify(messages, null, 2)`, create an object URL, and render
  an `<a download="lurk-<channelId>-<ts>.json">` link. Revoke the prior object URL
  before creating a new one. If zero messages, no link (status already says
  "0 new").
- No new permissions: a Blob download from the extension popup page is allowed.
  The popup stays open while the user clicks.

## Feature 2 — backend: anchored capture

**Behavior.** `/api/catchup` gains an optional `after` snowflake. When present, the
catch-up fetches messages newer than `after` (via the existing
`discord_api.fetch_after`) instead of from the saved cursor.

**State semantics (important).** An anchored capture:
- **Archives** the fetched messages via `archive.append_messages` (deduped by id,
  `archive.py:30`), so overlap with already-archived messages no-ops.
- **Does NOT call `archive.update_pull`** — it never advances `last_seen_id` or
  `last_pull_first_id`. This is deliberate: anchoring at a message *older* than the
  cursor and then advancing the cursor would permanently skip the gap between them.
  Routine catch-up is therefore completely unaffected by from-here captures.
- Still `register_channel` and `append_log`, with the log entry marked
  `anchored: true`.

**Implementation (`app.py`).**
- `CatchupRequest` gains `after: Optional[str] = None`.
- Validate `after` as a snowflake when present (reuse `SNOWFLAKE_RE` via the
  existing `_validate` snowflakes map).
- Branch:
  ```
  anchored = req.after is not None
  if anchored:
      raw = await discord_api.fetch_after(req.token, req.channel_id, req.after)
  elif last_seen:
      raw = await discord_api.fetch_after(req.token, req.channel_id, last_seen)
  else:
      raw = await discord_api.fetch_recent(req.token, req.channel_id, backfill_limit())
  ```
- After cleaning + `append_messages`: call `update_pull` only when `not anchored`.
- Response shape unchanged (already includes `messages`).

**Tests (`tests/test_endpoints.py`).** Add cases:
- anchored catch-up calls `fetch_after` with the supplied `after`,
- anchored catch-up does **not** modify `state.json` (`last_seen_id` unchanged),
- anchored catch-up still archives + returns `messages`,
- invalid `after` (non-snowflake) → 400.

## Feature 2 — extension: the Discord hook

A new **isolated-world** content script, `extension/discord.js`, registered in
`manifest.json` `content_scripts` for `https://discord.com/*`. (Re-adds a
content_scripts block; token reading stays in the background via the existing
MAIN-world `executeScript`, so this script needs no page-world access.)

**Reading the message id.** From the stable `id="chat-messages-{channelId}-{messageId}"`
attribute on the message row — never Discord's hashed CSS classes. The trailing
digit groups yield `channelId` and `messageId`; both are sent to the background so
the capture stays correct even in threads/search where the viewed channel differs
from the message's channel.

**Primary path — native menu injection.**
- A capture-phase `contextmenu` listener records the message row under the pointer
  (`event.target.closest('[id^="chat-messages-"]')`).
- A `MutationObserver` on `document.body` watches for Discord's context menu
  appearing (`[role="menu"]`) and inserts a **"lurk: capture from here"** item
  styled to match, wired to activate the capture for the recorded message.

**Fallback path — hover button.**
- The script tracks whether injection has ever succeeded. If a right-click occurs
  on a message and, within ~400 ms, no injectable `[role="menu"]` is found (or the
  item can't be inserted), it flips to **fallback mode** for the rest of the
  session.
- In fallback mode, a `MutationObserver` attaches a small `⟳ from here` button to
  each message row (`li[id^="chat-messages-"]`), revealed on hover via inline
  styles, wired to the same capture action.
- Inline styles only (set on created elements) — no injected stylesheet, avoiding
  Discord CSP friction.

**Activation → capture.** On click of either affordance, the content script sends
`{ type: 'LURK_CAPTURE_FROM', messageId, channelId }` to the background and shows a
small in-page toast ("capturing…"). On the response it either downloads the JSON
in-page (Blob + `<a download>`, same naming as Feature 1) and updates the toast to
"captured N messages", or shows the error text.

## Feature 2 — wiring (`background.js`)

- Refactor `handleCatchup(tabId)` → `handleCatchup(tabId, after = null)`:
  - resolves the channel from `chrome.tabs.get(tabId).url` (Feature already does
    this), but **prefers a `channelId` passed by the caller** when present (for the
    from-here path, so threads/search are correct);
  - reads the token via the existing MAIN-world `executeScript`;
  - POSTs `{ token, guild_id, channel_id, after? }`;
  - returns `{ ok, ...counts, messages }` (now including `messages`).
- `LURK_CATCHUP` (popup) → `handleCatchup(tabId)` as today.
- New `LURK_CAPTURE_FROM` → `handleCatchup(tabId, after=messageId)` with the
  caller-supplied `channelId`; returns `messages` so the content script can
  download them.

## Data flow

```
Popup catch-up:
  popup → LURK_CATCHUP(tabId) → bg.handleCatchup(tabId)
    → executeScript(MAIN) token → POST /api/catchup
    → {counts, messages} → popup renders "download json"

Capture from here:
  discord.js (menu item / hover button) captures messageId+channelId
    → LURK_CAPTURE_FROM → bg.handleCatchup(tabId, after=messageId, channelId)
    → executeScript(MAIN) token → POST /api/catchup {after}
    → {messages} → discord.js downloads JSON + toast
```

## Error handling

- Backend: invalid `after` → 400 "invalid after"; Discord errors propagate through
  the existing `_as_http` mapping.
- Extension: existing background error strings reused ("Could not read the Discord
  tab…", token-null message, lurk-unreachable). The content script surfaces
  `result.error` in its toast.
- Hook robustness: if `discord.js` can't find a message id for an activation, it
  toasts "couldn't identify the message — try again" and no request is sent.

## Files touched

| File | Change |
|------|--------|
| `app.py` | `after` field on `CatchupRequest`; anchored branch; skip `update_pull` when anchored; `anchored` log marker |
| `tests/test_endpoints.py` | anchored-capture cases (calls `fetch_after`, no state change, archives, bad-`after` 400) |
| `extension/manifest.json` | re-add `content_scripts` block for discord.com (`discord.js`) |
| `extension/discord.js` | **new** — context-menu injection + hover-button fallback + id reading + download + toast |
| `extension/background.js` | `after` param + caller `channelId`; `LURK_CAPTURE_FROM` handler; pass `messages` through |
| `extension/popup.js`, `extension/popup.html` | "download json" link on success |

## Open questions

None outstanding. Resolved during brainstorming:
- "Summary from here" = capture only, no LLM (Phase 1).
- Popup export = download new-since-last JSON only.
- Hook = native-menu injection primary, hover-button fallback.
- Anchored capture does not move the routine cursor.
