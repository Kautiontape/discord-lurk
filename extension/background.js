// Service worker. Brings in the pure helpers (classic worker → importScripts):
// parseChannelUrl from lib/parse.js, catchupUrl from lib/endpoint.js.
importScripts('lib/parse.js', 'lib/endpoint.js');

const DEFAULT_ENDPOINT = 'http://localhost:8111';

// Injected into the discord.com page's MAIN world (where Discord's own JS runs)
// to read the user token. Discord no longer keeps the token in localStorage, so
// the old same-origin-iframe read returns nothing on current builds. Instead we
// pull it from the running webpack module that exposes getToken(); the iframe/
// localStorage read is kept only as a fallback for older builds. This must run
// in the MAIN world — a content script's isolated world can't see
// window.webpackChunkdiscord_app.
function lurkReadToken() {
  // Primary: read the token straight from Discord's running webpack modules.
  try {
    let token;
    window.webpackChunkdiscord_app.push([
      [Symbol()],
      {},
      (req) => {
        for (const mod of Object.values(req.c)) {
          try {
            const ex = mod && mod.exports;
            if (!ex || ex === window) continue;
            if (typeof ex.getToken === 'function') token = ex.getToken();
            for (const key in ex) {
              const sub = ex[key];
              if (
                sub &&
                typeof sub.getToken === 'function' &&
                sub[Symbol.toStringTag] !== 'IntlMessagesProxy'
              ) {
                token = sub.getToken();
              }
            }
          } catch (e) {
            /* keep scanning other modules */
          }
        }
      },
    ]);
    window.webpackChunkdiscord_app.pop();
    if (token) return token;
  } catch (e) {
    /* fall through to the legacy method */
  }

  // Fallback: the old same-origin-iframe localStorage trick (older builds only).
  try {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    const ls = iframe.contentWindow && iframe.contentWindow.localStorage;
    const raw = ls ? ls.getItem('token') : null;
    iframe.remove();
    if (raw) return raw.replace(/^"|"$/g, ''); // stored as a quoted JSON string
  } catch (e) {
    /* ignore */
  }

  return null;
}

async function handleCatchup(tabId) {
  const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  const url = catchupUrl(cfg.endpoint);
  if (!url) {
    return { ok: false, error: 'No valid lurk endpoint configured. Set one in the extension Options.' };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return { ok: false, error: 'Could not read the Discord tab. Reload discord.com and try again.' };
  }
  const parsed = parseChannelUrl(tab.url || '');
  if (!parsed) {
    return { ok: false, error: 'Open a Discord channel first — no channel found in the URL.' };
  }

  let token = null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: lurkReadToken,
    });
    token = injection && injection.result;
  } catch (e) {
    return { ok: false, error: 'Could not read the Discord page. Reload discord.com and try again.' };
  }
  if (!token) {
    return {
      ok: false,
      error:
        'Could not read your Discord token from this tab. Make sure you are logged in to discord.com in the browser (not the desktop app), reload the tab, and retry.',
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, guild_id: parsed.guildId, channel_id: parsed.channelId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.detail || `lurk returned HTTP ${res.status}` };
    }
    return {
      ok: true,
      channelId: parsed.channelId,
      guildId: parsed.guildId,
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
