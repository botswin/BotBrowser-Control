const SHA256_RE = /^[a-f0-9]{64}$/i;

function createReleaseManifest(version, releaseAssets, tag = `v${version}`) {
  if (typeof version !== 'string' || !version || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) || tag !== `v${version}` || !Array.isArray(releaseAssets)) return { version, assets: [] };
  const assets = [];
  for (const arch of ['x64', 'arm64']) {
    const name = arch === 'x64' ? `BotBrowser Control-${version}-win.zip` : `BotBrowser Control-${version}-arm64-win.zip`;
    const matches = releaseAssets.filter(asset => asset && asset.name === name);
    if (matches.length !== 1) continue;
    const asset = matches[0];
    let url;
    try { url = new URL(asset.browser_download_url); } catch { continue; }
    const expectedPath = `/botswin/BotBrowser-Control/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (url.protocol !== 'https:' || url.origin !== 'https://github.com' || url.pathname !== expectedPath) continue;
    const digest = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i) : null;
    if (!digest) continue;
    assets.push({ platform: 'win32', arch, name, url: url.href, sha256: digest[1].toLowerCase() });
  }
  return { version, assets };
}

function selectReleaseAsset(manifest, platform, arch) {
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) throw new Error('Invalid release manifest');
  const matches = manifest.assets.filter(asset => asset.platform === platform && asset.arch === arch);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous ${platform}/${arch} release asset`);
  const asset = matches[0];
  let url;
  try { url = new URL(asset.url); } catch { throw new Error('Release asset URL or checksum is invalid'); }
  if (!SHA256_RE.test(asset.sha256 || '')) throw new Error('Release asset URL or checksum is invalid');
  if (platform === 'win32') {
    const expectedName = arch === 'x64' ? `BotBrowser Control-${manifest.version}-win.zip` : `BotBrowser Control-${manifest.version}-arm64-win.zip`;
    const expectedPath = `/botswin/BotBrowser-Control/releases/download/v${manifest.version}/${encodeURIComponent(expectedName)}`;
    if (asset.name !== expectedName || url.protocol !== 'https:' || url.origin !== 'https://github.com' || url.pathname !== expectedPath) throw new Error('Release asset URL or checksum is invalid');
  }
  return { version: manifest.version, ...asset };
}

module.exports = { createReleaseManifest, selectReleaseAsset };
