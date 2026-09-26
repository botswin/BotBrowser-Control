const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const executable = path.join(process.cwd(), 'dist', 'win-unpacked', 'BotBrowser Control.exe');

test('Windows packaged app starts with the expected window and preload bridge', async () => {
  test.skip(!fs.existsSync(executable), 'Run npm run build:win first');
  const app = await require('playwright')._electron.launch({ executablePath: executable, args: [] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveTitle(/BotBrowser Control/i);
    expect(await page.evaluate(() => typeof window.api?.profiles?.getAll)).toBe('function');
  } finally {
    await app.close();
  }
});
