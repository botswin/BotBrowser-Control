const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executable = path.join(process.cwd(), 'dist', 'win-unpacked', 'BotBrowser Control.exe');

test('Windows packaged app starts with the expected window and preload bridge', async () => {
  test.skip(!fs.existsSync(executable), 'Run npm run build:win first');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-packaged-'));
  let app;
  try {
    app = await require('playwright')._electron.launch({
      executablePath: executable,
      args: [],
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveTitle(/BotBrowser Control/i);
    expect(await page.evaluate(() => typeof window.api?.profiles?.getAll)).toBe('function');
    expect(await page.evaluate(() => window.api.profiles.getAll())).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
