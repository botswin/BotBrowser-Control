const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('checks application updates at startup and again on the periodic timer', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-timer-'));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
    const page = await app.firstWindow();
    await page.clock.install();
    await app.evaluate(({ ipcMain }) => {
      globalThis.__updateCheckCalls = 0;
      ipcMain.removeHandler('app:checkForUpdates');
      ipcMain.handle('app:checkForUpdates', () => {
        globalThis.__updateCheckCalls++;
        if (globalThis.__updateCheckCalls === 1) throw new Error('fixture network failure');
        return { kernel: null, control: null, newKernel: false, newControl: false };
      });
    });
    await page.reload();
    await page.clock.fastForward(2000);
    await expect.poll(() => app.evaluate(() => globalThis.__updateCheckCalls)).toBe(1);
    await page.clock.fastForward(10 * 60 * 1000);
    await expect.poll(() => app.evaluate(() => globalThis.__updateCheckCalls)).toBe(2);
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('shows a sanitized fallback when update capability lookup fails', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-capabilities-'));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
    const page = await app.firstWindow();
    await page.clock.install();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:getUpdateCapabilities');
      ipcMain.handle('app:getUpdateCapabilities', () => {
        throw new Error('C:\\private\\install\\failure');
      });
      ipcMain.removeHandler('app:checkForUpdates');
      ipcMain.handle('app:checkForUpdates', () => ({
        kernel: null,
        control: { version: '9.9.9', isNewer: true, manifest: { assets: [] } },
        newKernel: false,
        newControl: true
      }));
    });
    await page.reload();
    await page.clock.fastForward(2000);
    await expect(page.locator('#update-banner')).toContainText(
      'Automatic install support unavailable. Open release page.'
    );
    await expect(page.locator('#update-banner')).not.toContainText('C:\\private\\install\\failure');
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('does not offer or apply a staged update when install capabilities are unavailable', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-no-capability-'));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
    const page = await app.firstWindow();
    await page.clock.install();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:getUpdateCapabilities');
      ipcMain.handle('app:getUpdateCapabilities', () => {
        throw new Error('capabilities unavailable');
      });
      ipcMain.removeHandler('app:checkForUpdates');
      ipcMain.handle('app:checkForUpdates', () => ({
        kernel: null,
        control: { version: '9.9.9', isNewer: true, manifest: { assets: [] } },
        newKernel: false,
        newControl: true
      }));
      ipcMain.removeHandler('app:getStagedUpdate');
      ipcMain.handle('app:getStagedUpdate', () => ({ version: '9.9.9', path: 'synthetic-staged-update' }));
      globalThis.__applyStagedUpdateCalls = 0;
      ipcMain.removeHandler('app:applyStagedUpdate');
      ipcMain.handle('app:applyStagedUpdate', () => {
        globalThis.__applyStagedUpdateCalls++;
      });
    });
    await page.reload();
    await page.clock.fastForward(2000);
    await expect(page.locator('#update-banner')).toContainText(
      'Automatic install support unavailable. Open release page.'
    );
    await expect(page.locator('[data-action="apply-control-update"]')).toHaveCount(0);
    await expect(page.locator('[data-action="open-control-releases"]')).toHaveCount(1);

    await page.evaluate(() => {
      const bypass = document.createElement('button');
      bypass.dataset.action = 'apply-control-update';
      document.body.append(bypass);
      bypass.click();
      bypass.remove();
    });
    await expect.poll(() => app.evaluate(() => globalThis.__applyStagedUpdateCalls)).toBe(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('sanitizes stage and apply failures in the update banner', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-failure-messages-'));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
    const page = await app.firstWindow();
    await page.clock.install();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:getUpdateCapabilities');
      ipcMain.handle('app:getUpdateCapabilities', () => ({
        canInstall: true, platform: 'win32', arch: 'x64', format: 'zip'
      }));
      ipcMain.removeHandler('app:checkForUpdates');
      ipcMain.handle('app:checkForUpdates', () => ({
        kernel: null,
        control: {
          version: '9.9.9',
          isNewer: true,
          manifest: { assets: [{ platform: 'win32', arch: 'x64', format: 'zip' }] }
        },
        newKernel: false,
        newControl: true
      }));
      ipcMain.removeHandler('app:getStagedUpdate');
      ipcMain.handle('app:getStagedUpdate', () => null);
      ipcMain.removeHandler('app:selectReleaseAsset');
      ipcMain.handle('app:selectReleaseAsset', () => ({
        url: 'https://updates.invalid/control.zip', sha256: 'a'.repeat(64), version: '9.9.9'
      }));
      ipcMain.removeHandler('app:stageUpdate');
      ipcMain.handle('app:stageUpdate', () => {
        throw new Error('C:\\private\\stage\\failure');
      });
    });
    await page.reload();
    await page.clock.fastForward(2000);
    await page.locator('[data-action="stage-control-update"]').click();
    await expect(page.locator('#update-banner')).toContainText('Could not prepare update. Open release page.');
    await expect(page.locator('#update-banner')).not.toContainText('C:\\private\\stage\\failure');

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:stageUpdate');
      ipcMain.handle('app:stageUpdate', () => ({ version: '9.9.9' }));
      ipcMain.removeHandler('app:applyStagedUpdate');
      ipcMain.handle('app:applyStagedUpdate', () => {
        globalThis.__applyStagedUpdateCalls = (globalThis.__applyStagedUpdateCalls || 0) + 1;
        throw new Error('D:\\private\\apply\\failure');
      });
    });
    await page.locator('[data-action="stage-control-update"]').click();
    await expect(page.locator('#update-banner')).toContainText('Ready to install v9.9.9');
    const dialogAccepted = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await page.locator('[data-action="apply-control-update"]').click();
    await dialogAccepted;
    await expect.poll(() => app.evaluate(() => globalThis.__applyStagedUpdateCalls)).toBe(1);
    await expect(page.locator('#update-banner')).toContainText('Could not prepare update. Open release page.');
    await expect(page.locator('#update-banner')).not.toContainText('D:\\private\\apply\\failure');
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
