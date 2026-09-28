const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('profile group and description persist, search and round-trip through CSV', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-metadata-'));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir } });
    const page = await app.firstWindow();
    await expect(page.locator('h1.view-title')).toHaveText('Profiles');
    await page.locator('[data-action="new-profile"]').first().click();
    await page.locator('#f-name').fill('Fixture profile');
    await page.locator('#f-group').fill('Research team');
    await page.locator('#f-description').fill('Local fixture note');
    await page.locator('[data-action="save-profile"]').first().click();
    const created = await page.evaluate(() => window.api.profiles.getAll());
    expect(created[0]).toMatchObject({ name: 'Fixture profile', group: 'Research team', description: 'Local fixture note' });

    await page.locator('[data-action="edit-profile"]').first().click();
    await page.locator('#f-group').fill('Updated team');
    await page.locator('#f-description').fill('Updated fixture note');
    await page.locator('[data-action="save-profile"]').first().click();
    expect((await page.evaluate(() => window.api.profiles.getAll()))[0]).toMatchObject({ group: 'Updated team', description: 'Updated fixture note' });

    await page.locator('#search-input').fill('fixture note');
    await expect(page.locator('.profile-card')).toHaveCount(1);
    await expect(page.locator('.profile-card')).toContainText('Updated fixture note');
    await page.locator('#search-input').fill('updated team');
    await expect(page.locator('.profile-card')).toHaveCount(1);

    const destination = path.join(userDataDir, 'profiles.csv');
    await page.evaluate(destination => window.api.profiles.exportCsv({ ids: [], destination }), destination);
    const csv = fs.readFileSync(destination, 'utf8');
    expect(csv.split('\r\n')[0]).toContain('group,description');
    expect(csv).toContain('Updated team,Updated fixture note');
    const imported = await page.evaluate(source => window.api.profiles.importCsv(source), destination);
    expect(imported.profiles[0]).toMatchObject({ group: 'Updated team', description: 'Updated fixture note' });
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});