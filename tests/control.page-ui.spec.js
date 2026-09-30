const { test, expect } = require('@playwright/test');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { _electron: electron } = require('playwright');
async function open() { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'control-page-ui-')); const app=await electron.launch({args:['.'],cwd:process.cwd(),env:{...process.env,BOTBROWSER_TEST_USER_DATA_DIR:dir,BOTBROWSER_TEST_HOLD_MS:'300000'}}); const page=await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await page.locator('[data-action="new-profile"]').first().waitFor(); return {app,page,dir}; }
test('Sessions page renders its empty state through navigation', async()=>{const {app,page,dir}=await open();try{await page.locator('[data-nav="sessions"]').click();await expect(page.locator('main')).toContainText(/No active sessions/i);}finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}});
test('Kernels page exposes refresh control through navigation', async()=>{const {app,page,dir}=await open();try{await page.locator('[data-nav="kernels"]').click();await expect(page.locator('[data-action="kernel-refresh"]')).toBeVisible();}finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}});

test('Sessions Stop and Stop All buttons terminate synthetic running sessions', async () => {
  const { app, page } = await open();
  try {
    await page.evaluate(executable => window.api.settings.set({ botBrowserPath: executable, executableMode: 'custom' }), process.execPath);
    const profiles = await page.evaluate(async () => Promise.all([
      window.api.profiles.create({ name: 'Synthetic session one' }),
      window.api.profiles.create({ name: 'Synthetic session two' }),
    ]));
    await page.evaluate(async ids => {
      for (const id of ids) await window.api.browser.launch(id);
    }, profiles.map(p => p.id));
    await page.locator('[data-nav="sessions"]').click();
    await expect(page.locator('[data-action="stop-profile"]')).toHaveCount(2);
    await page.locator('[data-action="stop-profile"][data-id="' + profiles[0].id + '"]').click();
    await expect.poll(() => page.evaluate(() => window.api.browser.getRunning().then(r => r.length))).toBe(1);
    await expect(page.locator('[data-action="stop-profile"]')).toHaveCount(1);
    await page.locator('[data-action="stop-all"]').click();
    await expect.poll(() => page.evaluate(() => window.api.browser.getRunning().then(r => r.length))).toBe(0);
    await expect(page.locator('main')).toContainText(/No active sessions/i);
  } finally {
    await page.evaluate(() => window.api.browser.stopAll());
    await app.close();
  }
});

test('inline proxy Escape cancels and Enter saves without duplicating SOCKS5', async () => {
  const { app, page } = await open();
  const stages = [];
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('proxy:checkIp');
      ipcMain.handle('proxy:checkIp', () => ({
        status: 'success', query: '203.0.113.1', country: 'Test', countryCode: 'TS'
      }));
    });
    const profile = await page.evaluate(() => window.api.profiles.create({ name: 'Inline proxy fixture' }));
    await page.reload();
    await page.locator('[data-action="new-profile"]').first().waitFor();
    const trigger = page.locator('[data-action="open-proxy-editor"][data-id="' + profile.id + '"]');
    const input = page.locator('#proxy-inline-input-' + profile.id);
    await trigger.click();
    await input.fill('socks5://example.test:1080');
    await page.keyboard.press('Escape');
    stages.push('first-escape-complete');
    await expect(input).toHaveCount(0);
    expect(await page.evaluate(id => window.api.profiles.getAll().then(p => p.find(x => x.id === id).proxyServer), profile.id)).toBeFalsy();
    await trigger.click();
    await input.fill('socks5://example.test:1080');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(id => window.api.profiles.getAll().then(p => p.find(x => x.id === id).proxyServer), profile.id))
      .toBe('socks5://example.test:1080');
    stages.push('enter-persisted');
    await trigger.click();
    await expect(input).toHaveValue('socks5://example.test:1080');
    stages.push('reopened-saved-value');
    await page.keyboard.press('Escape');
    stages.push('final-escape-complete');
  } finally {
    const started = Date.now();
    await app.close();
    console.log('INLINE_PROXY_STAGES=' + stages.join('|') + '|app-close-ms:' + (Date.now() - started));
  }
});
test('inline proxy stale blur timer cannot save a reopened edit', async () => {
  const { app, page } = await open();
  let stageSummary = '';
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('proxy:checkIp');
      ipcMain.handle('proxy:checkIp', () => ({
        status: 'success', query: '203.0.113.1', country: 'Test', countryCode: 'TS'
      }));
    });
    const profile = await page.evaluate(() => window.api.profiles.create({ name: 'Blur timer fixture' }));
    await page.reload();
    await page.locator('[data-action="new-profile"]').first().waitFor();
    const trigger = page.locator('[data-action="open-proxy-editor"][data-id="' + profile.id + '"]');
    const input = page.locator('#proxy-inline-input-' + profile.id);
    await trigger.click();
    const stage = await page.evaluate(id => {
      const oldInput = document.querySelector('#proxy-inline-input-' + id);
      const beforeBlur = document.activeElement?.id || document.activeElement?.tagName;
      let blurFired = false;
      oldInput.addEventListener('blur', () => { blurFired = true; });
      oldInput.value = 'socks5://discarded.test:1080';
      oldInput.blur();
      const afterBlur = document.activeElement?.id || document.activeElement?.tagName;
      oldInput.focus();
      oldInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const afterEscape = document.activeElement?.id || document.activeElement?.tagName;
      document.querySelector('[data-action="open-proxy-editor"][data-id="' + id + '"]').click();
      const newInput = document.querySelector('#proxy-inline-input-' + id);
      newInput.value = 'socks5://must-not-save.test:1080';
      newInput.dispatchEvent(new Event('input', { bubbles: true }));
      return { beforeBlur, afterBlur, blurFired, afterEscape, reopened: document.activeElement?.id || document.activeElement?.tagName };
    }, profile.id);
    stageSummary = JSON.stringify(stage);
    expect(stage.blurFired).toBe(true);
    expect(stage.afterEscape).toBe('BODY');
    expect(stage.reopened).toBe('proxy-inline-input-' + profile.id);
    await expect.poll(() => page.evaluate(id => window.api.profiles.getAll()
      .then(profiles => profiles.find(item => item.id === id).proxyServer || ''), profile.id), { timeout: 1000 })
      .toBe('');
  } finally {
    const started = Date.now();
    await app.close();
    console.log('INLINE_PROXY_STAGES=' + stageSummary + '|app-close-ms:' + (Date.now() - started));
  }
});


