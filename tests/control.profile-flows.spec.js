const { test, expect } = require('@playwright/test');
const http = require('node:http');
const net = require('node:net');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fetchCookiesViaCDP, saveCookiesViaCDP } = require('../src/main/cookies');
const { isNewerVersion } = require('../src/main/version');
const { parseProxyLine, parseProxyText } = require('../src/main/proxy-parser');
const JSZip = require('jszip');
const { parseCsv } = require('../src/main/csv');
const { validateWarmupUrl, runWarmupUrls } = require('../src/main/warmup');
const { createReleaseManifest, selectReleaseAsset } = require('../src/main/release-manifest');
const { stageUpdate } = require('../src/main/update-stage');
const { cleanupOldKernelVersions } = require('../src/main/kernel-retention');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/js/app.js'), 'utf8');

test('kernel retention keeps latest full version per major and protected versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-kernel-retention-'));
  const versions = ['147.0.1.0', '147.0.2.0', '147.0.3.0', '148.0.1.0', '148.0.2.0', 'not-a-version'];
  try {
    for (const version of versions) fs.mkdirSync(path.join(root, version));
    const removed = cleanupOldKernelVersions(root, new Set(['147.0.1.0']));
    expect(removed.sort()).toEqual(['147.0.2.0', '148.0.1.0']);
    expect(fs.existsSync(path.join(root, '147.0.1.0'))).toBe(true);
    expect(fs.existsSync(path.join(root, '147.0.3.0'))).toBe(true);
    expect(fs.existsSync(path.join(root, '148.0.2.0'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'not-a-version'))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kernel delete rejects traversal and absolute paths without touching a parent directory', async () => {
  const kernelsDir = await page.evaluate(() => window.api.kernel.getDir());
  const outsideDir = path.join(path.dirname(kernelsDir), 'kernel-delete-outside-' + process.pid + '-' + Date.now());
  const marker = path.join(outsideDir, 'marker.txt');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(marker, 'keep', 'utf8');
  try {
    expect(await page.evaluate(version => window.api.kernel.delete(version), '../' + path.basename(outsideDir))).toBe(false);
    expect(await page.evaluate(version => window.api.kernel.delete(version), outsideDir)).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('successful kernel extraction removes the downloaded archive', async () => {
  const archive = await new JSZip().file('kernel-fixture.exe', 'MZ archive fixture').generateAsync({ type: 'nodebuffer' });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/zip' });
    response.end(archive);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const version = '149.0.' + Date.now() + '.0';
  try {
    const result = await page.evaluate(({ url, version }) => window.api.kernel.download({
      downloadUrl: url, fileName: 'kernel-fixture.zip', version
    }), { url: 'http://127.0.0.1:' + server.address().port + '/kernel.zip', version });
    expect(result.installStatus).toBe('extracted');
    expect(fs.existsSync(result.destPath)).toBe(false);
    expect(fs.existsSync(result.execPath)).toBe(true);
  } finally {
    await page.evaluate(version => window.api.kernel.delete(version), version);
    await new Promise(resolve => server.close(resolve));
  }
});

test('Control release manifest selects exact electron-builder Windows ZIP assets with tag-bound URLs', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const releaseAssets = [
    { name: 'BotBrowser Control-1.2.3-win.zip', browser_download_url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-win.zip', digest },
    { name: 'BotBrowser Control-1.2.3-arm64-win.zip', browser_download_url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-arm64-win.zip', digest },
    { name: 'BotBrowser Control-1.2.3-win.zip', browser_download_url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v9.9.9/BotBrowser%20Control-1.2.3-win.zip', digest },
  ];
  const manifest = createReleaseManifest('1.2.3', releaseAssets, 'v1.2.3');
  expect(manifest.assets.map(asset => [asset.platform, asset.arch])).toEqual([['win32', 'arm64']]);
  expect(selectReleaseAsset(manifest, 'win32', 'arm64')).toMatchObject({ sha256: 'a'.repeat(64), version: '1.2.3' });
  expect(() => selectReleaseAsset(manifest, 'win32', 'x64')).toThrow(/Missing or ambiguous/);
  expect(createReleaseManifest('1.2.3', releaseAssets, 'v9.9.9').assets).toEqual([]);
});

test('Control release manifest rejects assets without a valid checksum', () => {
  const asset = { name: 'BotBrowser Control-1.2.3-win.zip', browser_download_url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-win.zip' };
  expect(createReleaseManifest('1.2.3', [asset], 'v1.2.3').assets).toEqual([]);
  expect(() => selectReleaseAsset({ version: '1.2.3', assets: [{ platform: 'win32', arch: 'x64', format: 'zip', version: '1.2.3', name: 'BotBrowser Control-1.2.3-win.zip', url: 'http://example.com/a.zip', sha256: 'a'.repeat(64) }] }, 'win32', 'x64')).toThrow(/invalid/i);
});

test('Control release manifest recognizes exact macOS and Linux workflow assets', () => {
  const names = [
    ['darwin', 'x64', 'zip', 'BotBrowser Control-1.2.3-mac.zip'],
    ['darwin', 'arm64', 'zip', 'BotBrowser Control-1.2.3-arm64-mac.zip'],
    ['linux', 'x64', 'appimage', 'BotBrowser Control-1.2.3.AppImage'],
    ['linux', 'arm64', 'appimage', 'BotBrowser Control-1.2.3-arm64.AppImage'],
    ['linux', 'x64', 'tar.gz', 'BotBrowser Control-1.2.3.tar.gz'],
    ['linux', 'arm64', 'tar.gz', 'BotBrowser Control-1.2.3-arm64.tar.gz'],
  ];
  const releaseAssets = names.map(([, , , name]) => ({
    name,
    browser_download_url: `https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/${encodeURIComponent(name)}`,
    digest: `sha256:${'b'.repeat(64)}`,
  }));
  const manifest = createReleaseManifest('1.2.3', releaseAssets, 'v1.2.3');
  expect(manifest.assets.map(({ platform, arch, format }) => [platform, arch, format])).toEqual(names.map(([platform, arch, format]) => [platform, arch, format]));
  for (const [platform, arch, format, name] of names) {
    expect(selectReleaseAsset(manifest, platform, arch, format)).toMatchObject({ name, version: '1.2.3', sha256: 'b'.repeat(64) });
  }
  expect(() => selectReleaseAsset(manifest, 'linux', 'x64')).toThrow(/ambiguous/);
  expect(() => selectReleaseAsset({ ...manifest, assets: [{ ...manifest.assets[0], version: '9.9.9' }] }, 'darwin', 'x64', 'zip')).toThrow(/version/i);
  expect(() => selectReleaseAsset({ ...manifest, assets: [{ ...manifest.assets[0], url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v9.9.9/BotBrowser%20Control-1.2.3-mac.zip' }] }, 'darwin', 'x64', 'zip')).toThrow(/URL/i);
  for (const suffix of ['?download=1', '#asset', '@github.com']) {
    const url = suffix === '@github.com'
      ? 'https://user@github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-mac.zip'
      : `https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-mac.zip${suffix}`;
    expect(() => selectReleaseAsset({ ...manifest, assets: [{ ...manifest.assets[0], url }] }, 'darwin', 'x64', 'zip')).toThrow(/URL/i);
  }
});

test('non-Windows staged update is rejected and renderer offers only the release handoff', () => {
  const applyHandler = mainSource.match(/ipcMain\.handle\('app:applyStagedUpdate',[\s\S]*?\n\}\);/);
  expect(applyHandler).not.toBeNull();
  expect(applyHandler[0]).toMatch(/if \(!IS_WIN\) throw new Error\('Staged updates can only be applied on Windows'\);/);
  expect(applyHandler[0].indexOf('if (!IS_WIN)')).toBeLessThan(applyHandler[0].indexOf('getStagedUpdate'));
  expect(rendererSource).toContain('const canApply = IS_WIN && showControl && Boolean(stagedControlUpdate);');
  expect(rendererSource).toContain('const controlAction = canApply');
});

test('Control renderer downloads and applies staged update through real DOM interactions', async () => {
  await app.evaluate(({ ipcMain }) => {
    const calls = { stage: 0, apply: 0 };
    globalThis.__controlUpdateCalls = calls;
    const manifest = { version: '1.2.3', assets: [{ platform: 'win32', arch: process.arch === 'arm64' ? 'arm64' : 'x64', name: process.arch === 'arm64' ? 'BotBrowser Control-1.2.3-arm64-win.zip' : 'BotBrowser Control-1.2.3-win.zip', url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-win.zip', sha256: 'a'.repeat(64) }] };
    ipcMain.removeHandler('app:checkForUpdates');
    ipcMain.removeHandler('app:getStagedUpdate');
    ipcMain.removeHandler('app:selectReleaseAsset');
    ipcMain.removeHandler('app:stageUpdate');
    ipcMain.removeHandler('app:applyStagedUpdate');
    ipcMain.handle('app:checkForUpdates', () => ({ kernel: null, newKernel: false, newControl: true, control: { tagName: 'v1.2.3', version: '1.2.3', isNewer: true, manifest } }));
    ipcMain.handle('app:getStagedUpdate', () => null);
    ipcMain.handle('app:selectReleaseAsset', (_, options) => options.manifest.assets[0]);
    ipcMain.handle('app:stageUpdate', () => { calls.stage++; return { status: 'staged', version: '1.2.3' }; });
    ipcMain.handle('app:applyStagedUpdate', () => { calls.apply++; return { status: 'scheduled', version: '1.2.3' }; });
  });
  await page.reload();
  await expect(page.locator('#update-banner')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-action="stage-control-update"]').click();
  await expect.poll(() => app.evaluate(() => globalThis.__controlUpdateCalls.stage)).toBe(1);
  await expect(page.locator('[data-action="apply-control-update"]')).toBeVisible();
  await page.evaluate(() => { window.confirm = () => false; });
  await page.locator('[data-action="apply-control-update"]').click();
  expect(await app.evaluate(() => globalThis.__controlUpdateCalls.apply)).toBe(0);
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('[data-action="apply-control-update"]').click();
  await expect.poll(() => app.evaluate(() => globalThis.__controlUpdateCalls.apply)).toBe(1);
});

test('stages a release package after a bounded HTTP redirect', async () => {
  const bytes = Buffer.from('redirected update package');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const server = http.createServer((req, res) => {
    if (req.url === '/release') { res.writeHead(302, { location: '/asset' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-redirect-'));
  try {
    const result = await stageUpdate({ url: `http://127.0.0.1:${server.address().port}/release`, sha256, version: '1.2.3', stagingDir });
    expect(result.status).toBe('staged');
    expect(fs.readFileSync(result.path)).toEqual(bytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

let app;
let page;
let userDataDir;

async function launchApp(env = {}) {
  app = await require('playwright')._electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, ...env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveTitle(/BotBrowser Control/i);
}

function createCdpServer(cookies) {
  const server = net.createServer(socket => {
    let stage = 'http';
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (stage === 'http' && end >= 0) {
        const request = buffer.slice(0, end).toString();
        buffer = buffer.slice(end + 4);
        if (request.startsWith('GET /json/list ')) {
          const body = JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/fixture` }]);
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          return;
        }
        const key = request.match(/Sec-WebSocket-Key: (.+)/i)?.[1];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        stage = 'websocket';
        buffer = Buffer.alloc(0);
      }
      if (stage !== 'websocket' || buffer.length < 6) return;
      const shortLength = buffer[1] & 0x7f;
      const headerLength = shortLength === 126 ? 8 : 6;
      const payloadLength = shortLength === 126 ? buffer.readUInt16BE(2) : shortLength;
      if (buffer.length < headerLength + payloadLength) return;
      const mask = buffer.slice(headerLength - 4, headerLength);
      const requestBody = Buffer.from(buffer.slice(headerLength, headerLength + payloadLength));
      for (let i = 0; i < requestBody.length; i++) requestBody[i] ^= mask[i % 4];
      buffer = buffer.slice(headerLength + payloadLength);
      if (JSON.parse(requestBody.toString()).method !== 'Network.getAllCookies') return;
      const responseBody = Buffer.from(JSON.stringify({ id: 1, result: { cookies } }));
      const frame = responseBody.length < 126
        ? Buffer.concat([Buffer.from([0x81, responseBody.length]), responseBody])
        : Buffer.concat([Buffer.from([0x81, 126, responseBody.length >> 8, responseBody.length & 0xff]), responseBody]);
      socket.write(frame);
    });
  });
  return server;
}

test.beforeEach(async () => { userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-profile-flows-')); await launchApp({ BOTBROWSER_TEST_HOLD_MS: '300000' }); });
test.afterEach(async () => { try { if (app) await app.close(); } finally { app = null; if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); userDataDir = null; } });

test('profile UI creates, edits, duplicates, searches, and deletes a profile', async () => {
  const name = `Profile flow ${Date.now()}`;
  let ids = [];
  try {
    await page.locator('[data-action="new-profile"]').first().click();
    await page.locator('#f-name').fill(name);
    await page.locator('#f-startUrl').fill('https://example.test/start');
    await page.locator('[data-action="save-profile"]').click();

    const original = await page.evaluate(async name => (await window.api.profiles.getAll()).find(p => p.name === name), name);
    expect(original).toBeTruthy();
    ids.push(original.id);
    const card = page.locator(`.profile-card[data-profile-id="${original.id}"]`);
    await expect(card.locator('.profile-name')).toHaveText(name);
    await card.locator('[data-action="edit-profile"]').click();
    await expect(page.locator('#f-name')).toHaveValue(name);
    await expect(page.locator('#f-startUrl')).toHaveValue('https://example.test/start');
    await page.locator('#f-startUrl').fill('https://example.test/edited');
    await page.locator('[data-action="save-profile"]').click();
    await expect(card).toContainText('https://example.test/edited');

    await card.locator('[data-action="duplicate-profile"]').click();
    const copy = page.locator('.profile-card').filter({ has: page.locator('.profile-name', { hasText: `${name} (Copy)` }) });
    await expect(copy).toHaveCount(1);
    const profiles = await page.evaluate(async prefix => (await window.api.profiles.getAll()).filter(p => p.name.startsWith(prefix)), name);
    expect(profiles).toHaveLength(2);
    ids = profiles.map(p => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))).toBe(true);
    expect(profiles.find(p => p.name === `${name} (Copy)`).startUrl).toBe('https://example.test/edited');

    await page.locator('#search-input').fill(`${name} (Copy)`);
    await expect(page.locator('.profile-card')).toHaveCount(1);
    await expect(page.locator('.profile-card .profile-name')).toHaveText(`${name} (Copy)`);
    await page.locator('#search-input').fill('profile-flow-no-match');
    await expect(page.locator('.empty-state')).toContainText('No results');
  } finally {
    await page.evaluate(async ids => { for (const id of ids) await window.api.profiles.delete(id); }, ids);
  }
});

test('profile editor validates required name and cancel leaves no saved profile', async () => {
  const name = `Cancelled profile ${Date.now()}`;
  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('#f-name').fill(name);
  await page.locator('[data-action="cancel-edit"]').last().click();
  expect(await page.evaluate(async name => (await window.api.profiles.getAll()).some(p => p.name === name), name)).toBe(false);

  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('[data-action="save-profile"]').click();
  await expect(page.locator('.toast-error')).toContainText('Profile name is required');
  await page.locator('[data-action="cancel-edit"]').last().click();
});

test('mobile user agents receive launcher-compatible defaults', async () => {
  const cases = [
    { label: 'Android', ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', platform: 'Android', expectArchitecture: 'arm64', expectBitness: '64' },
    { label: 'iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' },
    { label: 'iPad', ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' },
    { label: 'iPod', ua: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1' },
  ];
  const ids = [];
  try {
    for (const item of cases) {
      const name = `Mobile defaults ${item.label} ${Date.now()}`;
      await page.locator('[data-action="new-profile"]').first().click();
      await page.locator('#f-name').fill(name);
      await page.locator('[data-action="tab-switch"][data-tab="identity"]').click();
      await page.locator('#f-userAgent').fill(item.ua);
      if (item.platform) await page.locator('#f-platform').selectOption(item.platform);
      await page.locator('[data-action="save-profile"]').click();
      const profile = await page.evaluate(async name => (await window.api.profiles.getAll()).find(p => p.name === name), name);
      expect(profile).toBeTruthy();
      ids.push(profile.id);
      expect(profile.mobile).toBe(true);
      expect(profile.orientation).toBe('portrait');
      expect(profile.mobileForceTouch).toBe(true);
      if (item.expectArchitecture) expect(profile.architecture).toBe(item.expectArchitecture);
      if (item.expectBitness) expect(profile.bitness).toBe(item.expectBitness);
    }
  } finally {
    await page.evaluate(async ids => { for (const id of ids) await window.api.profiles.delete(id); }, ids);
  }
});

test('editing a mobile profile preserves explicit values', async () => {
  const name = `Explicit mobile values ${Date.now()}`;
  let id;
  try {
    const created = await page.evaluate(async name => window.api.profiles.create({ name, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile', mobile: false, orientation: 'landscape', mobileForceTouch: false, architecture: 'x86', bitness: '32' }), name);
    id = created.id;
    await page.reload();
    await expect(page.locator(`.profile-card[data-profile-id="${id}"]`)).toHaveCount(1);
    await page.locator(`.profile-card[data-profile-id="${id}"] [data-action="edit-profile"]`).click();
    await page.locator('[data-action="save-profile"]').click();
    const profile = await page.evaluate(async id => (await window.api.profiles.getAll()).find(p => p.id === id), id);
    expect(profile).toMatchObject({ mobile: false, orientation: 'landscape', mobileForceTouch: false, architecture: 'x86', bitness: '32' });
  } finally {
    if (id) await page.evaluate(async id => window.api.profiles.delete(id), id);
  }
});

test('desktop and invalid user agents do not receive mobile defaults', async () => {
  const cases = ['', 'not a user agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'];
  const ids = [];
  try {
    for (const ua of cases) {
      const name = `Non-mobile defaults ${Date.now()}-${ids.length}`;
      await page.locator('[data-action="new-profile"]').first().click();
      await page.locator('#f-name').fill(name);
      await page.locator('[data-action="tab-switch"][data-tab="identity"]').click();
      await page.locator('#f-userAgent').fill(ua);
      await page.locator('[data-action="save-profile"]').click();
      const profile = await page.evaluate(async name => (await window.api.profiles.getAll()).find(p => p.name === name), name);
      ids.push(profile.id);
      expect(profile.mobile).toBe('');
      expect(profile.orientation).toBe('profile');
      expect(profile.mobileForceTouch).toBe(false);
    }
  } finally {
    await page.evaluate(async ids => { for (const id of ids) await window.api.profiles.delete(id); }, ids);
  }
});

test('profile data is visible in the profile list after app restart', async () => {
  const name = `Restart profile ${Date.now()}`;
  const profile = await page.evaluate(name => window.api.profiles.create({ name, startUrl: 'https://example.test/restart' }), name);
  try {
    await app.close();
    app = null;
    await launchApp();
    const card = page.locator(`.profile-card[data-profile-id="${profile.id}"]`);
    await expect(card.locator('.profile-name')).toHaveText(name);
    await expect(card).toContainText('https://example.test/restart');
  } finally {
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
  }
});

test('proxy IP check fixture drives saved profile UI and failure reporting', async () => {
  const body = JSON.stringify({ status: 'success', query: '198.51.100.8', country: 'Fixtureland', countryCode: 'FX' });
  let rejectConnect = false;
  const server = http.createServer();
  server.on('connect', (_request, socket) => {
    if (rejectConnect) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await page.evaluate(async () => {
    const stale = (await window.api.profiles.getAll()).filter(item => item.name.startsWith('Proxy UI '));
    for (const item of stale) await window.api.profiles.delete(item.id);
  });
  const name = `Proxy UI ${Date.now()}`;
  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('#f-name').fill(name);
  await page.locator('[data-action="save-profile"]').click();
  const profile = await page.evaluate(async name => (await window.api.profiles.getAll()).find(item => item.name === name), name);
  try {
    const result = await page.evaluate(proxy => window.api.proxy.checkIp(proxy), `http://127.0.0.1:${port}`);
    expect(result).toMatchObject({ status: 'success', query: '198.51.100.8', country: 'Fixtureland' });
    rejectConnect = true;
    const error = await page.evaluate(async proxy => {
      try { await window.api.proxy.checkIp(proxy); return ''; }
      catch (e) { return e.message; }
    }, `http://127.0.0.1:${port}`);
    expect(error).toContain('Proxy CONNECT rejected: 502');

    rejectConnect = false;
    const card = page.locator(`.profile-card[data-profile-id="${profile.id}"]`);
    await card.locator('.proxy-none-btn').click();
    const input = page.locator(`#proxy-inline-input-${profile.id}`);
    await input.fill(`http://127.0.0.1:${port}`);
    await input.press('Enter');
    await expect(card.locator('.proxy-scheme-badge')).toHaveText('HTTP');
    await expect(card.locator('.proxy-country-code')).toHaveText('FX');
    const saved = await page.evaluate(id => window.api.profiles.getAll().then(items => items.find(item => item.id === id)), profile.id);
    expect(saved.proxyServer).toBe(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (!page.isClosed()) await page.evaluate(id => window.api.profiles.delete(id), profile.id);
  }
});

test('kernel download reports progress, lists the installed fixture, and deletes it', async () => {
  const bytes = Buffer.from('MZ local kernel fixture');
  let fail = false;
  const server = http.createServer((_request, response) => {
    if (fail) { response.writeHead(404); response.end('missing'); return; }
    response.writeHead(200, { 'content-length': bytes.length });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const version = `fixture-${process.pid}-${Date.now()}`;
  try {
    const result = await page.evaluate(async ({ url, version }) => {
      const progress = [];
      const offProgress = window.api.on('kernel:downloadProgress', event => {
        if (event.version === version) progress.push(event.progress);
      });
      const complete = new Promise(resolve => {
        const off = window.api.on('kernel:downloadComplete', event => {
          if (event.version === version) { off(); resolve(event); }
        });
      });
      try {
        const download = await window.api.kernel.download({ downloadUrl: url, fileName: 'kernel-fixture.exe', version });
        return { download, complete: await complete, progress };
      } finally { offProgress(); }
    }, { url: `http://127.0.0.1:${port}/kernel.exe`, version });
    expect(result.download.installStatus).toBe('ready');
    expect(result.complete).toMatchObject({ version, installStatus: 'ready' });
    expect(result.progress.at(-1)).toBe(100);
    const installed = await page.evaluate(() => window.api.kernel.listInstalled());
    expect(installed.find(item => item.version === version)).toMatchObject({ fileName: 'kernel-fixture.exe', installStatus: 'ready' });
    expect(await page.evaluate(version => window.api.kernel.delete(version), version)).toBe(true);
    expect((await page.evaluate(() => window.api.kernel.listInstalled())).some(item => item.version === version)).toBe(false);

    fail = true;
    const failedVersion = `${version}-missing`;
    const error = await page.evaluate(async ({ url, version }) => {
      try {
        await window.api.kernel.download({ downloadUrl: url, fileName: 'missing.exe', version });
        return '';
      } catch (e) { return e.message; }
    }, { url: `http://127.0.0.1:${port}/missing.exe`, version: failedVersion });
    expect(error).toContain('Download failed: HTTP 404');
    await page.evaluate(version => window.api.kernel.delete(version), failedVersion);
  } finally {
    await page.evaluate(version => window.api.kernel.delete(version), version);
    await new Promise(resolve => server.close(resolve));
  }
});

test('kernel download can be cancelled and removes partial files', async () => {
  const version = `cancel-${Date.now()}`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 100000 });
    response.write(Buffer.alloc(1024, 1));
    setTimeout(() => response.end(Buffer.alloc(98976, 2)), 30000);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow.exe`;
  try {
    const result = await page.evaluate(async ({ url, version }) => {
      const progress = new Promise(resolve => {
        const off = window.api.on('kernel:downloadProgress', event => {
          if (event.version === version) { off(); resolve(); }
        });
      });
      const download = window.api.kernel.download({ downloadUrl: url, fileName: 'slow.exe', version })
        .then(() => ({ status: 'resolved' }), error => ({ status: 'rejected', message: error.message }));
      await progress;
      const cancelled = await window.api.kernel.cancelDownload(version);
      return { cancelled, result: await download, installed: await window.api.kernel.listInstalled() };
    }, { url, version });
    expect(result.cancelled).toBe(true);
    expect(result.result.status).toBe('rejected');
    expect(result.result.message).toContain('cancel');
    expect(result.installed.some(item => item.version === version)).toBe(false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await page.evaluate(version => window.api.kernel.delete(version), version);
  }
});

test('kernel manager exposes platform capabilities and extractor guidance', async () => {
  const capabilities = await page.evaluate(() => window.api.kernel.getCapabilities());
  expect(capabilities).toMatchObject({ platform: 'win32', zipExtractor: true });
  expect(typeof capabilities.sevenZipExtractor).toBe('boolean');
  if (!capabilities.sevenZipExtractor) {
    const version = `7z-missing-${Date.now()}`;
    const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-length': 4 }); response.end('7z!'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await page.evaluate(async ({ url, version }) => window.api.kernel.download({ downloadUrl: url, fileName: 'fixture.7z', version }), { url: `http://127.0.0.1:${server.address().port}/fixture.7z`, version });
      expect(result.installStatus).toBe('downloaded');
      expect(result.installNote).toMatch(/7z|not recognized|failed/i);
    } finally {
      await page.evaluate(version => window.api.kernel.delete(version), version);
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('browser launch maps saved profile proxy, cookies, CDP port, and start URL to arguments', async () => {
  const oldSettings = await page.evaluate(() => window.api.settings.get());
  const profile = await page.evaluate(async () => window.api.profiles.create({
    name: `Launch args ${Date.now()}`,
    proxyServer: 'http://127.0.0.1:8080',
    cookies: '[{"name":"sid","value":"fixture"}]',
    remoteDebuggingPort: '9333',
    proxyPacUrl: 'file:///tmp/proxy.pac',
    disableQuic: true,
    videoFps: '30:real',
    v8Log: 'sample',
    v8LogDir: 'C:\\logs',
    jsHeapSizeLimit: 33554432,
    storageQuota: 'real',
    startUrl: 'https://example.test/profile-start'
  }));
  const userDataDir = path.join(oldSettings.defaultUserDataDir, profile.id, 'user-data-dir');
  try {
    await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
    const stop = page.evaluate(id => new Promise(resolve => {
      const off = window.api.on('instance:stopped', event => {
        if (event.profileId === id) { off(); resolve(); }
      });
    }), profile.id);
    const started = await page.evaluate(id => window.api.browser.launch(id), profile.id);
    expect(started.args).toContain(`--user-data-dir=${userDataDir}`);
    expect(started.args).toContain('--restore-last-session');
    expect(started.args).toContain('--no-first-run');
    expect(started.args).toContain(`--bot-title=${profile.name}`);
    expect(started.args).toContain('--proxy-server=http://127.0.0.1:8080');
    expect(started.args).toContain('--proxy-pac-url=file:///tmp/proxy.pac');
    expect(started.args).toContain('--disable-quic');
    expect(started.args).toContain('--bot-video-fps=30:real');
    expect(started.args).toContain('--bot-v8-log=sample');
    expect(started.args).toContain('--bot-v8-log-dir=C:\\logs');
    expect(started.args).toContain('--bot-js-heap-size-limit=33554432');
    expect(started.args).toContain('--bot-storage-quota=real');
    expect(started.args).toContain('--bot-cookies=[{"name":"sid","value":"fixture"}]');
    expect(started.args).toContain('--remote-debugging-port=9333');
    expect(started.args).toContain('https://example.test/profile-start');
    await page.evaluate(id => window.api.browser.stop(id), profile.id);
    expect(await Promise.race([stop.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))])).toBe(true);

    fs.mkdirSync(userDataDir, { recursive: true });
    const savedCookiesPath = path.join(userDataDir, 'saved-cookies.json');
    fs.writeFileSync(savedCookiesPath, '[{"name":"restored","value":"fixture"}]');
    await page.evaluate(id => window.api.profiles.update(id, { cookies: '' }), profile.id);
    const restoredStop = page.evaluate(id => new Promise(resolve => {
      const off = window.api.on('instance:stopped', event => {
        if (event.profileId === id) { off(); resolve(); }
      });
    }), profile.id);
    const restored = await page.evaluate(id => window.api.browser.launch(id), profile.id);
    expect(restored.args).toContain(`--bot-cookies=@${savedCookiesPath}`);
    await page.evaluate(id => window.api.browser.stop(id), profile.id);
    expect(await Promise.race([restoredStop.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))])).toBe(true);
  } finally {
    await page.evaluate(async ({ id, settings }) => {
      await window.api.profiles.delete(id);
      await window.api.settings.set({ botBrowserPath: settings.botBrowserPath });
    }, { id: profile.id, settings: oldSettings });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('profile context menu copies the launch command', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({
    name: `CLI fixture ${Date.now()}`,
    proxyServer: 'http://127.0.0.1:8080'
  }));
  try {
    await page.reload();
    await page.locator(`[data-action="show-context"][data-id="${profile.id}"]`).click();
    await page.locator(`[data-action="copy-cli-command"][data-id="${profile.id}"]`).click();
    const command = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(command).toContain('--bot-profile=<path-to-profile>');
    expect(command).toContain('--proxy-server=http://127.0.0.1:8080');
    expect(command).toContain(`--bot-title=${profile.name}`);
    await expect(page.locator('.toast-success')).toContainText('CLI command copied');
  } finally {
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
  }
});
test('browser stop contracts handle absent and empty running instances', async () => {
  const result = await page.evaluate(async () => ({
    stopped: await window.api.browser.stop('missing-profile'),
    stopAll: await window.api.browser.stopAll(),
    running: await window.api.browser.getRunning()
  }));
  expect(result).toEqual({ stopped: false, stopAll: true, running: [] });
});

test('browser stop and stopAll terminate running instances and clear session state', async () => {
  const oldSettings = await page.evaluate(() => window.api.settings.get());
  await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
  const profiles = await page.evaluate(async () => Promise.all([
    window.api.profiles.create({ name: `Stop one ${Date.now()}` }),
    window.api.profiles.create({ name: `Stop two ${Date.now()}` })
  ]));
  try {
    const result = await page.evaluate(async ids => {
      await window.api.browser.launch(ids[0]);
      await window.api.browser.launch(ids[1]);
      const running = (await window.api.browser.getRunning()).map(item => item.profileId).sort();
      const stoppedOne = await window.api.browser.stop(ids[0]);
      const remaining = (await window.api.browser.getRunning()).map(item => item.profileId);
      const stoppedAll = await window.api.browser.stopAll();
      return { running, stoppedOne, remaining, stoppedAll, after: await window.api.browser.getRunning() };
    }, profiles.map(item => item.id));
    expect(result.running).toEqual(profiles.map(item => item.id).sort());
    expect(result.stoppedOne).toBe(true);
    expect(result.remaining).toEqual([profiles[1].id]);
    expect(result.stoppedAll).toBe(true);
    expect(result.after).toEqual([]);
  } finally {
    await page.evaluate(async ({ ids, settings }) => {
      await window.api.browser.stopAll();
      for (const id of ids) await window.api.profiles.delete(id);
      await window.api.settings.set({ botBrowserPath: settings.botBrowserPath });
    }, { ids: profiles.map(item => item.id), settings: oldSettings });
  }
});

test('CDP cookie save writes a local backup and updates profile metadata', async () => {
  const cookies = [{ name: 'sid', value: 'fixture', domain: 'example.test', path: '/', secure: true }];
  const server = createCdpServer(cookies);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profileId = `cdp-${Date.now()}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-control-cdp-'));
  let profiles = [{ id: profileId, name: 'CDP fixture', cookieCount: 0 }];
  const messages = [];
  const store = {
    get: (key, fallback) => key === 'profiles' ? profiles : fallback,
    set: (key, value) => { if (key === 'profiles') profiles = value; }
  };
  try {
    await saveCookiesViaCDP(profileId, server.address().port, userDataDir, {
      store,
      send: (channel, payload) => messages.push({ channel, payload })
    });
    expect(await fetchCookiesViaCDP(server.address().port)).toEqual(cookies);
    const savePath = path.join(userDataDir, 'saved-cookies.json');
    expect(JSON.parse(fs.readFileSync(savePath, 'utf8'))).toEqual(cookies);
    expect(profiles[0]).toMatchObject({ cookieCount: 1, savedCookiesPath: savePath });
    expect(Date.parse(profiles[0].cookiesSavedAt)).not.toBeNaN();
    expect(messages).toEqual([{ channel: 'profile:cookiesSaved', payload: { profileId, count: 1, path: savePath } }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('release version comparison handles numeric components and invalid values', () => {
  expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
  expect(isNewerVersion('1.2.9', '1.2.10')).toBe(false);
  expect(isNewerVersion('v1.2.10', '1.2.9')).toBe(true);
  expect(isNewerVersion('1.2.10', '1.2.10')).toBe(false);
  expect(isNewerVersion('latest', '1.2.10')).toBe(false);
});

test('update check reports new, already-seen, and unavailable releases', async () => {
  await app.close();
  app = null;
  const suffix = Date.now();
  const kernelTag = `fixture-${suffix}`;
  const controlTag = `v99.0.${suffix}`;
  const server = http.createServer((request, response) => {
    const tag = request.url.includes('BotBrowser-Control') ? controlTag : kernelTag;
    const body = JSON.stringify({ tag_name: tag, name: tag, published_at: '2026-09-26T00:00:00Z', html_url: 'https://example.test/release' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await launchApp({ BOTBROWSER_TEST_RELEASES_API_BASE: `http://127.0.0.1:${server.address().port}` });
  try {
    const first = await page.evaluate(() => window.api.app.checkForUpdates());
    expect(first.kernel.tagName).toBe(kernelTag);
    expect(first.control.tagName).toBe(controlTag);
    expect(first.newKernel).toBe(true);
    expect(first.newControl).toBe(true);

    const second = await page.evaluate(() => window.api.app.checkForUpdates());
    expect(second.newKernel).toBe(false);
    expect(second.newControl).toBe(false);

    await new Promise(resolve => server.close(resolve));
    const unavailable = await page.evaluate(() => window.api.app.checkForUpdates());
    expect(unavailable).toMatchObject({ kernel: null, control: null, newKernel: null, newControl: null });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
test('settings survive app restart', async () => {
  const previousSettings = await page.evaluate(() => window.api.settings.get());
  const defaultProxy = `http://127.0.0.1:${Date.now()}`;
  try {
    await page.evaluate(proxy => window.api.settings.set({ defaultProxy: proxy, legacyField: 'preserve-me' }), defaultProxy);
    await app.close();
    app = null;
    await launchApp();
    const settings = await page.evaluate(() => window.api.settings.get());
    expect(settings.defaultProxy).toBe(defaultProxy);
    expect(settings.legacyField).toBe('preserve-me');
  } finally {
    if (app) await page.evaluate(settings => window.api.settings.set(settings), previousSettings);
  }
});

test('proxy parser handles formats, line numbers, and invalid ports', () => {
  expect(parseProxyLine('user:pass@proxy.example:8080')).toMatchObject({ type: 'http', host: 'proxy.example', port: 8080, username: 'user', password: 'pass' });
  expect(parseProxyLine('socks5://proxy.example:1080')).toMatchObject({ type: 'socks5', port: 1080 });
  expect(parseProxyLine('proxy.example:0')).toBeNull();
  expect(parseProxyText('http://a.test:80\r\n\r\nnot-a-proxy:abc')).toEqual([
    expect.objectContaining({ line: 1, error: null }),
    expect.objectContaining({ line: 3, error: 'Invalid proxy format' })
  ]);
});

test('proxy bulk import reports partial errors, skips duplicates, and cancel has no side effect', async () => {
  const host = `bulk-${Date.now()}.example`;
  const text = `http://${host}:8080\ninvalid:abc\nhttp://${host}:8080`;
  const result = await page.evaluate(text => window.api.proxies.bulkImport(text), text);
  expect(result.imported).toBe(1);
  expect(result.results.map(item => item.error)).toEqual([null, 'Invalid proxy format', 'Duplicate proxy']);
  const saved = await page.evaluate(() => window.api.proxies.getAll());
  expect(saved.filter(item => item.host === host)).toHaveLength(1);
  await page.locator('[data-action="import-proxies"]').click();
  await page.locator('[data-action="cancel-proxy-import"]').first().click();
  expect(await page.locator('#proxy-import-modal').count()).toBe(0);
  await page.evaluate(async host => { for (const item of await window.api.proxies.getAll()) if (item.host === host) await window.api.proxies.delete(item.id); }, host);
});

test('profile ZIP export/import round-trips safe fields and rejects corrupt archives', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({ name: `Zip profile ${Date.now()}`, startUrl: 'https://example.test', cookies: '[{"name":"secret"}]' }));
  const archive = path.join(os.tmpdir(), `botbrowser-profile-${Date.now()}.zip`);
  try {
    const exported = await page.evaluate(({ id, destination }) => window.api.profiles.exportZip({ ids: [id], destination }), { id: profile.id, destination: archive });
    expect(exported.count).toBe(1);
    const zip = await JSZip.loadAsync(fs.readFileSync(archive));
    const payload = JSON.parse(await zip.file('profiles.json').async('string'))[0];
    expect(payload).toMatchObject({ name: profile.name, startUrl: profile.startUrl });
    expect(payload.cookies).toBeUndefined();
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
    const imported = await page.evaluate(source => window.api.profiles.importZip(source), archive);
    expect(imported.count).toBe(1);
    expect(imported.profiles[0]).toMatchObject({ name: profile.name, startUrl: profile.startUrl, status: 'stopped' });
    const corrupt = path.join(os.tmpdir(), `botbrowser-corrupt-${Date.now()}.zip`);
    fs.writeFileSync(corrupt, 'not a zip');
    await expect(page.evaluate(source => window.api.profiles.importZip(source), corrupt)).rejects.toThrow();
    fs.rmSync(corrupt, { force: true });
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) {
      if (item.name.startsWith('Zip profile ')) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    }
    fs.rmSync(archive, { force: true });
  }
});

test('profile ZIP import rejects traversal entries without persisting profiles', async () => {
  const archive = path.join(os.tmpdir(), `botbrowser-traversal-${Date.now()}.zip`);
  const name = `Traversal sentinel ${Date.now()}`;
  try {
    await page.evaluate(name => window.api.profiles.create({ name }), name);
    const before = await page.evaluate(() => window.api.profiles.getAll());
    const zip = new JSZip();
    zip.file('../outside.json', '{}');
    zip.file('profiles.json', JSON.stringify([{ name: 'Must not import' }]));
    fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(page.evaluate(source => window.api.profiles.importZip(source), archive)).rejects.toThrow(/Invalid profile archive/);
    expect(await page.evaluate(() => window.api.profiles.getAll())).toEqual(before);
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) if (item.name === name) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    fs.rmSync(archive, { force: true });
  }
});

test('profile ZIP import suffixes duplicate names and invalid input has no side effect', async () => {
  const archive = path.join(os.tmpdir(), `botbrowser-duplicate-${Date.now()}.zip`);
  const name = `Duplicate ZIP ${Date.now()}`;
  try {
    await page.evaluate(name => window.api.profiles.create({ name }), name);
    const zip = new JSZip();
    zip.file('profiles.json', JSON.stringify([{ name, startUrl: 'https://example.test/imported' }]));
    fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }));
    const imported = await page.evaluate(source => window.api.profiles.importZip(source), archive);
    expect(imported.profiles[0].name).toBe(`${name} (Imported 2)`);
    const beforeInvalid = await page.evaluate(() => window.api.profiles.getAll());
    await expect(page.evaluate(() => window.api.profiles.importZip(null))).rejects.toThrow(/Invalid import path/);
    expect(await page.evaluate(() => window.api.profiles.getAll())).toEqual(beforeInvalid);
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) if (item.name.startsWith(name)) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    fs.rmSync(archive, { force: true });
  }
});

test('profile ZIP import leaves stored profiles unchanged after corrupt archive failure', async () => {
  const archive = path.join(os.tmpdir(), `botbrowser-corrupt-unchanged-${Date.now()}.zip`);
  const name = `Corrupt sentinel ${Date.now()}`;
  try {
    await page.evaluate(name => window.api.profiles.create({ name }), name);
    const before = await page.evaluate(() => window.api.profiles.getAll());
    fs.writeFileSync(archive, 'not a zip');
    await expect(page.evaluate(source => window.api.profiles.importZip(source), archive)).rejects.toThrow();
    expect(await page.evaluate(() => window.api.profiles.getAll())).toEqual(before);
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) if (item.name === name) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    fs.rmSync(archive, { force: true });
  }
});
test('profile CSV round-trips quoted fields and excludes sensitive data', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({ name: `CSV, profile\n${Date.now()}`, startUrl: 'https://example.test/?a=1,2', proxyServer: 'http://proxy.example:80', cookies: '[{"name":"secret"}]' }));
  const csvPath = path.join(os.tmpdir(), `botbrowser-profile-${Date.now()}.csv`);
  try {
    await page.evaluate(({ id, destination }) => window.api.profiles.exportCsv({ ids: [id], destination }), { id: profile.id, destination: csvPath });
    const csv = fs.readFileSync(csvPath, 'utf8');
    expect(csv).not.toContain('secret');
    expect(parseCsv(csv)[1][0]).toContain('CSV, profile');
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
    const imported = await page.evaluate(source => window.api.profiles.importCsv(source), csvPath);
    expect(imported.count).toBe(1);
    expect(imported.profiles[0]).toMatchObject({ startUrl: profile.startUrl, proxyServer: profile.proxyServer });
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) if (item.name.startsWith('CSV, profile')) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    fs.rmSync(csvPath, { force: true });
  }
});

test('warmup visits valid URLs in order and continues after fixture failures', async () => {
  expect(validateWarmupUrl('ftp://example.test')).toBeNull();
  const calls = [];
  const results = await runWarmupUrls(['http://one.test', 'bad-url', 'http://two.test'], {
    request: async url => { calls.push(url); if (url.includes('one')) return { ok: true, status: 200 }; throw new Error('fixture failure'); }
  });
  expect(calls).toEqual(['http://one.test/', 'http://two.test/']);
  expect(results.map(result => result.ok)).toEqual([true, false, false]);
});

test('warmup launch adds an ephemeral CDP port without changing profile settings', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({ name: `Warmup launch ${Date.now()}` }));
  const oldSettings = await page.evaluate(() => window.api.settings.get());
  try {
    await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
    const started = await page.evaluate(id => window.api.browser.launch(id, { warmup: true }), profile.id);
    const portArg = started.args.find(arg => arg.startsWith('--remote-debugging-port='));
    expect(Number(portArg?.split('=')[1])).toBeGreaterThan(0);
    expect((await page.evaluate(id => window.api.profiles.getAll().then(items => items.find(item => item.id === id)), profile.id)).remoteDebuggingPort).toBeFalsy();
    await page.evaluate(id => window.api.browser.stop(id), profile.id);
  } finally {
    await page.evaluate(async ({ id, settings }) => {
      await window.api.profiles.delete(id);
      await window.api.settings.set({ botBrowserPath: settings.botBrowserPath });
    }, { id: profile.id, settings: oldSettings });
  }
});

test('warmup sends Page.navigate in order and honors stop-on-failure', async () => {
  const calls = [];
  const createSession = async port => ({
    async navigate(url) {
      calls.push(['Page.navigate', port, url]);
      if (url.includes('two')) throw new Error('fixture CDP failure');
      calls.push(['Page.loadEventFired', url]);
    },
    close() { calls.push(['close']); }
  });
  const urls = ['http://one.test', 'http://two.test', 'http://three.test'];
  const continued = await runWarmupUrls(urls, { cdpPort: 9333, createSession });
  expect(continued.map(result => result.ok)).toEqual([true, false, true]);
  expect(calls.map(call => call[0])).toEqual(['Page.navigate', 'Page.loadEventFired', 'Page.navigate', 'Page.navigate', 'Page.loadEventFired', 'close']);
  calls.length = 0;
  const stopped = await runWarmupUrls(urls, { cdpPort: 9333, createSession, continueOnError: false });
  expect(stopped.map(result => result.ok)).toEqual([true, false]);
  expect(calls.filter(call => call[0] === 'Page.navigate').map(call => call[2])).toEqual(['http://one.test/', 'http://two.test/']);
});

test('warmup IPC rejects requests without the matching running profile', async () => {
  await expect(page.evaluate(() => window.api.browser.warmup(['http://example.test'], { profileId: 'missing' })))
    .rejects.toThrow(/Launch this profile/);
});

test('warmup uses stock Chrome CDP against ordered local pages', async () => {
  test.skip(process.platform !== 'win32' || !fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe'), 'Stock Chrome smoke is Windows-only');
  const visits = [];
  const fixture = http.createServer((request, response) => {
    if (request.url !== '/favicon.ico') visits.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Warmup fixture</title>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const cdpPort = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-warmup-chrome-'));
  const chrome = childProcess.spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + userDataDir, 'about:blank'
  ], { stdio: 'ignore' });
  const chromeClosed = new Promise(resolve => chrome.once('close', resolve));
  try {
    const urls = ['/first', '/second'].map(route => `http://127.0.0.1:${fixture.address().port}${route}`);
    const results = await runWarmupUrls(urls, { cdpPort, continueOnError: false });
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const finalUrl = targets.find(target => target.type === 'page')?.url;
    expect(results.map(result => result.ok)).toEqual([true, true]);
    expect(visits).toEqual(['/first', '/second']);
    expect(finalUrl).toBe(urls[1]);
  } finally {
    if (chrome.exitCode === null) {
      try { childProcess.execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      await Promise.race([chromeClosed, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('release manifest selects exact platform asset and requires checksum', async () => {
  const manifest = { version: '1.2.3', assets: [
    { platform: 'win32', arch: 'x64', format: 'zip', version: '1.2.3', name: 'BotBrowser Control-1.2.3-win.zip', url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3-win.zip', sha256: 'a'.repeat(64) },
    { platform: 'linux', arch: 'x64', format: 'appimage', version: '1.2.3', name: 'BotBrowser Control-1.2.3.AppImage', url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3.AppImage', sha256: 'b'.repeat(64) },
    { platform: 'linux', arch: 'x64', format: 'tar.gz', version: '1.2.3', name: 'BotBrowser Control-1.2.3.tar.gz', url: 'https://github.com/botswin/BotBrowser-Control/releases/download/v1.2.3/BotBrowser%20Control-1.2.3.tar.gz', sha256: 'c'.repeat(64) }
  ] };
  expect(selectReleaseAsset(manifest, 'win32', 'x64')).toMatchObject({ version: '1.2.3', platform: 'win32' });
  expect(() => selectReleaseAsset(manifest, 'win32', 'arm64')).toThrow(/Missing/);
  await expect(page.evaluate(options => window.api.app.selectReleaseAsset(options), { manifest, platform: 'linux', arch: 'x64', format: 'appimage' })).resolves.toMatchObject({ name: 'BotBrowser Control-1.2.3.AppImage', format: 'appimage' });
  await expect(page.evaluate(options => window.api.app.selectReleaseAsset(options), { manifest, platform: 'linux', arch: 'x64', format: 'tar.gz' })).resolves.toMatchObject({ name: 'BotBrowser Control-1.2.3.tar.gz', format: 'tar.gz' });
  expect(() => selectReleaseAsset({ ...manifest, assets: [{ platform: 'win32', arch: 'x64', format: 'zip', version: '1.2.3', name: 'BotBrowser Control-1.2.3-win.zip', url: 'x' }] }, 'win32', 'x64')).toThrow(/checksum|URL/i);
  await expect(page.evaluate(options => window.api.app.selectReleaseAsset(options), { manifest, platform: 'win32', arch: 'x64' })).resolves.toMatchObject({ version: '1.2.3' });
});

test('Windows bootstrap script pins architecture, verifies SHA-256, and stages atomically', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'setup-windows.ps1'), 'utf8');
  expect(script).toContain("$_.platform -eq 'win32'");
  expect(script).toContain("$_.arch -eq $arch");
  expect(script).toContain('Get-FileHash -Algorithm SHA256');
  expect(script).toContain('Move-Item -LiteralPath $stage');
  expect(script).toContain('Version already installed');
});

test('staged update verifies checksum and preserves failed downloads', async () => {
  const payload = Buffer.from('fixture update package');
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const server = http.createServer((_request, response) => { response.writeHead(200); response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-'));
  try {
    const staged = await stageUpdate({ url: `http://127.0.0.1:${server.address().port}/update`, sha256: hash, version: '2.0.0', stagingDir });
    expect(staged).toMatchObject({ status: 'staged', version: '2.0.0', sha256: hash });
    expect(fs.readFileSync(staged.path)).toEqual(payload);
    expect(fs.existsSync(path.join(stagingDir, '2.0.0.json'))).toBe(true);
    expect(await stageUpdate({ url: `http://127.0.0.1:${server.address().port}/update`, sha256: hash, version: '2.0.0', stagingDir })).toMatchObject({ status: 'staged' });
    expect(require('../src/main/update-stage').getStagedUpdate({ stagingDir, version: '2.0.0' })).toMatchObject({ status: 'staged', version: '2.0.0' });
    expect(require('../src/main/update-stage').cancelStagedUpdate({ stagingDir, version: '2.0.0' })).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, '2.0.0.package'))).toBe(false);
    expect(fs.existsSync(path.join(stagingDir, '2.0.0.json'))).toBe(false);
    await expect(stageUpdate({ url: `http://127.0.0.1:${server.address().port}/update`, sha256: 'a'.repeat(64), version: '2.0.1', stagingDir })).rejects.toThrow(/checksum/);
    expect(fs.existsSync(path.join(stagingDir, '.2.0.1.part'))).toBe(false);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(stagingDir, { recursive: true, force: true }); }
});

test('staged update swap preserves live app and commits only after success', async () => {
  const { applyDirectorySwap, createWindowsSwapScript } = require('../src/main/update-apply');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-swap-'));
  const liveDir = path.join(root, 'live');
  const stagedDir = path.join(root, 'staged');
  const commitPath = path.join(root, 'commit');
  const packagePath = path.join(root, 'update.zip');
  const zip = new JSZip();
  zip.file('BotBrowser Control.exe', 'zip-new');
  fs.writeFileSync(packagePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const { extractUpdatePackage } = require('../src/main/update-apply');
  const extracted = await extractUpdatePackage(packagePath, root, '2.0.9');
  expect(fs.readFileSync(path.join(extracted.stagedDir, 'BotBrowser Control.exe'), 'utf8')).toBe('zip-new');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.mkdirSync(stagedDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'old');
  fs.writeFileSync(path.join(stagedDir, 'BotBrowser Control.exe'), 'new');
  try {
    await expect(Promise.resolve().then(() => applyDirectorySwap({ liveDir, stagedDir, commitPath, version: '2.1.0' }))).resolves.toMatchObject({ status: 'applied', version: '2.1.0' });
    expect(fs.readFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'utf8')).toBe('new');
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('2.1.0');
    expect(fs.existsSync(liveDir + '.old')).toBe(false);
    const script = createWindowsSwapScript({ liveDir, stagedDir: path.join(root, 'next'), commitPath, version: '2.2.0', pid: 123 });
    expect(script).toContain('goto rollback');
    expect(script).toContain('tasklist');
    expect(() => applyDirectorySwap({ liveDir, stagedDir: path.join(root, 'missing'), commitPath, version: '2.2.0' })).toThrow(/missing.*executable/i);
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('2.1.0');
    expect(fs.readFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'utf8')).toBe('new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX staged swap owns its marker and restores the live fixture on failure', () => {
  test.skip(process.platform === 'win32', 'POSIX owner test');
  const { applyDirectorySwap, recoverDirectorySwap } = require('../src/main/update-apply');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-posix-'));
  const liveDir = path.join(root, 'live');
  const stagedDir = path.join(root, 'staged');
  const oldDir = path.join(root, 'live.old');
  const markerPath = path.join(root, 'apply.marker');
  const commitPath = path.join(root, 'commit');
  const executableRelative = 'control-fixture';
  try {
    fs.mkdirSync(liveDir);
    fs.writeFileSync(path.join(liveDir, executableRelative), 'old');
    fs.mkdirSync(stagedDir);
    fs.writeFileSync(path.join(stagedDir, executableRelative), 'new');
    expect(applyDirectorySwap({ liveDir, stagedDir, oldDir, executableRelative, markerPath, commitPath, version: '3.0.0' })).toMatchObject({ status: 'applied' });
    expect(fs.readFileSync(path.join(liveDir, executableRelative), 'utf8')).toBe('new');
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('3.0.0');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(oldDir)).toBe(false);

    fs.mkdirSync(stagedDir);
    fs.writeFileSync(path.join(stagedDir, executableRelative), 'failed');
    fs.unlinkSync(commitPath);
    fs.mkdirSync(commitPath);
    expect(() => applyDirectorySwap({ liveDir, stagedDir, oldDir, executableRelative, markerPath, commitPath, version: '4.0.0' })).toThrow();
    expect(fs.readFileSync(path.join(liveDir, executableRelative), 'utf8')).toBe('new');
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.renameSync(liveDir, oldDir);
    fs.writeFileSync(markerPath, JSON.stringify({ status: 'applying' }));
    recoverDirectorySwap({ liveDir, oldDir, markerPath });
    expect(fs.readFileSync(path.join(liveDir, executableRelative), 'utf8')).toBe('new');
    expect(fs.existsSync(markerPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows swap script executes an atomic temp-directory transaction', () => {
  test.skip(process.platform !== 'win32', 'Windows-only owner test');
  const { createWindowsSwapScript } = require('../src/main/update-apply');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-windows-'));
  const liveDir = path.join(root, 'live');
  const stagedDir = path.join(root, 'staged');
  const oldDir = `${liveDir}.old`;
  const commitPath = path.join(root, 'commit');
  const relaunchExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  const runScript = (script, name) => {
    const scriptPath = path.join(root, name);
    fs.writeFileSync(scriptPath, script, 'utf8');
    return childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', scriptPath], {
      encoding: 'utf8',
      windowsHide: true
    });
  };
  try {

    fs.mkdirSync(liveDir);
    fs.mkdirSync(stagedDir);
    fs.writeFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'old');
    fs.writeFileSync(path.join(stagedDir, 'BotBrowser Control.exe'), 'new');
    fs.writeFileSync(commitPath, 'before');
    let result = runScript(createWindowsSwapScript({ liveDir, stagedDir, oldDir, commitPath, version: '2.2.0', relaunchExe }), 'success.cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'utf8')).toBe('new');
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('2.2.0\r\n');
    expect(fs.existsSync(oldDir)).toBe(false);

    const blockedStage = path.join(root, 'blocked-stage');
    fs.mkdirSync(blockedStage);
    fs.writeFileSync(path.join(blockedStage, 'BotBrowser Control.exe'), 'blocked');
    fs.writeFileSync(commitPath, '2.2.0\r\n');
    result = runScript(createWindowsSwapScript({
      liveDir,
      stagedDir: blockedStage,
      oldDir: path.join(liveDir, 'nested-old'),
      commitPath,
      version: '3.0.0',
      relaunchExe
    }), 'move-failure.cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'utf8')).toBe('new');
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('2.2.0\r\n');
    expect(fs.existsSync(path.join(blockedStage, 'BotBrowser Control.exe'))).toBe(true);

    fs.renameSync(liveDir, oldDir);
    const recoveredStage = path.join(root, 'recovered-stage');
    fs.mkdirSync(recoveredStage);
    fs.writeFileSync(path.join(recoveredStage, 'BotBrowser Control.exe'), 'recovered');
    result = runScript(createWindowsSwapScript({ liveDir, stagedDir: recoveredStage, oldDir, commitPath, version: '4.0.0', relaunchExe }), 'orphan-recovery.cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(liveDir, 'BotBrowser Control.exe'), 'utf8')).toBe('recovered');
    expect(fs.readFileSync(commitPath, 'utf8')).toBe('4.0.0\r\n');
    expect(fs.existsSync(oldDir)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-platform setup scripts bootstrap source builds for the host architecture', async () => {
  const linux = fs.readFileSync(path.join(__dirname, '..', 'setup-linux.sh'), 'utf8');
  const mac = fs.readFileSync(path.join(__dirname, '..', 'setup-macos.sh'), 'utf8');
  const windows = fs.readFileSync(path.join(__dirname, '..', 'setup-windows-source.ps1'), 'utf8');
  expect(linux).toContain('BotBrowser-Control/archive/refs/heads/main.zip');
  expect(linux).toContain('node-v${NODE_VERSION}-linux-${node_arch}');
  expect(linux).toContain('npm run build:linux');
  expect(linux).toContain('botbrowser-control.desktop');
  expect(mac).toContain('BotBrowser-Control/archive/refs/heads/main.zip');
  expect(mac).toContain('node-v${NODE_VERSION}-darwin-${node_arch}');
  expect(mac).toContain('npm run build:mac');
  expect(mac).toContain('BotBrowser Control.app');
  expect(windows).toContain('BotBrowser-Control/archive/refs/heads/main.zip');
  expect(windows).toContain("'npm.cmd') run build:win:x64");
  expect(windows).toContain('BotBrowser Control.lnk');
});


test('profile CSV reports unknown and missing required columns separately', async () => {
  const unknownPath = path.join(os.tmpdir(), `botbrowser-profile-csv-unknown-${Date.now()}.csv`);
  const missingPath = path.join(os.tmpdir(), `botbrowser-profile-csv-missing-${Date.now()}.csv`);
  try {
    fs.writeFileSync(unknownPath, 'name,unexpected\nvalid,value\n', 'utf8');
    fs.writeFileSync(missingPath, 'startUrl,notes\nhttps://example.test,missing name\n', 'utf8');
    await expect(page.evaluate(source => window.api.profiles.importCsv(source), unknownPath)).rejects.toThrow(/Unknown CSV columns: unexpected/);
    await expect(page.evaluate(source => window.api.profiles.importCsv(source), missingPath)).rejects.toThrow(/Missing required CSV columns: name/);
  } finally {
    fs.rmSync(unknownPath, { force: true });
    fs.rmSync(missingPath, { force: true });
  }
});

test('profile CSV imports valid rows and returns row-level errors for invalid rows', async () => {
  const csvPath = path.join(os.tmpdir(), `botbrowser-profile-csv-errors-${Date.now()}.csv`);
  const prefix = `CSV batch ${Date.now()}`;
  try {
    fs.writeFileSync(csvPath, `name,startUrl\n${prefix} one,https://one.test\n,https://invalid.test\n${prefix} two,https://two.test\n`, 'utf8');
    const result = await page.evaluate(source => window.api.profiles.importCsv(source), csvPath);
    expect(result.count).toBe(2);
    expect(result.errors).toEqual([{ row: 3, error: 'Profile name is required' }]);
    expect(result.profiles.map(item => item.name)).toEqual([`${prefix} one`, `${prefix} two`]);
  } finally {
    for (const item of await page.evaluate(() => window.api.profiles.getAll())) if (item.name.startsWith(prefix)) await page.evaluate(id => window.api.profiles.delete(id), item.id);
    fs.rmSync(csvPath, { force: true });
  }
});

test('profile CSV rejects empty files and header-only files without changing profiles', async () => {
  const emptyPath = path.join(os.tmpdir(), `botbrowser-profile-csv-empty-${Date.now()}.csv`);
  const headerPath = path.join(os.tmpdir(), `botbrowser-profile-csv-header-${Date.now()}.csv`);
  const before = await page.evaluate(() => window.api.profiles.getAll());
  try {
    fs.writeFileSync(emptyPath, '', 'utf8');
    fs.writeFileSync(headerPath, 'name,startUrl\n', 'utf8');
    await expect(page.evaluate(source => window.api.profiles.importCsv(source), emptyPath)).rejects.toThrow(/CSV is empty/);
    await expect(page.evaluate(source => window.api.profiles.importCsv(source), headerPath)).rejects.toThrow(/CSV contains no profile rows/);
    expect(await page.evaluate(() => window.api.profiles.getAll())).toEqual(before);
  } finally {
    fs.rmSync(emptyPath, { force: true });
    fs.rmSync(headerPath, { force: true });
  }
});


test('profile clear user data removes only the profile runtime directory and keeps settings', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({ name: `Clear data ${Date.now()}`, startUrl: 'https://example.test' }));
  const settings = await page.evaluate(() => window.api.settings.get());
  const userDataDir = path.join(settings.defaultUserDataDir, profile.id, 'user-data-dir');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Cookies'), 'fixture');
    await expect(page.evaluate(id => window.api.profiles.clearUserData(id), profile.id)).resolves.toMatchObject({ cleared: true });
    expect(fs.existsSync(userDataDir)).toBe(false);
    await expect(page.evaluate(id => window.api.profiles.getAll().then(items => items.find(item => item.id === id)), profile.id)).resolves.toMatchObject({ name: profile.name, startUrl: profile.startUrl });
  } finally {
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
