const { test, expect } = require('@playwright/test');
const { getProcessExitEvents } = require('../src/main/process-exit');
let app; let page;
test.beforeEach(async () => { app = await require('playwright')._electron.launch({ args: ['.'], cwd: process.cwd() }); page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await expect(page).toHaveTitle(/BotBrowser Control/i); });
test.afterEach(async () => { if (app) await app.close(); app = null; });
test('starts main window and preload contract', async () => { const api = await page.evaluate(() => ({ platform: window.api.platform, profiles: Object.keys(window.api.profiles), browser: Object.keys(window.api.browser), kernel: Object.keys(window.api.kernel) })); expect(api.platform).toBeTruthy(); expect(api.profiles).toEqual(expect.arrayContaining(['getAll', 'create', 'update', 'delete'])); expect(api.browser).toEqual(expect.arrayContaining(['launch', 'stop', 'getRunning'])); expect(api.kernel).toEqual(expect.arrayContaining(['getCachedReleases', 'listInstalled'])); });
test('profile CRUD persists through store', async () => { const r = await page.evaluate(async () => { const p = await window.api.profiles.create({ name: 'Playwright baseline', cookies: '[{"name":"sid","value":"fixture"}]' }); const u = await window.api.profiles.update(p.id, { proxyServer: 'http://127.0.0.1:8080' }); const all = await window.api.profiles.getAll(); await window.api.profiles.delete(p.id); return { p, u, all }; }); expect(r.p.name).toBe('Playwright baseline'); expect(r.u.proxyServer).toBe('http://127.0.0.1:8080'); expect(r.all.some(p => p.id === r.p.id)).toBeTruthy(); });
test('settings and proxy validation IPC are observable', async () => { const r = await page.evaluate(async () => { const old = await window.api.settings.get(); await window.api.settings.set({ defaultProxy: 'http://127.0.0.1:9' }); const s = await window.api.settings.get(); let error = ''; try { await window.api.proxy.checkIp('not-a-proxy'); } catch (e) { error = e.message; } await window.api.settings.set({ defaultProxy: old.defaultProxy }); return { s, error }; }); expect(r.s.defaultProxy).toBe('http://127.0.0.1:9'); expect(r.error).toMatch(/invalid proxy|ENOTFOUND|proxy/i); });
test('kernel cache and installed-list boundaries are readable without real kernel', async () => { const r = await page.evaluate(async () => ({ cached: await window.api.kernel.getCachedReleases(), installed: await window.api.kernel.listInstalled(), dir: await window.api.kernel.getDir() })); expect(Array.isArray(r.cached) || r.cached === null).toBeTruthy(); expect(Array.isArray(r.installed)).toBeTruthy(); expect(r.dir).toBeTruthy(); });
test('launch boundary reports missing BotBrowser executable', async () => { const error = await page.evaluate(async () => { const p = await window.api.profiles.create({ name: 'Launch boundary', cookies: '[{"name":"sid","value":"fixture"}]' }); let e = ''; try { await window.api.browser.launch(p.id); } catch (x) { e = x.message; } await window.api.profiles.delete(p.id); return e; }); expect(error).toMatch(/executable not found/i); });
test('profile editor filter trims, ignores case, matches labels and ids, clears, and shows no match', async () => {
  await page.locator('[data-action="new-profile"]').first().click();
  const filter = page.locator('#editor-nav-search');
  await filter.fill('  fInGeR  ');
  await expect(page.locator('.editor-tab[data-tab="fingerprint"]')).toHaveCount(1);
  await expect(page.locator('.editor-tab')).toHaveCount(1);
  await filter.fill(' NETWORK ');
  await expect(page.locator('.editor-tab[data-tab="network"]')).toHaveCount(1);
  await expect(page.locator('.editor-tab')).toHaveCount(1);
  await filter.fill(' MORE ');
  await expect(page.locator('.editor-tab')).toHaveCount(2);
  await expect(page.locator('.editor-tab[data-tab="session"]')).toHaveCount(1);
  await expect(page.locator('.editor-tab[data-tab="advanced"]')).toHaveCount(1);
  await filter.fill('finger');
  await page.locator('.editor-tab[data-tab="fingerprint"]').click();
  await expect(page.locator('.editor-tab.active')).toHaveAttribute('data-tab', 'fingerprint');
  await filter.fill('definitely-no-section');
  await expect(page.locator('#editor-nav-items')).toContainText('No match');
  await page.locator('[data-action="clear-editor-nav"]').click();
  await expect(page.locator('.editor-tab')).toHaveCount(7);
  await expect(page.locator('.editor-tab.active')).toHaveAttribute('data-tab', 'fingerprint');
  await page.locator('[data-action="cancel-edit"]').first().click();
});

