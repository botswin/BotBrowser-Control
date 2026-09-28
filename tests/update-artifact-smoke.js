const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyFileSwap, extractUpdatePackage, getPosixInstallUnit } = require('../src/main/update-apply');

const platform = process.env.UPDATE_SMOKE_PLATFORM || process.platform;
const arch = process.env.UPDATE_SMOKE_ARCH || process.arch;
const version = require('../package.json').version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-artifact-'));

function fail(message) {
  throw new Error(message);
}

async function main() {
  if (platform === 'linux') {
    const suffix = arch === 'arm64' ? '-arm64' : '';
    const tarPath = path.resolve(`dist/botbrowser-control-${version}${suffix}.tar.gz`);
    const appImagePath = path.resolve(`dist/BotBrowser Control-${version}${suffix}.AppImage`);
    const extracted = await extractUpdatePackage(tarPath, path.join(root, 'tar-stage'), `smoke-${version}`, 'botbrowser-control');
    if (!extracted.executablePath || !fs.existsSync(extracted.executablePath)) fail('tar.gz executable was not found');
    const livePath = path.join(root, 'BotBrowser Control.AppImage');
    const stagedPath = path.join(root, 'staged.AppImage');
    fs.copyFileSync(appImagePath, livePath);
    fs.copyFileSync(appImagePath, stagedPath);
    fs.chmodSync(stagedPath, 0o644);
    applyFileSwap({ livePath, stagedPath, version: `smoke-${version}`, commitPath: path.join(root, 'current.version') });
    if ((fs.statSync(livePath).mode & 0o111) === 0) fail('AppImage is not executable after apply');
  } else if (platform === 'darwin') {
    const suffix = arch === 'arm64' ? '-arm64-' : '-';
    const zipPath = path.resolve(`dist/BotBrowser Control-${version}${suffix}mac.zip`);
    const extracted = await extractUpdatePackage(zipPath, path.join(root, 'mac-stage'), `smoke-${version}`, 'BotBrowser Control');
    const unit = getPosixInstallUnit({ platform, executablePath: extracted.executablePath });
    if (unit.kind !== 'directory' || !unit.livePath.endsWith('.app')) fail('macOS ZIP did not contain an app bundle');
  } else {
    fail(`Unsupported artifact smoke platform: ${platform}`);
  }
  process.stdout.write(JSON.stringify({ platform, arch, artifactSmoke: 'passed' }) + '\n');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
