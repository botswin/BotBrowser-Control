const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function getDownloadTransport(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return { parsed, transport: https };
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return { parsed, transport: http };
  throw new Error('Update downloads must use HTTPS');
}

function downloadToFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = getDownloadTransport(url); } catch (error) { reject(error); return; }
    const request = target.transport.get(target.parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location) { reject(new Error('Update redirect missing location')); return; }
        if (redirects >= 5) { reject(new Error('Too many update redirects')); return; }
        let nextUrl;
        try { nextUrl = new URL(location, target.parsed).href; } catch { reject(new Error('Invalid update redirect URL')); return; }
        downloadToFile(nextUrl, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Update download failed: HTTP ${response.statusCode}`)); return; }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(180000, () => { request.destroy(); reject(new Error('Update download timeout')); });
  });
}

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
  await downloadToFile(url, temp).catch(error => { try { fs.rmSync(temp, { force: true }); } catch {} throw error; });
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

