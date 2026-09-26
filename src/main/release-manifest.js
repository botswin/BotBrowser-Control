function selectReleaseAsset(manifest, platform, arch) {
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) throw new Error('Invalid release manifest');
  const matches = manifest.assets.filter(asset => asset.platform === platform && asset.arch === arch);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous ${platform}/${arch} release asset`);
  const asset = matches[0];
  if (!asset.url || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) throw new Error('Release asset checksum is required');
  return { version: manifest.version, ...asset };
}

module.exports = { selectReleaseAsset };
