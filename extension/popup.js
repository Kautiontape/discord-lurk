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
