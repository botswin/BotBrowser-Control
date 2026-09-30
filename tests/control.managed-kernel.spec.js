const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

test('managed kernel downloads on profile creation and replaces a newer same-version asset', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-managed-kernel-'));
  const userDataDir = path.join(fixtureDir, 'user-data');
  let date = '20260927';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  let archive;
  let assetName;
  if (platform === 'win') {
    const exe = path.join(fixtureDir, 'chrome.exe');
    archive = path.join(fixtureDir, 'kernel.7z');
    fs.writeFileSync(exe, 'MZ fake executable fixture');
    execFileSync('7z', ['a', '-t7z', archive, exe], { stdio: 'ignore' });
    assetName = `botbrowser_${date}_151.0.0.1_win_${arch}.7z`;
  } else if (platform === 'mac') {
    const appDir = path.join(fixtureDir, 'BotBrowser.app');
    const macosDir = path.join(appDir, 'Contents', 'MacOS');
    fs.mkdirSync(macosDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>BotBrowser</string></dict></plist>');
    fs.writeFileSync(path.join(macosDir, 'BotBrowser'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(macosDir, 'BotBrowser'), 0o755);
    archive = path.join(fixtureDir, 'kernel.dmg');
    execFileSync('hdiutil', ['create', '-ov', '-format', 'UDZO', '-srcfolder', appDir, archive], { stdio: 'ignore' });
    assetName = `botbrowser_${date}_151.0.0.1_mac_${arch}.dmg`;
  } else {
    const packageDir = path.join(fixtureDir, 'package');
    const exe = path.join(packageDir, 'usr', 'bin', 'chrome');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'DEBIAN'));
    fs.writeFileSync(path.join(packageDir, 'DEBIAN', 'control'), 'Package: botbrowser-fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: test <test@example.invalid>\nDescription: fixture\n');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(exe, 0o755);
    archive = path.join(fixtureDir, 'kernel.deb');
    execFileSync('dpkg-deb', ['--build', packageDir, archive], { stdio: 'ignore' });
    assetName = `botbrowser_${date}_151.0.0.1_linux_${arch}.deb`;
  }
  const bytes = fs.readFileSync(archive);
  let failLookup = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/repos/botswin/BotBrowser/releases') {
      response.writeHead(failLookup ? 503 : 200, { 'content-type': 'application/json' });
      response.end(failLookup ? '{}' : JSON.stringify([{
        id: 1, tag_name: 'v151.0.0.1', prerelease: false,
        assets: [{ name: assetName.replace(/\d{8}/, date), browser_download_url: `http://127.0.0.1:${server.address().port}/asset` }],
      }]));
      return;
    }
    if (request.url === '/asset') {
      response.writeHead(200, { 'content-type': 'application/x-7z-compressed', 'content-length': bytes.length });
      response.end(bytes);
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir,
        BOTBROWSER_TEST_RELEASES_API_BASE: `http://127.0.0.1:${server.address().port}`, BOTBROWSER_TEST_KERNEL_INTERVAL_MS: '500' } });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const profile = await page.evaluate(() => window.api.profiles.create({ name: 'Kernel fixture', userAgent: 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36' }));
    await expect.poll(() => page.evaluate(() => window.api.kernel.listInstalled()), { timeout: 15000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ version: '151.0.0.1' })]));

    date = '20260928';
    // The short fixture interval must trigger this update without editing the profile.
    await expect.poll(() => page.evaluate(() => window.api.kernel.listInstalled()), { timeout: 15000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ version: '151.0.0.1', assetDate: '20260928' })]));

    failLookup = true;
    await page.evaluate(id => window.api.profiles.update(id, { name: 'Kernel fixture offline' }), profile.id);
    await expect.poll(() => page.evaluate(() => window.api.kernel.listInstalled()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ version: '151.0.0.1', assetDate: '20260928' })]));
    failLookup = false;
    const kernelsDir = await page.evaluate(() => window.api.kernel.getDir());
    await app.close(); app = null;
    fs.rmSync(kernelsDir, { recursive: true, force: true });
    app = await _electron.launch({ args: ['.'], cwd: process.cwd(),
      env: { ...process.env, BOTBROWSER_TEST_USER_DATA_DIR: userDataDir,
        BOTBROWSER_TEST_RELEASES_API_BASE: `http://127.0.0.1:${server.address().port}`, BOTBROWSER_TEST_KERNEL_INTERVAL_MS: '500' } });
    const restarted = await app.firstWindow();
    await restarted.waitForLoadState('domcontentloaded');
    await expect.poll(() => restarted.evaluate(() => window.api.kernel.listInstalled()), { timeout: 15000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ version: '151.0.0.1', assetDate: '20260928' })]));
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
