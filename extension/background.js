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
