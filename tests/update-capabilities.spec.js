const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getUpdateCapabilities } = require('../src/main/update-capabilities');

test('update capabilities reject source mode and unsupported inputs', () => {
  expect(getUpdateCapabilities({
    isPackaged: false, platform: 'win32', arch: 'x64', executablePath: 'C:\\Program Files\\BotBrowser Control\\BotBrowser Control.exe'
  })).toEqual({ canInstall: false, platform: 'win32', arch: 'x64', format: null });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'linux', arch: 'ia32', executablePath: '/opt/control/BotBrowser Control'
  })).toEqual({ canInstall: false, platform: 'linux', arch: 'ia32', format: null });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'freebsd', arch: 'x64', executablePath: '/opt/control'
  })).toEqual({ canInstall: false, platform: 'freebsd', arch: 'x64', format: null });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'darwin', arch: 'x64', executablePath: '/Applications/BotBrowser Control'
  })).toEqual({ canInstall: false, platform: 'darwin', arch: 'x64', format: null, reason: 'install_path_unavailable' });
});

test('update capabilities select the exact release format for each packaged host', () => {
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'win32', arch: 'arm64', executablePath: 'C:\\Program Files\\BotBrowser Control\\BotBrowser Control.exe'
  })).toEqual({ canInstall: true, platform: 'win32', arch: 'arm64', format: 'zip' });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'darwin', arch: 'x64', executablePath: '/Applications/BotBrowser Control.app/Contents/MacOS/BotBrowser Control'
  })).toEqual({ canInstall: true, platform: 'darwin', arch: 'x64', format: 'zip' });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'linux', arch: 'x64', executablePath: '/opt/BotBrowser Control.AppImage'
  })).toEqual({ canInstall: true, platform: 'linux', arch: 'x64', format: 'appimage' });
  expect(getUpdateCapabilities({
    isPackaged: true, platform: 'linux', arch: 'arm64', executablePath: '/opt/botbrowser/BotBrowser Control'
  })).toEqual({ canInstall: true, platform: 'linux', arch: 'arm64', format: 'tar.gz' });
});

test('update capabilities use the original AppImage while running from a mounted path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botbrowser-appimage-capabilities-'));
  const mountedExecutable = path.join(root, 'mount', 'AppRun');
  const originalAppImage = path.join(root, 'BotBrowser Control.AppImage');
  try {
    fs.mkdirSync(path.dirname(mountedExecutable), { recursive: true });
    fs.writeFileSync(mountedExecutable, 'mounted executable');
    fs.writeFileSync(originalAppImage, 'original AppImage');

    expect(getUpdateCapabilities({
      isPackaged: true,
      platform: 'linux',
      arch: 'x64',
      executablePath: mountedExecutable,
      appImagePath: originalAppImage
    })).toEqual({ canInstall: true, platform: 'linux', arch: 'x64', format: 'appimage' });
    expect(fs.readFileSync(originalAppImage, 'utf8')).toBe('original AppImage');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update capabilities reject invalid AppImage environment paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botbrowser-appimage-capabilities-'));
  const mountedExecutable = path.join(root, 'mount', 'AppRun');
  const directoryPath = path.join(root, 'directory.AppImage');
  try {
    fs.mkdirSync(path.dirname(mountedExecutable), { recursive: true });
    fs.mkdirSync(directoryPath);
    fs.writeFileSync(mountedExecutable, 'mounted executable');

    for (const appImagePath of [
      'relative.AppImage',
      path.join(root, 'missing.AppImage'),
      directoryPath
    ]) {
      expect(getUpdateCapabilities({
        isPackaged: true,
        platform: 'linux',
        arch: 'x64',
        executablePath: mountedExecutable,
        appImagePath
      })).toEqual({ canInstall: false, platform: 'linux', arch: 'x64', format: null, reason: 'install_path_unavailable' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update capabilities reject a mounted AppImage path without APPIMAGE', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botbrowser-appimage-capabilities-'));
  const mountedExecutable = path.join(root, '.mount_control', 'AppRun');
  try {
    fs.mkdirSync(path.dirname(mountedExecutable), { recursive: true });
    fs.writeFileSync(mountedExecutable, 'mounted executable');

    expect(getUpdateCapabilities({
      isPackaged: true,
      platform: 'linux',
      arch: 'x64',
      executablePath: mountedExecutable
    })).toEqual({ canInstall: false, platform: 'linux', arch: 'x64', format: null, reason: 'install_path_unavailable' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
