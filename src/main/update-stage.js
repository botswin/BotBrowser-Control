const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

async function stageUpdate({ url, sha256, version, stagingDir }) {
  if (!url || !/^[a-f0-9]{64}$/i.test(sha256 || '') || !version || !/^[^/\\]+$/.test(version) || !path.isAbsolute(stagingDir)) throw new Error('Invalid update package metadata');
  fs.mkdirSync(stagingDir, { recursive: true });
  const temp = path.join(stagingDir, `.${version}.part`);
  const target = path.join(stagingDir, `${version}.package`);
  const marker = path.join(stagingDir, `${version}.json`);
  if (fs.existsSync(target)) {
    const existingHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (existingHash.toLowerCase() === sha256.toLowerCase()) {
      return { status: 'staged', version, path: target, sha256: existingHash };
    }
    throw new Error(`Update version already staged: ${version}`);
  }
  await new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? https : http;
    const request = transport.get(url, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Update download failed: HTTP ${response.statusCode}`)); return; }
      const stream = fs.createWriteStream(temp); response.pipe(stream);
      stream.on('finish', () => stream.close(resolve)); stream.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(180000, () => { request.destroy(); reject(new Error('Update download timeout')); });
  }).catch(error => { try { fs.rmSync(temp, { force: true }); } catch {} throw error; });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(temp)).digest('hex');
  if (hash.toLowerCase() !== sha256.toLowerCase()) { fs.rmSync(temp, { force: true }); throw new Error('Update checksum mismatch'); }
  fs.renameSync(temp, target);
  try {
    const pending = { status: 'staged', version, path: target, sha256: hash };
    const markerTemp = `${marker}.part`;
    fs.writeFileSync(markerTemp, JSON.stringify(pending), 'utf8');
    fs.renameSync(markerTemp, marker);
    return pending;
  } catch (error) {
    try { fs.rmSync(target, { force: true }); } catch {}
    try { fs.rmSync(`${marker}.part`, { force: true }); } catch {}
    throw error;
  }
}

function getStagedUpdate({ stagingDir, version } = {}) {
  if (!stagingDir || !path.isAbsolute(stagingDir)) throw new Error('Invalid staging directory');
  if (version && !/^[^\\/\\]+$/.test(version)) throw new Error('Invalid update version');
  if (!fs.existsSync(stagingDir)) return null;
  const names = version ? [version] : fs.readdirSync(stagingDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.part'))
    .map(entry => entry.name.slice(0, -5));
  for (const name of names) {
    const marker = path.join(stagingDir, `${name}.json`);
    if (!fs.existsSync(marker)) continue;
    try {
      const pending = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (pending.status === 'staged' && fs.existsSync(pending.path)) return pending;
    } catch {}
  }
  return null;
}

function cancelStagedUpdate({ stagingDir, version } = {}) {
  const pending = getStagedUpdate({ stagingDir, version });
  if (!pending) return false;
  fs.rmSync(pending.path, { force: true });
  fs.rmSync(path.join(stagingDir, `${pending.version}.json`), { force: true });
  return true;
}

module.exports = { stageUpdate, getStagedUpdate, cancelStagedUpdate };

