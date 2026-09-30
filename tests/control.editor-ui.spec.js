const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let app, page;
test.beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-editor-ui-'));
  app = await _electron.launch({ args: ['.'], cwd: process.cwd(), env: {
    ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: dir,
    BOTBROWSER_TEST_RELEASES_API_BASE: 'http://127.0.0.1:1',
  } });
  page = await app.firstWindow();
  await page.locator('[data-action="new-profile"]').first().waitFor();
});

test('custom headers survive adding and removing other rows and profile save', async () => {
  await page.locator('[data-action="new-profile"]').first().click();
  await page.locator('#f-name').fill('Header UI fixture');
  await page.locator('.editor-tab[data-tab="network"]').click();
  await page.locator('[data-action="add-header"]').click();
  const rows = page.locator('.custom-header-row');
  await rows.first().locator('input').nth(0).fill('X-First');
  await rows.first().locator('input').nth(1).fill('first-value');
  await page.locator('[data-action="add-header"]').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('input').nth(0)).toHaveValue('X-First');
  await expect(rows.first().locator('input').nth(1)).toHaveValue('first-value');
  await rows.last().locator('input').nth(0).fill('X-Second');
  await rows.last().locator('input').nth(1).fill('second-value');
  await rows.first().locator('[data-action="remove-header"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('input').nth(0)).toHaveValue('X-Second');
  await expect(rows.first().locator('input').nth(1)).toHaveValue('second-value');
  await page.locator('[data-action="save-profile"]').click();
  await expect(page.locator('#profile-editor-overlay')).toHaveCount(0);
  await page.locator('[data-action="edit-profile"]').first().click();
  await page.locator('.editor-tab[data-tab="network"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('input').nth(0)).toHaveValue('X-Second');
  await expect(rows.first().locator('input').nth(1)).toHaveValue('second-value');
});
test.afterEach(async () => { if (app) await app.close(); app = null; });

test('Settings and all editor tabs associate visible labels with focusable fields', async () => {
  await page.locator('[data-nav="settings"]').click();
  for (const label of await page.locator('label.form-label:visible').all()) {
    const target = await label.getAttribute('for');
    expect(target).toBeTruthy();
    await label.click();
    await expect(page.locator('#' + target)).toBeFocused();
  }
  await page.locator('[data-nav="profiles"]').click();
  await page.locator('[data-action="new-profile"]').first().click();
  for (const tab of ['general', 'network', 'identity', 'fingerprint', 'behavior', 'session', 'advanced']) {
    await page.locator('.editor-tab[data-tab="' + tab + '"]').click();
    for (const label of await page.locator('#tab-' + tab + ' label.form-label:visible').all()) {
      const target = await label.getAttribute('for');
      expect(target).toBeTruthy();
      await label.click();
      await expect(page.locator('#' + target)).toBeFocused();
    }
  }
});
test('every editor field round-trips through actual save and reopen', async () => {
  await page.locator('[data-action="new-profile"]').first().click();
  const values = {
    'f-name': 'All fields fixture', 'f-userAgent': 'Synthetic desktop fixture',
    'f-startUrl': 'https://example.test', 'f-warmupUrls': 'https://example.test/one',
    'f-proxyServer': 'socks5://example.test:1080', 'f-proxyIp': '203.0.113.1',
    'f-timezone': 'UTC', 'f-locale': 'en-US', 'f-languages': 'en-US',
    'f-location': '1,2', 'f-localDnsServers': '1.1.1.1',
    'f-windowSize': '1280,720', 'f-screenSize': '1920,1080',
    'f-fps': '60', 'f-videoFps': '30:real', 'f-timeScale': '0.5',
    'f-cookies': '[]', 'f-bookmarks': '[]', 'f-kernel': '',
    'f-platform': 'Windows', 'f-model': 'Synthetic model',
    'f-remoteDebuggingPort': '9222',
  };
  for (const tab of ['general', 'network', 'identity', 'fingerprint', 'behavior', 'session', 'advanced']) {
    await page.locator('.editor-tab[data-tab="' + tab + '"]').click();
    const fields = await page.locator('#tab-' + tab + ' input[id], #tab-' + tab + ' select[id], #tab-' + tab + ' textarea[id]').evaluateAll(nodes =>
      nodes.map(n => ({ id: n.id, tag: n.tagName, type: n.type,
        checked: n.checked, options: n.options ? [...n.options].map(o => o.value) : [] })));
    for (const field of fields) {
      if (field.id === 'f-savedProxy') continue;
      const input = page.locator('#' + field.id);
      if (field.type === 'checkbox') {
        await page.locator('label[for="' + field.id + '"]').click();
        await expect(input).toBeChecked({ checked: !field.checked });
      }
      else if (field.tag === 'SELECT') await input.selectOption(values[field.id] || field.options[1] || field.options[0]);
      else await input.fill(values[field.id] ?? (field.type === 'number' ? '2' : 'synthetic-fixture'));
    }
  }
  const snapshot = () => page.locator('.editor-panel input[id], .editor-panel select[id], .editor-panel textarea[id]').evaluateAll(nodes =>
    Object.fromEntries(nodes.filter(n => n.id !== 'f-savedProxy').map(n => [n.id, n.type === 'checkbox' ? n.checked : n.value])));
  const expected = await snapshot();
  await page.locator('[data-action="save-profile"]').click();
  await expect(page.locator('#profile-editor-overlay')).toHaveCount(0);
  await page.locator('[data-action="edit-profile"]').first().click();
  await expect.poll(snapshot).toEqual(expected);
});
