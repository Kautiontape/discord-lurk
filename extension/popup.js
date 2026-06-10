const DEFAULT_ENDPOINT = 'http://localhost:8111';
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

let lastDownloadUrl = null;
function offerDownload(messages, channelId) {
  const box = $('download');
  box.innerHTML = '';
  if (lastDownloadUrl) {
    URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = null;
  }
  if (!messages || !messages.length) return;
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(messages, null, 2)], { type: 'application/json' });
  lastDownloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = lastDownloadUrl;
  a.download = `lurk-${channelId || 'channel'}-${ts}.json`;
  a.textContent = `download json (${messages.length} message${messages.length === 1 ? '' : 's'})`;
  box.appendChild(a);
}

async function init() {
  const cfg = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  $('endpoint').textContent = cfg.endpoint;
}

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('catchup').addEventListener('click', async () => {
  setStatus('capturing…', '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/discord\.com\//.test(tab.url || '')) {
    setStatus('Open the discord.com tab on the channel you want, then click again.', 'err');
    return;
  }
  $('download').innerHTML = '';
  const result = await chrome.runtime.sendMessage({ type: 'LURK_CATCHUP', tabId: tab.id });
  if (result && result.ok) {
    setStatus(`✓ ${result.appended} new (fetched ${result.fetched}, ${result.total} archived).`, 'ok');
    offerDownload(result.messages, result.channelId);
  } else {
    setStatus(`✗ ${result ? result.error : 'Something went wrong.'}`, 'err');
  }
});

init();