test('profile Browse cancellation preserves values and selected synthetic paths fill fields', async () => {
  const { app, page } = await open();
  try {
    await app.evaluate(({ dialog }) => {
      globalThis.__browseResult = { canceled: true, filePaths: [] };
      dialog.showOpenDialog = async () => globalThis.__browseResult;
    });
    await page.locator('[data-action="new-profile"]').first().click();
    for (const [id, action] of [['f-profileFilePath', 'browse-file'], ['f-profileDirPath', 'browse-dir']]) {
      await page.locator('#' + id).fill('original-synthetic-value');
      await page.locator('[data-action="' + action + '"][data-target="' + id + '"]').click();
      await expect(page.locator('#' + id)).toHaveValue('original-synthetic-value');
      await app.evaluate(() => { globalThis.__browseResult = { canceled: false, filePaths: ['synthetic-selected-path'] }; });
      await page.locator('[data-action="' + action + '"][data-target="' + id + '"]').click();
      await expect(page.locator('#' + id)).toHaveValue('synthetic-selected-path');
      await app.evaluate(() => { globalThis.__browseResult = { canceled: true, filePaths: [] }; });
    }
    await page.locator('[data-action="cancel-edit"]').last().click();
  } finally { await app.close(); }
});

test('Profiles selection clear and delete confirmation operate on the selected rows', async () => {
  const { app, page } = await open();
  try {
    await page.evaluate(async () => {
      await window.api.profiles.create({ name: 'Batch fixture one' });
      await window.api.profiles.create({ name: 'Batch fixture two' });
    });
    await page.reload();
    await page.locator('[data-action="new-profile"]').first().waitFor();
    await page.locator('label.checkbox-wrap').filter({ has: page.locator('input[data-action="select-profile"]') }).first().click();
    await expect(page.locator('[data-action="delete-selected"]')).toBeVisible();
    await page.locator('[data-action="clear-selection"]').click();
    await expect(page.locator('[data-action="delete-selected"]')).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => window.api.profiles.getAll().then(p => p.length))).toBe(2);
    await page.locator('label.checkbox-wrap').filter({ has: page.locator('#select-all-profiles') }).click();
    await page.evaluate(() => { window.confirm = () => false; });
    await page.locator('[data-action="delete-selected"]').click();
    await expect.poll(() => page.evaluate(() => window.api.profiles.getAll().then(p => p.length))).toBe(2);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator('[data-action="delete-selected"]').click();
    await expect.poll(() => page.evaluate(() => window.api.profiles.getAll().then(p => p.length))).toBe(0);
    await expect(page.locator('input[data-action="select-profile"]')).toHaveCount(0);
  } finally { await app.close(); }
});
