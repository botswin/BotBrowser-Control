const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let app;
let page;
let server;
let userDataDir;
let releaseRequests;
let failReleases;

test.beforeEach(async () => {
  releaseRequests = 0;
  failReleases = false;
  server = http.createServer((request, response) => {
    if (request.url === '/repos/botswin/BotBrowser/releases') {
      releaseRequests++;
      response.writeHead(failReleases ? 503 : 200, { 'content-type': 'application/json' });
      response.end(failReleases ? '{}' : JSON.stringify([{
        id: 1, tag_name: 'v151.0.0.1', name: 'Fixture kernel', prerelease: false,
        published_at: '2026-09-01T00:00:00Z', assets: [],
      }]));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-kernel-nav-'));
  app = await _electron.launch({
    args: ['.'], cwd: process.cwd(),
    env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir,
      BOTBROWSER_TEST_RELEASES_API_BASE: `http://127.0.0.1:${server.address().port}` },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1.view-title')).toHaveText('Profiles');
});

test.afterEach(async () => {
  try { if (app) await app.close(); } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Kernels is independent from Settings and refreshes on each entry', async () => {
  await page.locator('#nav-settings').click();
  await expect(page.locator('#kernel-manager-card')).toHaveCount(0);
  await page.locator('#nav-kernels').click();
  await expect(page.locator('h1.view-title')).toHaveText('Kernels');
  await expect(page.locator('.kernel-version-tag')).toContainText(['v151.0.0.1']);
  expect(releaseRequests).toBe(1);

  failReleases = true;
  await page.locator('#nav-settings').click();
  await page.locator('#nav-kernels').click();
  await expect(page.getByRole('alert')).toContainText('Could not refresh releases');
  await expect(page.locator('.kernel-version-tag')).toContainText(['v151.0.0.1']);
  expect(releaseRequests).toBe(2);
});