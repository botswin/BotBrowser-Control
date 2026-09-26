const SUPPORTED = new Set(['http', 'https', 'socks5', 'socks5h']);

function parseProxyLine(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  const port = Number(url.port || (protocol === 'https' ? 443 : 80));
  if (!SUPPORTED.has(protocol) || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    type: protocol,
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : ''
  };
}

function parseProxyText(text) {
  const results = [];
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const parsed = parseProxyLine(raw);
    results.push(parsed
      ? { line: index + 1, input: raw.trim(), proxy: parsed, error: null }
      : { line: index + 1, input: raw.trim(), proxy: null, error: 'Invalid proxy format' });
  }
  return results;
}

module.exports = { parseProxyLine, parseProxyText };
