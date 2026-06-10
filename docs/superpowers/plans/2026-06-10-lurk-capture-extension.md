# lurk Capture Extension Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 browser extension that captures the Discord user token and the current guild/channel from a discord.com tab and POSTs them to a configurable lurk instance's `POST /api/catchup`, so catching up is one click.

**Architecture:** Three runtime roles. A **content script** (on discord.com) reads the token via the same-origin-iframe `localStorage` technique and parses the channel/guild from the URL. A **background service worker** orchestrates: on request it asks the content script to capture, then POSTs `{token, guild_id, channel_id}` to the configured endpoint and returns the result. A **popup** is the UI — a Discord-ToS/self-bot consent gate, the configured endpoint shown for transparency, a "Catch me up" button, and a status line. An **options page** sets the endpoint (default `http://localhost:8111`) and requests the matching host permission. Fiddly string logic (URL parsing, endpoint normalization) lives in two pure helper modules with Node-runnable tests; everything browser-bound is verified manually against a real logged-in Discord tab.

**Tech Stack:** Chrome MV3 (manifest v3), vanilla JS (no build step), `chrome.storage.sync`/`chrome.permissions`/`chrome.tabs`/`chrome.runtime` APIs, Node 22 `node:test`/`node:assert` for the pure-helper tests.

**Depends on:** Plan A (on `main`). The contract is fixed: `POST <endpoint>/api/catchup` with JSON body `{ token, channel_id, guild_id }`; response `{ channel_id, guild_id, fetched, appended, total, last_seen_id, messages }`; errors as `{ detail }` with the HTTP status. The backend validates `guild_id` against `^[A-Za-z0-9_-]{1,30}$`, so Discord's `@me` (DMs) **must** be sent as `dm`.

**Resolved design decisions:**
- **UI surface:** browser-action popup + options page (no in-page injected button — avoids fighting Discord's DOM/CSP).
- **Who does the network POST:** the background service worker (so the token does not transit the popup, and host-permission usage is centralized).
- **Default endpoint:** `http://localhost:8111` (matches the documented Docker deploy). `localhost`, `127.0.0.1`, and `lurk.kautiontape.com` are pre-granted host permissions so they work without an options trip; any other endpoint goes through the options page, which requests the host permission for that origin.
- **Icons:** none (Chrome shows the default action icon). Out of scope.
- **Token-grab caveat:** Discord scrubs `window.localStorage`'s accessor; the iframe technique reads a fresh same-origin iframe's `localStorage`. If Discord changes this, the popup surfaces a clear error pointing to the web app's manual-token flow. This is the known, accepted approach.

---

## File Structure

All under a new top-level `extension/` directory:

- `extension/manifest.json` — MV3 manifest: action popup, options page, background SW, `storage`/`tabs` permissions, `discord.com` + localhost/127.0.0.1/lurk.kautiontape.com host permissions, `optional_host_permissions` for arbitrary endpoints, content script registration.
- `extension/lib/parse.js` — **pure**: `parseChannelUrl(url) -> {guildId, channelId} | null` (maps `@me`→`dm`). Loaded into the content script and required by the Node test.
- `extension/lib/endpoint.js` — **pure**: `normalizeEndpoint(raw)`, `catchupUrl(endpoint)`, `originPatternFor(endpoint)`. Used by the background SW (`importScripts`) and the options page (`<script src>`), and required by the Node test.
- `extension/content.js` — reads the token (iframe technique) + calls `parseChannelUrl`; responds to `LURK_CAPTURE` messages.
- `extension/background.js` — service worker; handles `LURK_CATCHUP`: capture via content script, POST to endpoint, return result.
- `extension/popup.html` + `extension/popup.js` — consent gate, endpoint display, "Catch me up", status.
- `extension/options.html` + `extension/options.js` — set/persist endpoint, request host permission.
- `extension/test/parse.test.js`, `extension/test/endpoint.test.js` — Node-runnable assertions for the pure helpers.
- `extension/README.md` — load-unpacked + usage instructions.
- Modify `README.md` (repo root) — add a short "Browser extension" pointer.

**Message protocol (fixed across tasks):**
- Popup → background: `{ type: "LURK_CATCHUP", tabId: <number> }` → resolves to `{ ok: true, fetched, appended, total, channelId, guildId } | { ok: false, error }`.
- Background → content: `{ type: "LURK_CAPTURE" }` → resolves to `{ ok: true, token, guildId, channelId } | { ok: false, error }`.

---

## Task 1: Pure helpers + Node tests

**Files:**
- Create: `extension/lib/parse.js`, `extension/lib/endpoint.js`
- Test: `extension/test/parse.test.js`, `extension/test/endpoint.test.js`

- [ ] **Step 1: Write the failing parse test**

`extension/test/parse.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { parseChannelUrl } = require('../lib/parse.js');

test('parses a guild channel url', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/123/456'),
    { guildId: '123', channelId: '456' });
});

test('maps @me DM to guild "dm"', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/@me/789'),
    { guildId: 'dm', channelId: '789' });
});

test('ignores trailing path segments', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/123/456/999888'),
    { guildId: '123', channelId: '456' });
});

test('returns null when no channel in url', () => {
  assert.strictEqual(parseChannelUrl('https://discord.com/channels/123'), null);
});

test('returns null for non-discord host', () => {
  assert.strictEqual(parseChannelUrl('https://example.com/channels/1/2'), null);
});

test('returns null for garbage', () => {
  assert.strictEqual(parseChannelUrl('not a url'), null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test extension/test/parse.test.js`
Expected: FAIL — `Cannot find module '../lib/parse.js'`.

- [ ] **Step 3: Implement `extension/lib/parse.js`**

```javascript
// Pure helper: extract guild/channel ids from a Discord channel URL.
// Maps the @me DM pseudo-guild to "dm" so it satisfies the backend's
// guild_id validation (^[A-Za-z0-9_-]{1,30}$).
function parseChannelUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (u.hostname !== 'discord.com') return null;
  const m = u.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
  if (!m) return null;
  const guildId = m[1] === '@me' ? 'dm' : m[1];
  return { guildId, channelId: m[2] };
}

if (typeof module !== 'undefined') module.exports = { parseChannelUrl };
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test extension/test/parse.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing endpoint test**

`extension/test/endpoint.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeEndpoint, catchupUrl, originPatternFor } = require('../lib/endpoint.js');

