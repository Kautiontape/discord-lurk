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
