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
