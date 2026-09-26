const { test, expect } = require('@playwright/test');
const http = require('node:http');
const net = require('node:net');
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
const { selectReleaseAsset } = require('../src/main/release-manifest');

let app;
let page;

async function launchApp(env = {}) {
  app = await require('playwright')._electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, ...env } });
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

test.beforeEach(() => launchApp({ BOTBROWSER_TEST_HOLD_MS: '300000' }));
test.afterEach(async () => { if (app) await app.close(); app = null; });

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

test('browser launch maps saved profile proxy, cookies, CDP port, and start URL to arguments', async () => {
  const oldSettings = await page.evaluate(() => window.api.settings.get());
  const profile = await page.evaluate(async () => window.api.profiles.create({
    name: `Launch args ${Date.now()}`,
    proxyServer: 'http://127.0.0.1:8080',
    cookies: '[{"name":"sid","value":"fixture"}]',
    remoteDebuggingPort: '9333',
    startUrl: 'https://example.test/profile-start'
  }));
  const userDataDir = path.join(oldSettings.defaultUserDataDir, profile.id);
  try {
    await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
    const stop = page.evaluate(id => new Promise(resolve => {
      const off = window.api.on('instance:stopped', event => {
        if (event.profileId === id) { off(); resolve(); }
      });
    }), profile.id);
    const started = await page.evaluate(id => window.api.browser.launch(id), profile.id);
    expect(started.args.some(arg => arg.startsWith('--user-data-dir='))).toBe(true);
    expect(started.args).toContain('--restore-last-session');
    expect(started.args).toContain('--no-first-run');
    expect(started.args).toContain(`--bot-title=${profile.name}`);
    expect(started.args).toContain('--proxy-server=http://127.0.0.1:8080');
    expect(started.args).toContain('--bot-cookies=[{"name":"sid","value":"fixture"}]');
    expect(started.args).toContain('--remote-debugging-port=9333');
    expect(started.args).toContain('https://example.test/profile-start');
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
    expect(await Promise.race([restoredStop.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))])).toBe(true);
  } finally {
    await page.evaluate(async ({ id, settings }) => {
      await window.api.profiles.delete(id);
      await window.api.settings.set({ botBrowserPath: settings.botBrowserPath });
    }, { id: profile.id, settings: oldSettings });
    fs.rmSync(userDataDir, { recursive: true, force: true });
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
  const controlTag = `control-v99.0.${suffix}`;
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

test('warmup IPC uses local fixture and supports stop-on-failure', async () => {
  const result = await page.evaluate(async () => window.api.browser.warmup(['http://127.0.0.1:1/unavailable', 'bad-url'], { continueOnError: false }));
  expect(result.results).toHaveLength(1);
  expect(result.results[0].ok).toBe(false);
});

test('release manifest selects exact platform asset and requires checksum', async () => {
  const manifest = { version: '1.2.3', assets: [
    { platform: 'win32', arch: 'x64', url: 'https://example.test/win.zip', sha256: 'a'.repeat(64) },
    { platform: 'linux', arch: 'x64', url: 'https://example.test/linux.tar.gz', sha256: 'b'.repeat(64) }
  ] };
  expect(selectReleaseAsset(manifest, 'win32', 'x64')).toMatchObject({ version: '1.2.3', platform: 'win32' });
  expect(() => selectReleaseAsset(manifest, 'win32', 'arm64')).toThrow(/Missing/);
  expect(() => selectReleaseAsset({ ...manifest, assets: [{ platform: 'win32', arch: 'x64', url: 'x' }] }, 'win32', 'x64')).toThrow(/checksum/);
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