test('strips trailing slashes', () => {
  assert.strictEqual(normalizeEndpoint('http://localhost:8111/'), 'http://localhost:8111');
  assert.strictEqual(normalizeEndpoint('https://lurk.kautiontape.com//'), 'https://lurk.kautiontape.com');
});

test('adds http:// when scheme is missing', () => {
  assert.strictEqual(normalizeEndpoint('localhost:8111'), 'http://localhost:8111');
});

test('returns null for empty/invalid', () => {
  assert.strictEqual(normalizeEndpoint(''), null);
  assert.strictEqual(normalizeEndpoint('   '), null);
});

test('builds the catchup url', () => {
  assert.strictEqual(catchupUrl('http://localhost:8111'), 'http://localhost:8111/api/catchup');
  assert.strictEqual(catchupUrl(''), null);
});

test('builds a port-less origin match pattern', () => {
  assert.strictEqual(originPatternFor('http://localhost:8111'), 'http://localhost/*');
  assert.strictEqual(originPatternFor('https://lurk.kautiontape.com'), 'https://lurk.kautiontape.com/*');
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test extension/test/endpoint.test.js`
Expected: FAIL — `Cannot find module '../lib/endpoint.js'`.

- [ ] **Step 7: Implement `extension/lib/endpoint.js`**

```javascript
// Pure helpers for the configured lurk endpoint.
function normalizeEndpoint(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  try {
    new URL(s);
  } catch (e) {
    return null;
  }
  return s;
}

function catchupUrl(endpoint) {
  const n = normalizeEndpoint(endpoint);
  return n ? n + '/api/catchup' : null;
}

// Host match patterns ignore the port, so "http://localhost/*" covers :8111.
function originPatternFor(endpoint) {
  const n = normalizeEndpoint(endpoint);
  if (!n) return null;
  const u = new URL(n);
  return `${u.protocol}//${u.hostname}/*`;
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeEndpoint, catchupUrl, originPatternFor };
}
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `node --test extension/test/endpoint.test.js`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add extension/lib/parse.js extension/lib/endpoint.js extension/test/parse.test.js extension/test/endpoint.test.js
git commit -m "feat(ext): add pure parse + endpoint helpers with node tests"
```

---

## Task 2: Manifest + content script

**Files:**
- Create: `extension/manifest.json`, `extension/content.js`

No automated behavior test (browser-bound). Verification = manifest is valid JSON, content.js parses (`node --check`), and the static references line up. End-to-end token grab is verified manually in Task 6.

- [ ] **Step 1: Create `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "lurk — Discord catch-up",
  "version": "0.1.0",
  "description": "Capture the Discord channel you're viewing and send it to your lurk instance to catch up.",
  "action": {
    "default_popup": "popup.html",
    "default_title": "lurk — catch up on this channel"
  },
  "options_page": "options.html",
  "background": {
    "service_worker": "background.js"
  },
  "permissions": ["storage", "tabs"],
  "host_permissions": [
    "https://discord.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    "https://lurk.kautiontape.com/*"
  ],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "content_scripts": [
    {
      "matches": ["https://discord.com/*"],
      "js": ["lib/parse.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Create `extension/content.js`**

```javascript
// Runs in the discord.com page (isolated world). `parseChannelUrl` comes from
// lib/parse.js, listed before this file in the manifest content_scripts.

// Discord deletes window.localStorage's getter to stop token theft from the
// console. A freshly created same-origin iframe still exposes localStorage,
// so we read the token from there.
function readDiscordToken() {
  try {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    const ls = iframe.contentWindow && iframe.contentWindow.localStorage;
    const raw = ls ? ls.getItem('token') : null;
    iframe.remove();
    if (!raw) return null;
    // Discord stores the token as a JSON string (wrapped in quotes).
    return raw.replace(/^"|"$/g, '');
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'LURK_CAPTURE') return;
  const parsed = parseChannelUrl(location.href);
  if (!parsed) {
    sendResponse({ ok: false, error: 'Open a Discord channel first — no channel found in the URL.' });
    return;
  }
  const token = readDiscordToken();
  if (!token) {
    sendResponse({
      ok: false,
      error: 'Could not read your Discord token from this tab. Log in to discord.com in the browser (not the desktop app), then reload and retry.',
    });
    return;
  }
  sendResponse({ ok: true, token, guildId: parsed.guildId, channelId: parsed.channelId });
  // Response is synchronous; no need to return true.
});
```

- [ ] **Step 3: Validate the JSON and JS syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"`
Expected: prints `manifest ok` (no JSON error).

Run: `node --check extension/content.js && echo "content.js syntax ok"`
Expected: prints `content.js syntax ok`.

- [ ] **Step 4: Confirm static references line up**

Run: `grep -n '"lib/parse.js"' extension/manifest.json && grep -n 'parseChannelUrl' extension/content.js`
Expected: both match — manifest loads `lib/parse.js` before `content.js`, and `content.js` calls `parseChannelUrl`.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/content.js
git commit -m "feat(ext): add MV3 manifest and token-capture content script"
```

---

## Task 3: Background service worker (orchestrator + POST)

**Files:**
- Create: `extension/background.js`

- [ ] **Step 1: Create `extension/background.js`**

```javascript
// Service worker. Brings in the pure endpoint helpers (classic worker → importScripts).
importScripts('lib/endpoint.js');

const DEFAULT_ENDPOINT = 'http://localhost:8111';

async function handleCatchup(tabId) {
  const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  const url = catchupUrl(cfg.endpoint);
  if (!url) {
    return { ok: false, error: 'No valid lurk endpoint configured. Set one in the extension Options.' };
  }

  let cap;
  try {
    cap = await chrome.tabs.sendMessage(tabId, { type: 'LURK_CAPTURE' });
  } catch (e) {
    return { ok: false, error: 'Could not reach the Discord tab. Reload discord.com and try again.' };
  }
  if (!cap || !cap.ok) {
    return { ok: false, error: cap ? cap.error : 'Capture failed.' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cap.token, guild_id: cap.guildId, channel_id: cap.channelId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.detail || `lurk returned HTTP ${res.status}` };
    }
    return {
      ok: true,
      channelId: cap.channelId,
      guildId: cap.guildId,
      fetched: data.fetched,
      appended: data.appended,
      total: data.total,
    };
  } catch (e) {
    return { ok: false, error: `Could not reach lurk at ${url}. Is it running and is this origin permitted? (${e.message})` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'LURK_CATCHUP') {
    handleCatchup(msg.tabId).then(sendResponse);
    return true; // keep the channel open for the async response
  }
});
```

- [ ] **Step 2: Validate syntax**

Run: `node --check extension/background.js && echo "background.js syntax ok"`
Expected: prints `background.js syntax ok`.

- [ ] **Step 3: Confirm the importScripts path is correct**

Run: `test -f extension/lib/endpoint.js && grep -n "importScripts('lib/endpoint.js')" extension/background.js`
Expected: the file exists and the grep matches (the SW lives at `extension/background.js`, so `lib/endpoint.js` resolves to `extension/lib/endpoint.js`).

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat(ext): add background worker that captures and POSTs to /api/catchup"
```

---

## Task 4: Popup (consent gate + Catch me up + status)

**Files:**
- Create: `extension/popup.html`, `extension/popup.js`

MV3 forbids inline scripts on extension pages, so all JS lives in `popup.js` referenced via `<script src>`. Inline `<style>` is allowed.

- [ ] **Step 1: Create `extension/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { width: 320px; margin: 0; font-family: system-ui, sans-serif; background: #141417; color: #E8E8EC; }
    .wrap { padding: 14px 16px 16px; }
    h1 { font-size: 14px; margin: 0 0 8px; letter-spacing: 0.02em; }
    h1 .a { color: #FFD000; }
    .warn { background: rgba(255,82,82,0.10); border: 1px solid rgba(255,82,82,0.35); color: #FF5252;
            border-radius: 6px; padding: 8px 10px; font-size: 11px; line-height: 1.4; margin-bottom: 10px; }
    .endpoint { font-size: 11px; color: #8888A0; margin-bottom: 10px; word-break: break-all; }
    .endpoint b { color: #FFD000; }
    #consent-row { font-size: 12px; margin-bottom: 10px; display: flex; gap: 7px; align-items: flex-start; }
    button { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 5px; cursor: pointer;
             border: 1px solid #2A2A30; background: transparent; color: #E8E8EC; padding: 8px 12px; }
    button.primary { background: #FFD000; color: #0a0a0c; border-color: #FFD000; width: 100%; }
    button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .links { margin-top: 10px; font-size: 11px; }
    .links a { color: #8888A0; cursor: pointer; text-decoration: underline; }
    #status { margin-top: 10px; font-size: 12px; min-height: 16px; }
    #status.ok { color: #4CAF50; }
    #status.err { color: #FF5252; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1><span class="a">lurk</span> — catch up</h1>
    <div class="warn">
      ⚠ This reads your <b>user token</b> — a self-bot, against Discord's ToS, and it can get your account banned.
      The token goes only to your configured lurk instance and is never stored by this extension.
    </div>
    <div class="endpoint">sending to: <b id="endpoint">…</b></div>
    <div id="consent-row">
      <input type="checkbox" id="consent-check">
      <label for="consent-check">I understand this risks my Discord account and accept it.</label>
    </div>
    <button class="primary" id="catchup" disabled>Catch me up on this channel</button>
    <div id="status"></div>
    <div class="links"><a id="open-options">change endpoint…</a></div>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/popup.js`**

```javascript
const DEFAULT_ENDPOINT = 'http://localhost:8111';
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

async function init() {
  const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, consentAck: false });
  $('endpoint').textContent = cfg.endpoint;
  $('consent-check').checked = cfg.consentAck;
  $('consent-row').style.display = cfg.consentAck ? 'none' : 'flex';
  $('catchup').disabled = !cfg.consentAck;
}

$('consent-check').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ consentAck: e.target.checked });
  $('catchup').disabled = !e.target.checked;
});

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('catchup').addEventListener('click', async () => {
  setStatus('capturing…', '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/discord\.com\//.test(tab.url || '')) {
    setStatus('Open the discord.com tab on the channel you want, then click again.', 'err');
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'LURK_CATCHUP', tabId: tab.id });
  if (result && result.ok) {
    setStatus(`✓ ${result.appended} new (fetched ${result.fetched}, ${result.total} archived).`, 'ok');
  } else {
    setStatus(`✗ ${result ? result.error : 'Something went wrong.'}`, 'err');
  }
});

init();
```

- [ ] **Step 3: Validate syntax + no inline script in HTML**

Run: `node --check extension/popup.js && echo "popup.js syntax ok"`
Expected: prints `popup.js syntax ok`.

Run: `grep -c '<script src="popup.js">' extension/popup.html` (expect `1`) and confirm there is no inline `<script>…code…</script>` block (only the external `src` reference).

- [ ] **Step 4: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat(ext): add popup with consent gate and catch-up action"
```

---

## Task 5: Options page (endpoint config + permission request)

**Files:**
- Create: `extension/options.html`, `extension/options.js`

- [ ] **Step 1: Create `extension/options.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui, sans-serif; background: #0C0C0E; color: #E8E8EC; max-width: 520px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 18px; } h1 .a { color: #FFD000; }
    p { font-size: 13px; color: #8888A0; line-height: 1.5; }
    label { display: block; font-size: 12px; color: #8888A0; margin: 16px 0 6px; }
    input { width: 100%; padding: 9px 10px; border-radius: 5px; border: 1px solid #2A2A30;
            background: #0A0A0C; color: #E8E8EC; font-family: ui-monospace, monospace; font-size: 13px; }
    button { margin-top: 14px; font-size: 13px; font-weight: 600; border-radius: 5px; cursor: pointer;
             border: 1px solid #FFD000; background: #FFD000; color: #0a0a0c; padding: 9px 14px; }
    #status { margin-top: 12px; font-size: 13px; min-height: 18px; }
    #status.ok { color: #4CAF50; } #status.err { color: #FF5252; }
  </style>
</head>
<body>
  <h1><span class="a">lurk</span> extension — settings</h1>
  <p>Where should captured messages be sent? Point this at your own lurk instance —
     locally (<code>http://localhost:8111</code>) or your own server. The extension will ask
     for permission to talk to that host.</p>
  <label for="endpoint">lurk endpoint</label>
  <input type="text" id="endpoint" placeholder="http://localhost:8111" spellcheck="false">
  <button id="save">Save</button>
  <div id="status"></div>
  <script src="lib/endpoint.js"></script>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/options.js`**

```javascript
const DEFAULT_ENDPOINT = 'http://localhost:8111';
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

async function init() {
  const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  $('endpoint').value = cfg.endpoint;
}

$('save').addEventListener('click', async () => {
  const normalized = normalizeEndpoint($('endpoint').value); // from lib/endpoint.js
  if (!normalized) {
    setStatus('That does not look like a valid URL.', 'err');
    return;
  }
  const pattern = originPatternFor(normalized);
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    setStatus('Could not request permission: ' + e.message, 'err');
    return;
  }
  if (!granted) {
    setStatus('Permission denied for ' + pattern + ' — the extension cannot POST there without it.', 'err');
    return;
  }
  await chrome.storage.sync.set({ endpoint: normalized });
  $('endpoint').value = normalized;
  setStatus('Saved: ' + normalized, 'ok');
});

init();
```

- [ ] **Step 3: Validate syntax**

Run: `node --check extension/options.js && echo "options.js syntax ok"`
Expected: prints `options.js syntax ok`.

Run: `grep -n 'lib/endpoint.js' extension/options.html`
Expected: matches — the options page loads the pure helpers (so `normalizeEndpoint`/`originPatternFor` are globals there).

- [ ] **Step 4: Commit**

```bash
git add extension/options.html extension/options.js
git commit -m "feat(ext): add options page to set endpoint and request host permission"
```

---

## Task 6: Docs + manual end-to-end verification

**Files:**
- Create: `extension/README.md`
- Modify: `README.md` (repo root)

- [ ] **Step 1: Create `extension/README.md`**

```markdown
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
3. First time: tick the consent box (acknowledging the Discord-ToS / self-bot risk).
4. Click **Catch me up on this channel**. New messages since your last pull are
   fetched, cleaned, and archived by your lurk instance; the popup shows the counts.

## What it sends

Only `{ token, guild_id, channel_id }` to your configured endpoint. The token is
read per-click and is never stored by the extension. DMs (`@me`) are sent as
`guild_id: "dm"`.

## Caveat

The token is read via the same-origin-iframe `localStorage` technique. If Discord
changes its storage and the read fails, the popup says so — fall back to the lurk
web app's manual-token flow.
```

- [ ] **Step 2: Add a pointer to the repo-root `README.md`**

Read `README.md`, then add this section immediately after the `## Data` section (and before `## Tests`):
```markdown
## Browser extension

`extension/` is a Chrome MV3 extension that captures the Discord channel you're
viewing and calls `POST /api/catchup` on your configured lurk instance — no
DevTools, no copy-pasting ids. See `extension/README.md` to load it.
```

- [ ] **Step 3: Run the full pure-helper test suite once more**

Run: `node --test extension/test/`
Expected: PASS (11 tests across parse + endpoint).

- [ ] **Step 4: MANUAL end-to-end verification (requires your browser + a logged-in discord.com + a running lurk)**

This cannot be automated — perform it by hand and confirm each:
1. Start lurk locally: `LURK_DATA_DIR=$(mktemp -d) .venv/bin/uvicorn app:app --port 8111` (or `docker compose up`).
2. Load the unpacked `extension/` in `chrome://extensions`.
3. On a discord.com channel tab, open the popup → it shows the warning and `sending to: http://localhost:8111`, and the button is disabled until you tick consent.
4. Tick consent, click **Catch me up** → status shows `✓ N new (fetched …, … archived)`.
5. Re-open lurk's web UI (`http://localhost:8111`) → the **transparency log** lists the pull; `data/archives/<guild>/<channel>.jsonl` exists.
6. In **Options**, set the endpoint to your server, approve the permission prompt, save → a subsequent catch-up posts there.
7. Negative checks: on a non-discord tab the popup says to open Discord; with lurk stopped, the status shows a clear "could not reach lurk" error.

Record the outcome (pass/fail per step) in your commit message or PR description.

- [ ] **Step 5: Commit**

```bash
git add extension/README.md README.md
git commit -m "docs(ext): add extension README and root pointer"
```

---

## Self-Review

**Spec coverage** (against the extension portions of `docs/superpowers/specs/2026-06-09-lurk-local-catchup-design.md`):
- Extension reads token + current guild/channel automatically → Task 2 (`content.js` iframe token grab + `parseChannelUrl`).
- Configurable endpoint (default local, settable to the server) → Task 1 (`endpoint.js`), Task 5 (options + permission request), default `http://localhost:8111` in manifest-backed code.
- POSTs `{ token, guild_id, channel_id }` to `/api/catchup` → Task 3 (`background.js`), matching the Plan-A contract (verified live: `guild_id` validated `^[A-Za-z0-9_-]{1,30}$`, so `@me`→`dm` handled in Task 1).
- "Catch me up" one-click UI → Task 4 (popup).
- ToS/self-bot consent surface on the part that touches the token → Task 4 (consent gate, gated button) + endpoint shown for transparency.
- Chrome MV3 → Task 2 manifest.

**Out of scope (correctly absent):** in-page injected button, summaries, icons, multi-browser packaging (Firefox), automated browser e2e.

**Placeholder scan:** none — every step has concrete file contents or exact commands. Manual steps are explicitly labeled as such with concrete expected outcomes.

**Cross-file consistency:**
- Message types: `LURK_CATCHUP` (popup→background, Task 4/3) and `LURK_CAPTURE` (background→content, Task 3/2) match.
- Request body keys `token` / `guild_id` / `channel_id` (Task 3) match the backend `CatchupRequest` (verified on `main`).
- Response keys read by background — `fetched` / `appended` / `total` / `detail` (Task 3) — match the `/api/catchup` response and error shape.
- Pure helper names `parseChannelUrl`, `normalizeEndpoint`, `catchupUrl`, `originPatternFor` are defined in Task 1 and used identically in Tasks 2/3/5.
- `lib/parse.js` is loaded before `content.js` (manifest, Task 2) so `parseChannelUrl` is in scope; `lib/endpoint.js` is brought in via `importScripts` (background, Task 3) and `<script src>` (options, Task 5).
- Default endpoint `http://localhost:8111` is consistent across manifest host_permissions, background, popup, and options.
