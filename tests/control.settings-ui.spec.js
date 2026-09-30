const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
test('Settings save button is reachable after renderer bootstrap', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'control-settings-ui-')); const app=await electron.launch({args:['.'],cwd:process.cwd(),env:{...process.env,BOTBROWSER_TEST_USER_DATA_DIR:dir}});
 try { const page=await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await page.locator('[data-action="new-profile"]').first().waitFor(); await page.locator('[data-nav="settings"]').click(); await expect(page.locator('[data-action="save-settings"]')).toBeVisible(); await page.locator('[data-action="save-settings"]').click(); } finally { await app.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
async function openIsolatedSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-settings-regression-'));
  const app = await electron.launch({
    args: ['.'], cwd: process.cwd(),
    env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: dir },
  });
  const page = await app.firstWindow();
  await page.locator('[data-action="new-profile"]').first().waitFor();
  return { app, page };
}

test('source-mode app refuses to replace the development Electron installation', async () => {
  const { app, page } = await openIsolatedSettings();
  try {
    const error = await page.evaluate(async () => {
      try { await window.api.app.applyStagedUpdate('999.0.0'); return ''; }
      catch (e) { return e.message; }
    });
    expect(error).toContain('Control updates require a packaged installation');
    await expect(page.locator('[data-action="new-profile"]').first()).toBeVisible();
  } finally { await app.close(); }
});

test('Settings UI preserves a SOCKS5 proxy through save and reload', async () => {
  const { app, page } = await openIsolatedSettings();
  try {
    await page.locator('[data-nav="settings"]').click();
    await page.locator('#s-defaultProxy').fill('socks5://example.test:1080');
    await page.locator('[data-action="save-settings"]').click();
    await expect.poll(() => page.evaluate(() => window.api.settings.get().then(s => s.defaultProxy)))
      .toBe('socks5://example.test:1080');
    await page.reload();
    await page.locator('[data-action="new-profile"]').first().waitFor();
    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('#s-defaultProxy')).toHaveValue('socks5://example.test:1080');
  } finally {
    await app.close();
  }
});

test('Settings cannot overwrite stored values during delayed initialization', async () => {
  const { app, page } = await openIsolatedSettings();
  try {
    await page.evaluate(() => window.api.settings.set({ defaultProxy: 'socks5://example.test:1080' }));
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('settings:get');
      ipcMain.removeHandler('settings:get');
      ipcMain.handle('settings:get', async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 2500));
        return original(...args);
      });
    });
    await page.reload();
    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('#main-content')).toHaveText('Loading local data...');
    await expect(page.locator('[data-action="save-settings"]')).toHaveCount(0);
    await expect(page.locator('#s-defaultProxy')).toHaveValue('socks5://example.test:1080');
  } finally {
    await app.close();
  }
});
