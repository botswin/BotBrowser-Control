const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const JSZip = require('jszip');

test.skip(process.platform === 'darwin', 'Kernel UI fixture covers Windows ZIP and Linux AppImage flows.');

test('Kernels UI downloads, cancels, uses, and deletes a fixture release', async () => {
  test.setTimeout(90000);
  const version = '151.0.0.1';
  const date = '20260930';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const isWindows = process.platform === 'win32';
  const fileName = isWindows
    ? `botbrowser_${date}_${version}_win_${arch}.exe.zip`
    : `botbrowser_${date}_${version}_linux_${arch}.AppImage`;
  const bytes = isWindows
    ? await new JSZip().file('chrome.exe', Buffer.from('MZ synthetic kernel fixture')).generateAsync({ type: 'nodebuffer' })
    : Buffer.from('#!/bin/sh\nexit 0\n');
  let assetRequests = 0;
  let firstResponseClosed = false;
  let notifyFirstChunk;
  const firstChunk = new Promise(resolve => { notifyFirstChunk = resolve; });
  let slowResponse;
  let fixtureServer;
  let app;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-kernel-ui-'));

  try {
    fixtureServer = http.createServer((request, response) => {
      if (request.url === '/repos/botswin/BotBrowser/releases') {
        const assetUrl = `http://127.0.0.1:${fixtureServer.address().port}/asset`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{
          id: 1,
          tag_name: version,
          name: 'Kernel UI fixture',
          prerelease: false,
          published_at: '2026-09-30T00:00:00Z',
          assets: [{ id: 1, name: fileName, size: bytes.length, browser_download_url: assetUrl }]
        }]));
        return;
      }
      if (request.url !== '/asset') {
        response.writeHead(404);
        response.end();
        return;
      }
      assetRequests++;
      if (assetRequests === 1) {
        slowResponse = response;
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 100000 });
        response.write(Buffer.alloc(1024, 0x5a));
        notifyFirstChunk();
        const timer = setTimeout(() => response.end(Buffer.alloc(98976, 0x5a)), 30000);
        response.on('close', () => {
          clearTimeout(timer);
          firstResponseClosed = true;
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      response.end(bytes);
    });
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));

    app = await _electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOTBROWSER_TEST_USER_DATA_DIR: userDataDir,
        BOTBROWSER_TEST_HOLD_MS: '300000',
        BOTBROWSER_TEST_RELEASES_API_BASE: `http://127.0.0.1:${fixtureServer.address().port}`
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1.view-title')).toHaveText('Profiles');
    await page.locator('#nav-kernels').click();
    await expect(page.locator('.kernel-release-row')).toContainText(version);
    const downloadButton = page.locator(`[data-action="kernel-download"][data-version="${version}"]`);
    await expect(downloadButton).toBeVisible();
    await downloadButton.click();
    await firstChunk;
    const cancelButton = page.locator(`[data-action="kernel-cancel"][data-version="${version}"]`);
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();
    await expect(downloadButton).toBeVisible();
    await expect.poll(() => firstResponseClosed, { timeout: 10000 }).toBe(true);

    const kernelsDir = await page.evaluate(() => window.api.kernel.getDir());
    await expect.poll(() => fs.existsSync(path.join(kernelsDir, version))).toBe(false);

    await downloadButton.click();
    const useButton = page.locator(`.kernel-installed-section [data-action="kernel-use"][data-execpath]`);
    await expect(useButton).toBeVisible({ timeout: 20000 });
    const execPath = await useButton.getAttribute('data-execpath');
    expect(execPath).toContain(isWindows ? 'chrome.exe' : fileName);
    await expect.poll(() => page.evaluate(() => window.api.kernel.listInstalled()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ version, fileName })]));

    await useButton.click();
    await expect.poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ botBrowserPath: execPath });

    const deleteButton = page.locator(`.kernel-installed-section [data-action="kernel-delete"][data-version="${version}"]`);
    const dialogPromise = page.waitForEvent('dialog');
    const deleteClick = deleteButton.click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain(version);
    await dialog.accept();
    await deleteClick;
    await expect(page.locator(`.kernel-installed-section [data-action="kernel-delete"][data-version="${version}"]`)).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.api.kernel.listInstalled()))
      .some(item => item.version === version)).toBe(false);
    expect(fs.existsSync(path.join(kernelsDir, version))).toBe(false);
    expect(assetRequests).toBe(2);
  } finally {
    if (slowResponse && !slowResponse.destroyed) slowResponse.destroy();
    if (app) await app.close();
    if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
