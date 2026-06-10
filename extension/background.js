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

// Discord tab titles look like "(12) Discord | #channel-name | Server Name"
// (DMs: "Discord | @handle"). Pull the channel and server display names out.
function parseDiscordTitle(title) {
  if (!title) return { name: '', guildName: '' };
  const t = title.replace(/^\(\d+\)\s*/, ''); // strip the "(12) " unread count
  const parts = t.split(' | ').map((s) => s.trim());
  const idx = parts.findIndex((p) => p.startsWith('#') || p.startsWith('@'));
  if (idx === -1) return { name: '', guildName: '' };
  return { name: parts[idx].replace(/^[#@]/, ''), guildName: parts[idx + 1] || '' };
}

// Fallback when the title doesn't parse: ask lurk to resolve the channel name
// from Discord (it already proxies /api/channel).
async function lookupChannelName(endpoint, token, channelId) {
  try {
    const base = normalizeEndpoint(endpoint);
    if (!base) return '';
    const res = await fetch(`${base}/api/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, channel_id: channelId }),
    });
    if (!res.ok) return '';
    const d = await res.json();
    return d.name || '';
  } catch (e) {
    return '';
  }
}

async function handleCatchup(tabId, { after = null, channelId = null } = {}) {
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
  // For a from-here capture the content script passes the message's own channel
  // id (correct even in threads/search); otherwise use the viewed channel. The
  // guild only comes from the URL, so fall back to "dm" if it isn't a channel URL.
  const channel = channelId || (parsed && parsed.channelId);
  const guild = (parsed && parsed.guildId) || 'dm';
  if (!channel) {
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

  // Display names so the channel shows correctly in the web app. Prefer the tab
  // title (gives both channel + server name); fall back to a Discord lookup for
  // the channel name only. Skipped for from-here captures in another channel.
  const titleNames = channelId ? { name: '', guildName: '' } : parseDiscordTitle(tab.title || '');
  let name = titleNames.name;
  const guildName = titleNames.guildName;
  if (!name && !channelId) {
    name = await lookupChannelName(cfg.endpoint, token, channel);
  }

  try {
    const body = { token, guild_id: guild, channel_id: channel };
    if (after) body.after = after;
    if (name) body.name = name;
    if (guildName) body.guild_name = guildName;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.detail || `lurk returned HTTP ${res.status}` };
    }
    return {
      ok: true,
      channelId: channel,
      guildId: guild,
      fetched: data.fetched,
      appended: data.appended,
      total: data.total,
      messages: data.messages || [],
    };
  } catch (e) {
    return { ok: false, error: `Could not reach lurk at ${url}. Is it running and is this origin permitted? (${e.message})` };
  }
}

// Read-only lookup of the catch-up cursor for a channel, used by the content
// script to draw its "caught up to here" divider.
async function handleLastSeen(channelId) {
  try {
    const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
    const base = normalizeEndpoint(cfg.endpoint);
    if (!base) return { ok: false };
    const res = await fetch(`${base}/api/state?channel_id=${encodeURIComponent(channelId)}`);
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, lastSeenId: data.last_seen_id || null };
  } catch (e) {
    return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'LURK_CATCHUP') {
    handleCatchup(msg.tabId).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === 'LURK_CAPTURE_FROM') {
    const tabId = (sender.tab && sender.tab.id) || msg.tabId;
    handleCatchup(tabId, { after: msg.messageId, channelId: msg.channelId }).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'LURK_LAST_SEEN') {
    handleLastSeen(msg.channelId).then(sendResponse);
    return true;
  }
});
