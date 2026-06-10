# lurk capture extension (Chrome MV3)

One-click capture of the Discord channel you're viewing, sent to your own lurk
instance's `POST /api/catchup`.

## Install (unpacked)

1. Run a lurk instance (see the repo root README) — locally it serves on
   `http://localhost:8111`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this `extension/` folder.
3. (Optional) Open the extension's **Options** to point it at a different endpoint
   (e.g. your own server). Saving requests permission to talk to that host.

## Use

1. Open `discord.com` in the browser (not the desktop app) and go to a channel.
2. Click the lurk toolbar icon.
3. Click **Catch me up on this channel**. New messages since your last pull are
   fetched, cleaned, and archived by your lurk instance; the popup shows the counts.

## What it sends

Only `{ token, guild_id, channel_id }` to your configured endpoint. The token is
read per-click and is never stored by the extension. DMs (`@me`) are sent as
`guild_id: "dm"`.

## Caveat

The token is read from Discord's running web client (its webpack `getToken()`
module), injected into the page's MAIN world from the background worker; the old
same-origin-iframe `localStorage` read is kept only as a fallback for older
builds. Discord changes its internals periodically, so if both reads fail the
popup says so — fall back to the lurk web app's manual-token flow.

## Tests

The pure helpers have Node tests:

```bash
node --test 'extension/test/parse.test.js' 'extension/test/endpoint.test.js'
```