test('profile editor filter matches a field keyword', async () => {
  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('#editor-nav-search').fill('canvas record');
  await expect(page.locator('.editor-tab')).toHaveCount(1);
  await expect(page.locator('.editor-tab[data-tab="advanced"]')).toHaveCount(1);
  await page.locator('[data-action="cancel-edit"]').first().click();
});

test('kernel resolution precedence is visible in launch args', async () => {
  const cases = [
    { name: 'override', kernelOverride: '133.2', kernel: '131', userAgent: 'Chrome/144.0', expected: '133' },
    { name: 'profile kernel', kernel: '128', userAgent: 'Chrome/144.0', expected: '128' },
    { name: 'Chrome UA', kernel: '', userAgent: 'Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36', expected: '144' },
    { name: 'Safari map', kernel: '', userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15', expected: '149' },
    { name: 'invalid override falls back to UA', kernelOverride: '1000', kernel: '', userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36', expected: '126' },
    { name: 'invalid override falls back to UA', kernelOverride: 'invalid', kernel: '', userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36', expected: '126' },
  ];
  const old = await page.evaluate(() => window.api.settings.get());
  await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
  try {
    for (const item of cases) {
      const profile = await page.evaluate(async item => window.api.profiles.create({ name: `Kernel ${item.name}`, kernelOverride: item.kernelOverride, kernel: item.kernel, userAgent: item.userAgent }), item);
      const args = await page.evaluate(async id => {
        const stop = new Promise(resolve => { const off = window.api.on('instance:stopped', event => { if (event.profileId === id) { off(); resolve(); } }); });
        const result = await window.api.browser.launch(id);
        await Promise.race([stop, new Promise(resolve => setTimeout(resolve, 5000))]);
        return result.args;
      }, profile.id);
      expect(args).toContain(`--bot-kernel=${item.expected}`);
      await page.evaluate(id => window.api.profiles.delete(id), profile.id);
    }
  } finally {
    await page.evaluate(settings => window.api.settings.set({ botBrowserPath: settings.botBrowserPath }), old);
  }
});

test('launch stderr is capped and exposed; preload rejects unlisted events', async () => {
  const old = await page.evaluate(() => window.api.settings.get());
  await page.evaluate(path => window.api.settings.set({ botBrowserPath: path }), process.execPath);
  const profile = await page.evaluate(async () => window.api.profiles.create({ name: 'Stderr cap', userAgent: `X${'x'.repeat(2500)}` }));
  try {
    const payload = await page.evaluate(async id => {
      const error = new Promise(resolve => window.api.on('instance:error', event => { if (event.profileId === id) resolve(event); }));
      const started = await window.api.browser.launch(id);
      return { started, error: await Promise.race([error, new Promise(resolve => setTimeout(() => resolve(null), 8000))]) };
    }, profile.id);
    expect(payload.error).toMatchObject({ profileId: profile.id, code: expect.any(Number) });
    expect(payload.error.stderr.length).toBeLessThanOrEqual(800);
    expect(payload.error.stderr.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => { const off = window.api.on('instance:error', () => {}); const rejected = window.api.on('not-allowed', () => {}); off(); return { accepted: typeof off, rejected }; })).toEqual({ accepted: 'function', rejected: undefined });
    await expect(page.locator('.toast-error')).toContainText(payload.error.stderr.trim().slice(-50));
  } finally {
    await page.evaluate(async ({ id, settings }) => { await window.api.profiles.delete(id); await window.api.settings.set({ botBrowserPath: settings.botBrowserPath }); }, { id: profile.id, settings: old });
  }
});

test('process exit events report only non-zero exit codes as errors', () => {
  expect(getProcessExitEvents('profile-1', 0, 'warning')).toEqual({
    error: null,
    stopped: { profileId: 'profile-1', code: 0, stderr: undefined }
  });
  expect(getProcessExitEvents('profile-1', 7, 'failure')).toEqual({
    error: { profileId: 'profile-1', error: 'BotBrowser exited with code 7', code: 7, stderr: 'failure' },
    stopped: { profileId: 'profile-1', code: 7, stderr: 'failure' }
  });
  expect(getProcessExitEvents('profile-1', null, 'signal')).toEqual({
    error: null,
    stopped: { profileId: 'profile-1', code: null, stderr: undefined }
  });
});

