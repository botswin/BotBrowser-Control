const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let app;
let page;
let userDataDir;
test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-proxies-'));
  app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
    env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1.view-title')).toHaveText('Profiles');
});
test.afterEach(async () => {
  try { if (app) await app.close(); } finally {
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('saved proxies can be managed independently and reused in a profile', async () => {
  page.on('pageerror', error => console.error('RENDERER_ERROR', error.message));
  await page.locator('#nav-proxies').click();
  await expect(page.locator('#nav-proxies')).toHaveClass(/active/);
  await expect(page.locator('h1.view-title')).toHaveText('Proxies');
  await page.locator('[data-action="proxy-new"]').click();
  await page.locator('#pm-name').fill('Fixture gateway');
  await page.locator('#pm-type').selectOption('socks5');
  await page.locator('#pm-host').fill('127.0.0.1');
  await page.locator('#pm-port').fill('9');
  await page.locator('#pm-username').fill('user name');
  await page.locator('#pm-password').fill('secret fixture');
  await page.locator('#proxy-manager-form button[type="submit"]').click();
  await expect(page.locator('.proxy-manager-table tbody tr')).toHaveCount(1);
  const saved = await page.evaluate(() => window.api.proxies.getAll());
  expect(saved[0]).toMatchObject({ name: 'Fixture gateway', type: 'socks5', host: '127.0.0.1', port: 9 });

  await page.locator('[data-action="proxy-edit"]').click();
  await page.locator('#pm-name').fill('Fixture edited');
  await page.locator('#proxy-manager-form button[type="submit"]').click();
  await expect(page.locator('.proxy-manager-table tbody')).toContainText('Fixture edited');

  const destination = path.join(userDataDir, 'proxies.txt');
  await page.evaluate(destination => window.api.proxies.export([], destination), destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('socks5://user%20name:secret%20fixture@127.0.0.1:9\n');

  await page.locator('#nav-profiles').click();
  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('.editor-tab[data-tab="network"]').click();
  await page.locator('#f-savedProxy').selectOption(saved[0].id);
  await expect(page.locator('#f-proxyServer')).toHaveValue('socks5://user%20name:secret%20fixture@127.0.0.1:9');
  await page.locator('[data-action="cancel-edit"]').first().click();

  page.on('pageerror', error => console.error('RENDERER_ERROR', error.message));
  await page.locator('#nav-proxies').click();
  await expect(page.locator('#nav-proxies')).toHaveClass(/active/);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-action="proxy-delete"]').click();
  await expect(page.locator('.proxy-manager-table tbody tr')).toHaveCount(0);
});
test('bulk import, selected check and selected export stay within the proxy collection', async () => {
  await page.locator('#nav-proxies').click();
  await page.locator('[data-action="import-proxies"]').click();
  await page.locator('#proxy-import-input').fill('http://127.0.0.1:9\nsocks5://127.0.0.1:10\nhttp://');
  await page.locator('[data-action="submit-proxy-import"]').click();
  await expect(page.locator('#proxy-import-results')).toContainText('Imported 2; 1 rejected');
  await expect(page.locator('.proxy-manager-table tbody tr')).toHaveCount(2);
  await page.locator('[data-action="cancel-proxy-import"]').first().click();

  const ids = await page.evaluate(async () => (await window.api.proxies.getAll()).map(proxy => proxy.id));
  await page.locator(`[data-action="select-proxy"][data-id="${ids[0]}"]`).check();
  const destination = path.join(userDataDir, 'selected-proxies.txt');
  await page.evaluate(({ ids, destination }) => window.api.proxies.export(ids, destination), { ids: [ids[0]], destination });
  expect(fs.readFileSync(destination, 'utf8')).toBe('http://127.0.0.1:9\n');

  await page.locator('[data-action="proxy-check-all"]').click();
  await expect(page.locator('.proxy-manager-table tbody tr').first()).toContainText('Failed');
  await expect(page.locator('.proxy-manager-table tbody tr').last()).toContainText('Not checked');
  await expect(page.evaluate(() => window.api.proxies.save({ type: 'http', host: 'bad host', port: 80 }))).rejects.toThrow(/Invalid proxy/);
});