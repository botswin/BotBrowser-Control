const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function releaseAssetSpecs(version) {
  return [
    { platform: 'win32', arch: 'x64', format: 'zip', name: `BotBrowser Control-${version}-win.zip` },
    { platform: 'win32', arch: 'arm64', format: 'zip', name: `BotBrowser Control-${version}-arm64-win.zip` },
    { platform: 'darwin', arch: 'x64', format: 'zip', name: `BotBrowser Control-${version}-mac.zip` },
    { platform: 'darwin', arch: 'arm64', format: 'zip', name: `BotBrowser Control-${version}-arm64-mac.zip` },
    { platform: 'linux', arch: 'x64', format: 'appimage', name: `BotBrowser Control-${version}.AppImage` },
    { platform: 'linux', arch: 'arm64', format: 'appimage', name: `BotBrowser Control-${version}-arm64.AppImage` },
    { platform: 'linux', arch: 'x64', format: 'tar.gz', name: `botbrowser-control-${version}.tar.gz` },
    { platform: 'linux', arch: 'arm64', format: 'tar.gz', name: `botbrowser-control-${version}-arm64.tar.gz` },
  ];
}

function isReleaseUrl(urlValue, tag, name) {
  let url;
  try { url = new URL(urlValue); } catch { return false; }
  const expectedUrl = `https://github.com/botswin/BotBrowser-Control/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  return url.href === expectedUrl;
}

function createReleaseManifest(version, releaseAssets, tag = `v${version}`) {
  if (typeof version !== 'string' || !VERSION_RE.test(version) || tag !== `v${version}` || !Array.isArray(releaseAssets)) return { version, assets: [] };
  const assets = [];
  for (const spec of releaseAssetSpecs(version)) {
    const matches = releaseAssets.filter(asset => asset && asset.name === spec.name);
    if (matches.length !== 1) continue;
    const asset = matches[0];
    const digest = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i) : null;
    if (!digest || !isReleaseUrl(asset.browser_download_url, tag, spec.name)) continue;
    assets.push({ ...spec, version, url: asset.browser_download_url, sha256: digest[1].toLowerCase() });
  }
  return { version, assets };
}

function selectReleaseAsset(manifest, platform, arch, format) {
  if (!manifest || typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version) || !Array.isArray(manifest.assets)) throw new Error('Invalid release manifest');
  const matches = manifest.assets.filter(asset => asset.platform === platform && asset.arch === arch && (format === undefined || asset.format === format));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous ${platform}/${arch} release asset`);
  const asset = matches[0];
  const expected = releaseAssetSpecs(manifest.version).find(spec => spec.platform === platform && spec.arch === arch && spec.format === asset.format);
  if (!expected || asset.version !== manifest.version || asset.name !== expected.name || !SHA256_RE.test(asset.sha256 || '') ||
      !isReleaseUrl(asset.url, `v${manifest.version}`, expected.name)) {
    throw new Error('Release asset URL, version, or checksum is invalid');
  }
  return { version: manifest.version, ...asset };
}

module.exports = { createReleaseManifest, selectReleaseAsset };
