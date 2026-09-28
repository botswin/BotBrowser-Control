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