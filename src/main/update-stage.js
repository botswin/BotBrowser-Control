const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

async function stageUpdate({ url, sha256, version, stagingDir }) {
  if (!url || !/^[a-f0-9]{64}$/i.test(sha256 || '') || !version || !path.isAbsolute(stagingDir)) throw new Error('Invalid update package metadata');
  fs.mkdirSync(stagingDir, { recursive: true });
  const temp = path.join(stagingDir, `.${version}.part`);
  const target = path.join(stagingDir, `${version}.package`);
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
  return { version, path: target, sha256: hash };
}

module.exports = { stageUpdate };
