const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let app;
let page;
let userDataDir;

async function launchApp(env = {}) {
  app = await require('playwright')._electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, ...env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveTitle(/BotBrowser Control/i);
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-accessibility-ui-'));
  await launchApp({ BOTBROWSER_TEST_HOLD_MS: '300000' });
});

test.afterEach(async () => {
  try {
    if (app) await app.close();
  } finally {
    app = null;
    page = null;
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  }
});

test('profile context menu exposes keyboard menuitems and activates actions', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({
    name: `Accessibility menu ${Date.now()}`,
    startUrl: 'https://example.test',
  }));

  try {
    await page.reload();
    const trigger = page.locator(`[data-action="show-context"][data-id="${profile.id}"]`);
    await trigger.click();

    const menu = page.locator('.context-menu');
    const firstItem = menu.locator('[role="menuitem"]').first();
    await expect(firstItem).toBeFocused();
    await expect(menu).toHaveAttribute('role', 'menu');
    await page.keyboard.press('End');
    await expect(menu.locator('[role="menuitem"]').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(firstItem).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.locator('[role="menuitem"]').last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(firstItem).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    const copyItem = menu.locator(`[data-action="copy-cli-command"][data-id="${profile.id}"]`);
    await copyItem.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast-success')).toContainText('CLI command copied');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await copyItem.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.toast-success').last()).toContainText('CLI command copied');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.locator('[data-action="edit-profile"]').focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#f-name')).toBeFocused();
    await page.locator('[data-action="cancel-edit"]').last().click();
  } finally {
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
  }
});

test('profile editor labels focus their associated fields', async () => {
  await page.locator('[data-action="new-profile"]').first().click();

  for (const [id, label] of [
    ['f-name', 'Profile Name *'],
    ['f-group', 'Group'],
    ['f-description', 'Description'],
  ]) {
    await page.locator(`label[for="${id}"]`).click();
    await expect(page.locator(`#${id}`)).toBeFocused();
    await expect(page.locator(`label[for="${id}"]`)).toContainText(label);
  }

  await page.locator('[data-action="cancel-edit"]').last().click();
});

test('profile checkbox exposes a visible focus outline from keyboard navigation', async () => {
  const profile = await page.evaluate(() => window.api.profiles.create({
    name: `Accessibility checkbox ${Date.now()}`,
  }));

  try {
    await page.reload();
    const checkbox = page.locator(`input[data-action="select-profile"][data-id="${profile.id}"]`);
    const checkmark = checkbox.locator('xpath=following-sibling::span[contains(@class,"checkmark")]');

    await checkbox.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(checkbox).toBeFocused();
    await expect(checkbox).toHaveJSProperty('checked', false);

    await expect.poll(async () => checkmark.evaluate(element => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    })).toEqual({ outlineStyle: 'solid', outlineWidth: '2px' });
  } finally {
    await page.evaluate(id => window.api.profiles.delete(id), profile.id);
  }
});
