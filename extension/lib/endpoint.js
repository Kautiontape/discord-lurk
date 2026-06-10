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
