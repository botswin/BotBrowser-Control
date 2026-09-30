const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const format of ['zip', 'csv']) {
  test(format + ' toolbar export/import handles native dialog cancellation and selected files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-dialog-ui-'));
    const destination = path.join(dir, 'synthetic-profiles.' + format);
    const app = await _electron.launch({ args: ['.'], cwd: process.cwd(), env: {
      ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: path.join(dir, 'data'),
      BOTBROWSER_TEST_RELEASES_API_BASE: 'http://127.0.0.1:1',
    } });
    try {
      const page = await app.firstWindow();
      await page.locator('[data-action="new-profile"]').first().waitFor();
      await app.evaluate(({ dialog }) => {
        globalThis.__dialogSelection = { canceled: true };
        dialog.showOpenDialog = async () => ({
          canceled: globalThis.__dialogSelection.canceled,
          filePaths: [globalThis.__dialogSelection.path],
        });
        dialog.showSaveDialog = async () => ({
          canceled: globalThis.__dialogSelection.canceled,
          filePath: globalThis.__dialogSelection.path,
        });
      });
      await page.evaluate(() => window.api.profiles.create({
        name: 'Synthetic dialog fixture', group: 'Synthetic group',
      }));
      await page.reload();
      await page.locator('[data-action="new-profile"]').first().waitFor();
      const exportAction = format === 'zip' ? 'export-profiles' : 'export-csv';
      const importAction = format === 'zip' ? 'import-profiles' : 'import-csv';
      await page.locator('[data-action="' + exportAction + '"]').click();
      await page.locator('[data-action="' + importAction + '"]').click();
      await expect.poll(() => page.evaluate(() => window.api.profiles.getAll().then(p => p.length))).toBe(1);
      expect(fs.existsSync(destination)).toBe(false);
      await app.evaluate((_, selected) => {
        globalThis.__dialogSelection = { canceled: false, path: selected };
      }, destination);
      await page.locator('[data-action="' + exportAction + '"]').click();
      await expect.poll(() => fs.existsSync(destination)).toBe(true);
      await expect(page.locator('.toast-success').last()).toContainText('Exported 1 profiles');
      await page.evaluate(async () => {
        for (const p of await window.api.profiles.getAll()) await window.api.profiles.delete(p.id);
      });
      await page.reload();
      await page.locator('[data-action="new-profile"]').first().waitFor();
      await page.locator('[data-action="' + importAction + '"]').click();
      await expect.poll(() => page.evaluate(() => window.api.profiles.getAll().then(p => p.length))).toBe(1);
      await expect(page.locator('.toast-success').last()).toContainText('Imported 1 profiles');
      const restored = await page.evaluate(() => window.api.profiles.getAll());
      expect(restored[0]).toMatchObject({ name: 'Synthetic dialog fixture', group: 'Synthetic group' });
    } finally { await app.close(); }
  });
}
