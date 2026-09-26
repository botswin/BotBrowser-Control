function validateWarmupUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function runWarmupUrls(urls, { request = fetch, continueOnError = true } = {}) {
  const results = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = validateWarmupUrl(raw);
    if (!url) { results.push({ input: raw, url: null, ok: false, error: 'Invalid URL' }); continue; }
    try {
      const response = await request(url);
      results.push({ input: raw, url, ok: !!response.ok, status: response.status });
      if (!response.ok && !continueOnError) break;
    } catch (error) {
      results.push({ input: raw, url, ok: false, error: error.message });
      if (!continueOnError) break;
    }
  }
  return results;
}

module.exports = { validateWarmupUrl, runWarmupUrls };
