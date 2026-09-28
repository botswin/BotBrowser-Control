const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const https = require('https');
const http = require('http');
const JSZip = require('jszip');
let Store;
const { getProcessExitEvents } = require('./process-exit');
const { saveCookiesViaCDP: saveCookieData } = require('./cookies');
const { isNewerVersion } = require('./version');
const { parseProxyLine, parseProxyText } = require('./proxy-parser');
const { escapeCsv, parseCsv } = require('./csv');
const { runWarmupUrls } = require('./warmup');
const { createReleaseManifest, selectReleaseAsset } = require('./release-manifest');
const { stageUpdate, getStagedUpdate, cancelStagedUpdate } = require('./update-stage');
const { extractUpdatePackage, applyDirectorySwap, applyFileSwap, getPosixInstallUnit, ensureExecutable, createWindowsSwapScript } = require('./update-apply');
const { cleanupOldKernelVersions } = require('./kernel-retention');

// ─── Fix app name BEFORE anything else ───
const testUserDataDir = process.env.BOTBROWSER_TEST_USER_DATA_DIR;
if (testUserDataDir && path.isAbsolute(testUserDataDir)) {
  app.setPath('userData', testUserDataDir);
}
function getAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

app.setName('BotBrowser Control');

// ─── Platform-aware defaults ──────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

function getDefaultBotBrowserPath() {
  if (IS_MAC) return '/Applications/Chromium.app/Contents/MacOS/Chromium';
  if (IS_WIN) return 'C:\\Program Files\\BotBrowser\\chrome.exe';
  return '/usr/bin/botbrowser';
}

function getDefaultUserDataDir() {
  return path.join(app.getPath('userData'), 'browser-profiles');
}

function getProfileUserDataDir(root, profileId) {
  return path.join(root, profileId, 'user-data-dir');
}

const DEFAULT_BOTBROWSER_PATH = getDefaultBotBrowserPath();

// ─── Persistent store ─────────────────────────────────────────────────────────
const STORE_OPTIONS = {
  name: 'botbrowser-control',
  defaults: {
    profiles: [],
    proxies: [],
    settings: {
      botBrowserPath: '',
      executableMode: 'managed',
      defaultUserDataDir: getDefaultUserDataDir(),
      theme: 'dark',
      defaultProxy: '',
      autoLaunch: false,
    },
    windowBounds: { width: 1280, height: 800 },
    lastSeenKernelRelease: null,
    lastSeenControlRelease: null,
    cachedKernelReleases: null,
  }
};

// ─── Runtime state ────────────────────────────────────────────────────────────
const runningInstances = new Map();
const kernelDownloads = new Map();
const managedKernelRequests = new Map();
const tempFiles = new Map();
let mainWindow = null;
let managedKernelUpdateTimer = null;

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    minWidth: 960,
    minHeight: 600,
    ...(IS_MAC ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
    } : {
      frame: true,
    }),
    backgroundColor: '#2c3e50',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,  // disable devtools
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Prevent devtools from opening
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  buildMenu();
}

function buildMenu() {
  const template = [
    ...(IS_MAC ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Profile', accelerator: IS_MAC ? 'Cmd+N' : 'Ctrl+N', click: () => mainWindow?.webContents.send('action', 'new-profile') },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Profiles', accelerator: IS_MAC ? 'Cmd+1' : 'Ctrl+1', click: () => mainWindow?.webContents.send('navigate', 'profiles') },
        { label: 'Running Sessions', accelerator: IS_MAC ? 'Cmd+2' : 'Ctrl+2', click: () => mainWindow?.webContents.send('navigate', 'sessions') },
        { label: 'Settings', accelerator: IS_MAC ? 'Cmd+3' : 'Ctrl+3', click: () => mainWindow?.webContents.send('navigate', 'settings') },
        { type: 'separator' },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(IS_MAC ? [{ type: 'separator' }, { role: 'front' }] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: Profile Management ──────────────────────────────────────────────────

ipcMain.handle('profiles:getAll', () => store.get('profiles', []));

function buildCliCommand(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Profile not found');
  const browserPath = store.get('settings', {}).botBrowserPath || (IS_WIN ? 'chrome.exe' : 'chromium');
  const args = buildLaunchArgs(profile, '<user-data-dir>', '<path-to-profile>');
  return [browserPath, ...args].map((part, index) => index === 0 ? part : '  ' + part).join(' ' + String.fromCharCode(92) + '\n');
}

ipcMain.handle('profiles:copyCliCommand', (_, id) => {
  const profile = store.get('profiles', []).find(item => item.id === id);
  const command = buildCliCommand(profile);
  clipboard.writeText(command);
  return command;
});

function exportableProfile(profile) {
  const copy = { ...profile };
  delete copy.id; delete copy.status; delete copy.createdAt; delete copy.updatedAt;
  delete copy.cookies; delete copy.savedCookiesPath; delete copy.cookiesSavedAt;
  delete copy.profileFilePath; delete copy.profileDirPath;
  return copy;
}

ipcMain.handle('profiles:exportZip', async (_, { ids, destination }) => {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Invalid export path');
  const selected = store.get('profiles', []).filter(profile => !ids?.length || ids.includes(profile.id));
  if (!selected.length) throw new Error('No profiles selected');
  const zip = new JSZip();
  zip.file('profiles.json', JSON.stringify(selected.map(exportableProfile), null, 2));
  fs.writeFileSync(destination, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { count: selected.length, destination };
});

ipcMain.handle('profiles:importZip', async (_, source) => {
  if (!source || !path.isAbsolute(source)) throw new Error('Invalid import path');
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  for (const name of Object.keys(zip.files)) {
    if (name.includes('..') || name.startsWith('/') || name !== 'profiles.json') throw new Error('Invalid profile archive');
  }
  const entry = zip.file('profiles.json');
  if (!entry) throw new Error('Profile archive is missing profiles.json');
  let imported;
  try { imported = JSON.parse(await entry.async('string')); } catch { throw new Error('Invalid profile archive'); }
  if (!Array.isArray(imported)) throw new Error('Invalid profile archive');
  const profiles = store.get('profiles', []);
  const names = new Set(profiles.map(profile => profile.name));
  const created = imported.map(data => {
    if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.name.trim()) throw new Error('Invalid profile record');
    let name = data.name.trim(); let suffix = 2;
    while (names.has(name)) name = `${data.name.trim()} (Imported ${suffix++})`;
    names.add(name);
    const profile = { ...data, name, id: require('crypto').randomUUID(), status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    profiles.push(profile); return profile;
  });
  store.set('profiles', profiles);
  return { count: created.length, profiles: created };
});

const CSV_FIELDS = ['name', 'group', 'description', 'startUrl', 'proxyServer', 'proxyIp', 'proxyBypassRgx', 'userAgent', 'locale', 'timezone', 'platform', 'platformVersion', 'notes'];
ipcMain.handle('profiles:exportCsv', (_, { ids, destination }) => {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Invalid export path');
  const selected = store.get('profiles', []).filter(profile => !ids?.length || ids.includes(profile.id));
  if (!selected.length) throw new Error('No profiles selected');
  const csv = [CSV_FIELDS.join(','), ...selected.map(profile => CSV_FIELDS.map(field => escapeCsv(profile[field])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(destination, csv, 'utf8');
  return { count: selected.length, destination };
});

ipcMain.handle('profiles:importCsv', (_, source) => {
  if (!source || !path.isAbsolute(source)) throw new Error('Invalid import path');
  const rows = parseCsv(fs.readFileSync(source, 'utf8'));
  if (!rows.length) throw new Error('CSV is empty');
  const headers = rows[0].map(header => header.replace(/^\uFEFF/, '').trim());
  const unknown = headers.filter(header => !CSV_FIELDS.includes(header));
  if (unknown.length) throw new Error(`Unknown CSV columns: ${unknown.join(', ')}`);
  const missing = ['name'].filter(field => !headers.includes(field));
  if (missing.length) throw new Error(`Missing required CSV columns: ${missing.join(', ')}`);
  if (rows.length === 1) throw new Error('CSV contains no profile rows');
  const profiles = store.get('profiles', []); const names = new Set(profiles.map(profile => profile.name)); const created = []; const errors = [];
  for (const [offset, values] of rows.slice(1).entries()) {
    const row = offset + 2;
    const data = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    if (!data.name.trim()) { errors.push({ row, error: 'Profile name is required' }); continue; }
    let name = data.name.trim(); let suffix = 2; while (names.has(name)) name = `${data.name.trim()} (Imported ${suffix++})`;
    names.add(name); const profile = { ...data, name, id: require('crypto').randomUUID(), status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    profiles.push(profile); created.push(profile);
  }
  if (!created.length && errors.length) throw new Error(`CSV import failed: ${errors.map(item => `row ${item.row}: ${item.error}`).join('; ')}`);
  if (created.length) store.set('profiles', profiles);
  return { count: created.length, profiles: created, errors };
});

function proxyRecordUrl(proxy) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function normalizeProxyRecord(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid proxy');
  const type = String(input.type || '').trim().toLowerCase();
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  const username = String(input.username || '');
  const password = String(input.password || '');
  if (password && !username) throw new Error('Proxy username is required with a password');
  if (!['http', 'https', 'socks5', 'socks5h'].includes(type) ||
      !host || !Number.isInteger(port) || port < 1 || port > 65535 ||
      /[\s@/?#]/.test(host)) throw new Error('Invalid proxy address');
  const parsed = parseProxyLine(proxyRecordUrl({ type, host, port, username, password }));
  if (!parsed || parsed.host !== host || parsed.port !== port || parsed.type !== type) {
    throw new Error('Invalid proxy address');
  }
  const name = String(input.name || '').trim() || `${host}:${port}`;
  return { name, type, host, port, username, password };
}

ipcMain.handle('proxies:save', (_, input) => {
  const record = normalizeProxyRecord(input);
  const proxies = store.get('proxies', []);
  const index = input.id ? proxies.findIndex(proxy => proxy.id === input.id) : -1;
  if (input.id && index < 0) throw new Error('Proxy not found');
  const saved = index < 0
    ? { ...record, id: require('crypto').randomUUID(), createdAt: new Date().toISOString() }
    : { ...proxies[index], ...record };
  if (index < 0) proxies.push(saved);
  else proxies[index] = saved;
  store.set('proxies', proxies);
  return saved;
});

ipcMain.handle('proxies:export', (_, ids, destination) => {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Invalid export path');
  const proxies = store.get('proxies', []);
  const selected = Array.isArray(ids) && ids.length
    ? proxies.filter(proxy => ids.includes(proxy.id)) : proxies;
  if (!selected.length) throw new Error('No proxies selected');
  fs.writeFileSync(destination, selected.map(proxyRecordUrl).join('\n') + '\n', 'utf8');
  return { count: selected.length, destination };
});
ipcMain.handle('proxies:getAll', () => store.get('proxies', []));
ipcMain.handle('proxies:delete', (_, id) => {
  store.set('proxies', store.get('proxies', []).filter(proxy => proxy.id !== id));
  return true;
});
ipcMain.handle('proxies:bulkImport', (_, text) => {
  const parsed = parseProxyText(text);
  const proxies = store.get('proxies', []);
  const existing = new Set(proxies.map(proxy => `${proxy.type}://${proxy.host}:${proxy.port}:${proxy.username}:${proxy.password}`));
  const imported = [];
  for (const result of parsed) {
    if (!result.proxy) { imported.push(result); continue; }
    const p = result.proxy;
    const key = `${p.type}://${p.host}:${p.port}:${p.username}:${p.password}`;
    if (existing.has(key)) { imported.push({ ...result, proxy: null, error: 'Duplicate proxy' }); continue; }
    const saved = { id: require('crypto').randomUUID(), name: `${p.host}:${p.port}`, ...p, createdAt: new Date().toISOString() };
    proxies.push(saved); existing.add(key); imported.push({ ...result, proxy: saved });
  }
  store.set('proxies', proxies);
  return { results: imported, imported: imported.filter(item => item.proxy).length };
});

ipcMain.handle('profiles:create', (_, profileData) => {
  const profiles = store.get('profiles', []);
  const newProfile = {
    id: require('crypto').randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'stopped',
    ...profileData
  };
  profiles.push(newProfile);
  store.set('profiles', profiles);
  queueManagedKernelForProfile(newProfile);
  return newProfile;
});

ipcMain.handle('profiles:update', (_, { id, updates }) => {
  const profiles = store.get('profiles', []);
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Profile not found');
  profiles[idx] = { ...profiles[idx], ...updates, updatedAt: new Date().toISOString() };
  store.set('profiles', profiles);
  queueManagedKernelForProfile(profiles[idx]);
  return profiles[idx];
});

ipcMain.handle('profiles:delete', (_, id) => {
  const profiles = store.get('profiles', []);
  store.set('profiles', profiles.filter(p => p.id !== id));
  if (runningInstances.has(id)) {
    try { runningInstances.get(id).process.kill('SIGTERM'); } catch {}
    runningInstances.delete(id);
  }
  return true;
});

ipcMain.handle('profiles:deleteMultiple', (_, ids) => {
  const idSet = new Set(ids);
  const profiles = store.get('profiles', []);
  store.set('profiles', profiles.filter(p => !idSet.has(p.id)));
  for (const id of ids) {
    if (runningInstances.has(id)) {
      try { runningInstances.get(id).process.kill('SIGTERM'); } catch {}
      runningInstances.delete(id);
    }
  }
  return true;
});

ipcMain.handle('profiles:duplicate', async (_, id) => {
  const profiles = store.get('profiles', []);
  const original = profiles.find(p => p.id === id);
  if (!original) throw new Error('Profile not found');

  const newId = require('crypto').randomUUID();
  const copy = {
    ...original,
    id: newId,
    name: original.name + ' (Copy)',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'stopped',
    cookieCount: 0,
    cookiesSavedAt: null,
    savedCookiesPath: null,
  };

  const settings = store.get('settings');
  const srcDir = getProfileUserDataDir(settings.defaultUserDataDir, id);
  const dstDir = getProfileUserDataDir(settings.defaultUserDataDir, newId);

  if (fs.existsSync(srcDir)) {
    try {
      copyDirRecursive(srcDir, dstDir);
      const newCookiesPath = path.join(dstDir, 'saved-cookies.json');
      if (fs.existsSync(newCookiesPath)) {
        copy.savedCookiesPath = newCookiesPath;
        try {
          const cookies = JSON.parse(fs.readFileSync(newCookiesPath, 'utf8'));
          copy.cookieCount = Array.isArray(cookies) ? cookies.length : 0;
          copy.cookiesSavedAt = original.cookiesSavedAt;
        } catch {}
      }
    } catch (e) {}
  }

  profiles.push(copy);
  store.set('profiles', profiles);
  return copy;
});

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

ipcMain.handle('profiles:clearUserData', (_, id) => {
  if (!id || typeof id !== 'string' || !/^[a-f0-9-]{20,}$/i.test(id)) throw new Error('Invalid profile id');
  if (runningInstances.has(id)) throw new Error('Stop the profile before clearing user data');
  const root = path.resolve(store.get('settings').defaultUserDataDir);
  const profileDir = path.resolve(root, id);
  const userDataDir = getProfileUserDataDir(root, id);
  if (!profileDir.startsWith(`${root}${path.sep}`)) throw new Error('Invalid user data path');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  return { cleared: true, userDataDir };
});

// ─── IPC: Browser Launch ──────────────────────────────────────────────────────

ipcMain.handle('browser:launch', async (_, launchRequest) => {
  const profileId = typeof launchRequest === 'object' ? launchRequest.profileId : launchRequest;
  const warmup = typeof launchRequest === 'object' && launchRequest.warmup === true;
  let profiles = store.get('profiles', []);
  let profile = profiles.find(p => p.id === profileId);
  if (!profile) throw new Error('Profile not found');

  if (runningInstances.has(profileId)) {
    throw new Error('Profile is already running.');
  }

  if (profile.status === 'running') {
    updateProfileStatus(profileId, 'stopped');
    profile = { ...profile, status: 'stopped' };
  }

  const settings = store.get('settings');
  const kernelMajor = resolveKernel(profile);
  const botBrowserPath = await resolveBrowserExecutable(profile, settings);

  if (!fs.existsSync(botBrowserPath)) {
    throw new Error(
      `BotBrowser executable not found at:\n${botBrowserPath}\n\nInstall the managed kernel for Chrome ${kernelMajor || 'the profile'} or choose a custom executable in Settings.`
    );
  }

  const userDataDir = getProfileUserDataDir(settings.defaultUserDataDir, profileId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const savedCookiesPath = path.join(userDataDir, 'saved-cookies.json');
  if (fs.existsSync(savedCookiesPath) && !profile.cookies) {
    profile = { ...profile, cookies: `@${savedCookiesPath}` };
  }

  let botProfileArg = '';
  if (profile.profileFilePath && fs.existsSync(profile.profileFilePath)) {
    botProfileArg = injectConfigsIntoEncFile(profile.profileFilePath, profile, profileId);
  } else if (profile.profileDirPath && fs.existsSync(profile.profileDirPath)) {
    botProfileArg = null;
  } else {
    botProfileArg = writeStandaloneConfigFile(profile, profileId);
  }

  const args = buildLaunchArgs(profile, userDataDir, botProfileArg);
  if (warmup && !profile.remoteDebuggingPort) args.push(`--remote-debugging-port=${await getAvailableLoopbackPort()}`);

  const testHold = Boolean(process.env.BOTBROWSER_TEST_HOLD_MS && fs.existsSync(botBrowserPath));
  const spawnArgs = testHold
    ? ['-e', `setTimeout(() => {}, ${Number(process.env.BOTBROWSER_TEST_HOLD_MS) || 30000})`, ...args]
    : args;
  const proc = testHold ? (() => {
    const fake = new EventEmitter();
    fake.pid = process.pid + runningInstances.size + 1;
    fake.stdout = new PassThrough();
    fake.stderr = new PassThrough();
    fake.kill = () => { setImmediate(() => fake.emit('close', null)); return true; };
    return fake;
  })() : spawn(botBrowserPath, spawnArgs, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(IS_WIN ? { shell: false } : {})
  });

  const rdpArg = args.find(a => a.startsWith('--remote-debugging-port='));
  const remoteDebuggingPort = rdpArg ? parseInt(rdpArg.split('=')[1], 10) : null;

  const instance = {
    process: proc,
    executablePath: botBrowserPath,
    pid: proc.pid,
    profileId,
    profileName: profile.name,
    startTime: new Date().toISOString(),
    url: profile.startUrl || 'about:blank',
    userDataDir,
    remoteDebuggingPort,
    args
  };

  runningInstances.set(profileId, instance);
  updateProfileStatus(profileId, 'running');

  let stderr = '';
  proc.stdout.on('data', (_data) => {});
  proc.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-800); });

  proc.on('close', (code) => {
    runningInstances.delete(profileId);
    updateProfileStatus(profileId, 'stopped');
    cleanupTempFile(profileId);
    const events = getProcessExitEvents(profileId, code, stderr);
    if (events.error) mainWindow?.webContents.send('instance:error', events.error);
    mainWindow?.webContents.send('instance:stopped', events.stopped);
  });

  proc.on('error', (err) => {
    runningInstances.delete(profileId);
    updateProfileStatus(profileId, 'stopped');
    cleanupTempFile(profileId);
    mainWindow?.webContents.send('instance:error', { profileId, error: err.message, code: err.code || null, stderr });
  });

  mainWindow?.webContents.send('instance:started', { profileId, pid: proc.pid });
  return { pid: proc.pid, args };
});

ipcMain.handle('browser:stop', async (_, profileId) => {
  const testHold = Boolean(process.env.BOTBROWSER_TEST_HOLD_MS);
  if (!runningInstances.has(profileId)) {
    updateProfileStatus(profileId, 'stopped');
    return false;
  }
  const inst = runningInstances.get(profileId);

  if (inst.remoteDebuggingPort && !testHold) {
    try {
      await saveCookiesViaCDP(profileId, inst.remoteDebuggingPort, inst.userDataDir);
    } catch (e) {}
  }

  try { inst.process.kill(IS_WIN ? undefined : 'SIGTERM'); } catch {}
  runningInstances.delete(profileId);
  cleanupTempFile(profileId);
  updateProfileStatus(profileId, 'stopped');
  return true;
});

ipcMain.handle('browser:stopAll', async () => {
  const testHold = Boolean(process.env.BOTBROWSER_TEST_HOLD_MS);
  const savePromises = [];
  for (const [profileId, inst] of runningInstances) {
    if (inst.remoteDebuggingPort && !testHold) {
      savePromises.push(
        saveCookiesViaCDP(profileId, inst.remoteDebuggingPort, inst.userDataDir)
          .catch(_e => {})
      );
    }
  }
  await Promise.allSettled(savePromises);

  for (const [profileId, inst] of runningInstances) {
    try { inst.process.kill(IS_WIN ? undefined : 'SIGTERM'); } catch {}
    cleanupTempFile(profileId);
    updateProfileStatus(profileId, 'stopped');
  }
  runningInstances.clear();
  return true;
});

ipcMain.handle('browser:getRunning', () => {
  const result = [];
  for (const [profileId, inst] of runningInstances) {
    result.push({
      profileId,
      pid: inst.pid,
      profileName: inst.profileName,
      startTime: inst.startTime,
      url: inst.url
    });
  }
  return result;
});

ipcMain.handle('browser:warmup', async (_, { urls, profileId, continueOnError = true } = {}) => {
  const instance = runningInstances.get(profileId);
  if (!instance) throw new Error('Launch this profile before warming it up.');
  if (!instance.remoteDebuggingPort) throw new Error('This profile has no remote debugging port configured.');
  return { results: await runWarmupUrls(urls, { cdpPort: instance.remoteDebuggingPort, continueOnError }) };
});

// ─── IPC: Settings ────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => store.get('settings'));
ipcMain.handle('settings:set', (_, newSettings) => {
  const current = store.get('settings');
  const next = { ...current, ...newSettings };
  if (Object.prototype.hasOwnProperty.call(newSettings || {}, 'botBrowserPath') &&
      !Object.prototype.hasOwnProperty.call(newSettings || {}, 'executableMode')) {
    next.executableMode = newSettings.botBrowserPath ? 'custom' : 'managed';
  }
  store.set('settings', next);
  return true;
});

// ─── IPC: Dialogs ─────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async (_, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    ...options
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:selectExecutable', async () => {
  const filters = IS_WIN
    ? [{ name: 'Executable', extensions: ['exe'] }]
    : [{ name: 'All Files', extensions: ['*'] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:openPath', (_, p) => shell.openPath(p));
ipcMain.handle('shell:showItemInFolder', (_, p) => shell.showItemInFolder(p));

// ─── IPC: Proxy / IP Check ────────────────────────────────────────────────────

/**
 * Parse a proxy URL string into { protocol, host, port, username, password }
 */
function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  let s = proxyStr.trim();
  // Strip accidental double-scheme e.g. "socks5://socks5://host:port"
  s = s.replace(/^(socks5?[ah]?|https?):\/\/(socks5?[ah]?|https?):\/\//i, '$1://');
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) s = 'socks5://' + s;
  try {
    const u = new URL(s);
    const proto = u.protocol.replace(':', '').toLowerCase();
    const host = u.hostname;
    if (!host) return null;
    return {
      protocol: proto,
      host,
      port: parseInt(u.port) || (proto.startsWith('http') ? 8080 : 1080),
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
    };
  } catch { return null; }
}

/**
 * Connect through SOCKS5 proxy using raw TCP (no external deps).
 * Returns a socket connected to targetHost:targetPort via the proxy.
 */
function connectViaSocks5(proxyHost, proxyPort, targetHost, targetPort, username, password) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      // SOCKS5 greeting
      const authMethods = (username && password) ? [0x00, 0x02] : [0x00];
      const greeting = Buffer.from([0x05, authMethods.length, ...authMethods]);
      sock.write(greeting);
    });

    sock.setTimeout(15000);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('SOCKS5 connect timeout')); });
    sock.on('error', reject);

    let state = 'greeting';
    let buf = Buffer.alloc(0);

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (state === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { sock.destroy(); reject(new Error('Not a SOCKS5 server')); return; }
        const method = buf[1];
        buf = buf.slice(2);

        if (method === 0xFF) { sock.destroy(); reject(new Error('SOCKS5: no acceptable auth method')); return; }

        if (method === 0x02) {
          // Username/password auth
          state = 'auth';
          const uBuf = Buffer.from(username || '', 'utf8');
          const pBuf = Buffer.from(password || '', 'utf8');
          const authPkt = Buffer.from([0x01, uBuf.length, ...uBuf, pBuf.length, ...pBuf]);
          sock.write(authPkt);
        } else {
          // No auth — send CONNECT
          state = 'connect';
          sendSocks5Connect(sock, targetHost, targetPort);
        }
        return;
      }

      if (state === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) { sock.destroy(); reject(new Error('SOCKS5 auth failed')); return; }
        buf = buf.slice(2);
        state = 'connect';
        sendSocks5Connect(sock, targetHost, targetPort);
        return;
      }

      if (state === 'connect') {
        if (buf.length < 10) return;  // minimum response
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          const errCodes = { 1: 'General failure', 2: 'Connection not allowed', 3: 'Network unreachable', 4: 'Host unreachable', 5: 'Connection refused' };
          sock.destroy();
          reject(new Error('SOCKS5 connect error: ' + (errCodes[buf[1]] || `code ${buf[1]}`)));
          return;
        }
        // Success — socket is now connected to target
        state = 'done';
        sock.removeAllListeners('data');
        resolve({ socket: sock, remaining: buf.slice(10) });
      }
    });
  });
}

function sendSocks5Connect(sock, host, port) {
  const hostBuf = Buffer.from(host, 'utf8');
  const pkt = Buffer.from([
    0x05, 0x01, 0x00, 0x03,
    hostBuf.length, ...hostBuf,
    (port >> 8) & 0xFF, port & 0xFF
  ]);
  sock.write(pkt);
}

/**
 * Do an HTTP GET through a raw socket (used after SOCKS5 tunnel is established).
 */
function httpGetThroughSocket(socket, host, path, remainingData) {
  return new Promise((resolve, reject) => {
    let data = '';
    const req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: BotBrowserControl/1.0\r\n\r\n`;
    socket.write(req);
    if (remainingData && remainingData.length > 0) {
      data += remainingData.toString();
    }
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
      const bodyStart = data.indexOf('\r\n\r\n');
      const body = bodyStart !== -1 ? data.slice(bodyStart + 4) : data;
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON response from ip-api.com')); }
    });
    socket.on('error', reject);
  });
}

/**
 * Check proxy exit IP via ip-api.com.
 * Supports HTTP, HTTPS (CONNECT tunnel), SOCKS4, SOCKS5.
 */
ipcMain.handle('proxy:checkIp', async (_, proxyServer) => {
  const API_HOST = 'ip-api.com';
  const API_PATH = '/json/?fields=66846719';
  const API_PORT = 80;

  // No proxy — direct request
  if (!proxyServer || !proxyServer.trim()) {
    return doDirectHttpGet(`http://${API_HOST}${API_PATH}`);
  }

  const proxy = parseProxy(proxyServer);
  if (!proxy) throw new Error('Invalid proxy URL');

  const proto = proxy.protocol.toLowerCase();

  // SOCKS5 / SOCKS5H
  if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks4' || proto === 'socks4a') {
    const { socket, remaining } = await connectViaSocks5(
      proxy.host, proxy.port, API_HOST, API_PORT,
      proxy.username, proxy.password
    );
    return httpGetThroughSocket(socket, API_HOST, API_PATH, remaining);
  }

  // HTTP / HTTPS proxy — use CONNECT tunnel
  return doHttpProxyIpCheck(proxy, API_HOST, API_PATH, API_PORT);
});

function doDirectHttpGet(url) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Request timeout')), 15000);
    const req = http.get(url, { headers: { 'User-Agent': 'BotBrowserControl/1.0' } }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        clearTimeout(to);
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', e => { clearTimeout(to); reject(e); });
    req.setTimeout(12000, () => { req.destroy(); clearTimeout(to); reject(new Error('Timeout')); });
  });
}

function doHttpProxyIpCheck(proxy, targetHost, targetPath, targetPort) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Proxy timeout')), 15000);

    const connectTarget = `${targetHost}:${targetPort}`;
    const headers = { 'User-Agent': 'BotBrowserControl/1.0' };
    if (proxy.username && proxy.password) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    }

    const connectReq = http.request({
      method: 'CONNECT',
      hostname: proxy.host,
      port: proxy.port,
      path: connectTarget,
      headers,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        clearTimeout(to);
        reject(new Error(`Proxy CONNECT rejected: ${res.statusCode}`));
        return;
      }
      const req = `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\nUser-Agent: BotBrowserControl/1.0\r\n\r\n`;
      socket.write(req);
      let data = '';
      socket.on('data', d => { data += d.toString(); });
      socket.on('end', () => {
        clearTimeout(to);
        const bodyStart = data.indexOf('\r\n\r\n');
        const body = bodyStart !== -1 ? data.slice(bodyStart + 4) : data;
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
      socket.on('error', e => { clearTimeout(to); reject(e); });
    });

    connectReq.on('error', e => { clearTimeout(to); reject(e); });
    connectReq.setTimeout(12000, () => { connectReq.destroy(); clearTimeout(to); reject(new Error('Connect timeout')); });
    connectReq.end();
  });
}

// ─── IPC: Update Checker ──────────────────────────────────────────────────────

function getReleaseApiUrl(repository, fallback, endpoint = 'releases/latest') {
  try {
    const fixtureBase = new URL(process.env.BOTBROWSER_TEST_RELEASES_API_BASE);
    if (fixtureBase.protocol === 'http:' && fixtureBase.hostname === '127.0.0.1') {
      return new URL(`/repos/${repository}/${endpoint}`, fixtureBase).toString();
    }
  } catch {}
  return fallback;
}

const BOTBROWSER_RELEASES_API = getReleaseApiUrl('botswin/BotBrowser', 'https://api.github.com/repos/botswin/BotBrowser/releases/latest');
const CONTROL_RELEASES_API    = getReleaseApiUrl('botswin/BotBrowser-Control', 'https://api.github.com/repos/botswin/BotBrowser-Control/releases/latest');

ipcMain.handle('app:checkForUpdates', async () => {
  const results = { kernel: null, control: null };

  try {
    const kernelRes = await httpsGet(BOTBROWSER_RELEASES_API);
    if (kernelRes.statusCode === 200) {
      const release = JSON.parse(kernelRes.body);
      results.kernel = {
        tagName: release.tag_name,
        name: release.name || release.tag_name,
        publishedAt: release.published_at,
        url: release.html_url,
      };
    }
  } catch {}

  try {
    const controlRes = await httpsGet(CONTROL_RELEASES_API);
    if (controlRes.statusCode === 200) {
      const release = JSON.parse(controlRes.body);
      const tag = release.tag_name || '';
      const tagMatch = tag.match(/^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
      if (!tagMatch) throw new Error('Invalid Control release tag');
      const remoteVer = tagMatch[1];
      results.control = {
        tagName: tag,
        version: remoteVer,
        name: release.name || tag,
        publishedAt: release.published_at,
        url: release.html_url,
        isNewer: isNewerVersion(remoteVer, app.getVersion()),
        manifest: createReleaseManifest(remoteVer, release.assets, tag),
      };
    }
  } catch {}

  // Persist last seen so we can detect "new since last check"
  const lastKernel  = store.get('lastSeenKernelRelease');
  const lastControl = store.get('lastSeenControlRelease');

  const newKernel  = results.kernel  && results.kernel.tagName  !== lastKernel;
  const newControl = results.control && results.control.tagName !== lastControl && results.control.isNewer;

  if (results.kernel?.tagName)  store.set('lastSeenKernelRelease',  results.kernel.tagName);
  if (results.control?.tagName) store.set('lastSeenControlRelease', results.control.tagName);

  results.newKernel  = newKernel;
  results.newControl = newControl;

  return results;
});

ipcMain.handle('app:selectReleaseAsset', (_, { manifest, platform, arch, format }) => selectReleaseAsset(manifest, platform, arch, format));
ipcMain.handle('app:stageUpdate', (_, options) => stageUpdate({ ...options, stagingDir: path.join(app.getPath('userData'), 'updates') }));
ipcMain.handle('app:getStagedUpdate', (_, version) => getStagedUpdate({ stagingDir: path.join(app.getPath('userData'), 'updates'), version }));
ipcMain.handle('app:cancelStagedUpdate', (_, version) => cancelStagedUpdate({ stagingDir: path.join(app.getPath('userData'), 'updates'), version }));
ipcMain.handle('app:applyStagedUpdate', async (_, version) => {
  const stagingRoot = path.join(app.getPath('userData'), 'updates');
  const pending = getStagedUpdate({ stagingDir: stagingRoot, version });
  if (!pending) throw new Error('No staged update found');
  const liveDir = path.dirname(process.execPath);
  if (!IS_WIN) {
    const liveUnit = getPosixInstallUnit({ platform: process.platform, executablePath: process.execPath });
    if (liveUnit.kind === 'file') {
      const result = applyFileSwap({
        livePath: liveUnit.livePath,
        stagedPath: pending.path,
        version: pending.version,
        commitPath: path.join(stagingRoot, 'current.version'),
        markerPath: path.join(stagingRoot, `.${pending.version}.apply.json`),
      });
      app.relaunch();
      setTimeout(() => app.exit(0), 150);
      return { ...result, status: 'scheduled' };
    }
    const executableName = path.basename(process.execPath);
    const extracted = await extractUpdatePackage(pending.path, stagingRoot, pending.version, executableName);
    const stagedUnit = getPosixInstallUnit({ platform: process.platform, executablePath: extracted.executablePath });
    if (stagedUnit.kind !== 'directory') throw new Error('Staged update has an incompatible installation unit');
    ensureExecutable(extracted.executablePath);
    const result = applyDirectorySwap({
      liveDir: liveUnit.livePath,
      stagedDir: stagedUnit.livePath,
      executableRelative: stagedUnit.executableRelative,
      version: pending.version,
      commitPath: path.join(stagingRoot, 'current.version'),
      markerPath: path.join(stagingRoot, `.${pending.version}.apply.json`),
    });
    app.relaunch();
    setTimeout(() => app.exit(0), 150);
    return { ...result, status: 'scheduled' };
  }
  const extracted = await extractUpdatePackage(pending.path, stagingRoot, pending.version);
  const scriptPath = path.join(stagingRoot, `.${pending.version}.apply.cmd`);
  const script = createWindowsSwapScript({ liveDir, stagedDir: extracted.stagedDir, version: pending.version, commitPath: path.join(stagingRoot, 'current.version'), pid: process.pid });
  fs.writeFileSync(scriptPath, script, 'utf8');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', '/min', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.exit(0), 150);
  return { status: 'scheduled', version: pending.version };
});

// ─── IPC: Kernel Manager ──────────────────────────────────────────────────────

const KERNEL_GITHUB_API = getReleaseApiUrl('botswin/BotBrowser', 'https://api.github.com/repos/botswin/BotBrowser/releases', 'releases');

function httpsGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' && parsedUrl.hostname === '127.0.0.1' ? http : https;
    const req = transport.get(parsedUrl, {
      headers: {
        'User-Agent': 'BotBrowserControl/1.0',
        'Accept': 'application/vnd.github+json',
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.resume();
        if (!location) { reject(new Error('Redirect without location')); return; }
        resolve(httpsGet(location, redirectCount + 1));
        return;
      }
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

ipcMain.handle('kernel:fetchReleases', async () => {
  const res = await httpsGet(KERNEL_GITHUB_API);
  if (res.statusCode !== 200) throw new Error(`GitHub API error: ${res.statusCode}`);
  const releases = JSON.parse(res.body);
  const mapped = releases.slice(0, 20).map(r => ({
    id: r.id,
    tagName: r.tag_name,
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    body: (r.body || '').slice(0, 500),
    assets: (r.assets || []).map(a => ({
      id: a.id,
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
      contentType: a.content_type,
    }))
  }));
  // Cache releases to store so they persist across restarts
  store.set('cachedKernelReleases', mapped);
  return mapped;
});

// Return cached releases (fast, no network)
ipcMain.handle('kernel:getCachedReleases', () => {
  return store.get('cachedKernelReleases', null);
});

function getKernelsDir() {
  return path.join(app.getPath('userData'), 'kernels');
}

function parseKernelVersion(value) {
  const match = String(value || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:_(\d{8}))?$/);
  return match ? { version: match.slice(1, 5).join('.'), assetDate: match[5] || '', major: Number(match[1]), parts: match.slice(1, 5).map(Number) } : null;
}

function compareKernelVersions(left, right) {
  return left.parts.reduce((result, part, index) => result || part - right.parts[index], 0);
}

function kernelAssetForRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const platform = IS_WIN ? 'win' : IS_MAC ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = assets.filter(asset => {
    if (!asset || typeof asset.name !== 'string' || !asset.browser_download_url) return false;
    const name = asset.name.toLowerCase();
    if (platform === 'win') return name.endsWith(`_win_${arch}.7z`);
    if (platform === 'mac') return name.endsWith(`_mac_${arch}.dmg`);
    return name.endsWith(`_${arch}.deb`);
  });
  return candidates.sort((a, b) => kernelAssetDate(b).localeCompare(kernelAssetDate(a)))[0] || null;
}

function kernelAssetDate(asset) {
  return asset?.name?.match(/^botbrowser_(\d{8})_/i)?.[1] || '';
}

function findInstalledManagedKernel(major) {
  if (!Number.isInteger(major)) return null;
  const dir = getKernelsDir();
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
    if (!entry.isDirectory()) return null;
    const parsed = parseKernelVersion(entry.name);
    if (!parsed || parsed.major !== major) return null;
    const metaPath = path.join(dir, entry.name, '.meta.json');
    let meta = {};
    try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    const execPath = meta.execPath && path.resolve(meta.execPath);
    return execPath && fs.existsSync(execPath) ? { ...parsed, ...meta, execPath } : null;
  }).filter(Boolean);
  return matches.sort((a, b) => compareKernelVersions(b, a) || String(b.assetDate).localeCompare(String(a.assetDate)))[0] || null;
}

async function loadManagedKernel(major) {
  const installed = findInstalledManagedKernel(major);
  if (!Number.isInteger(major)) throw new Error('Unable to derive a BotBrowser kernel major from this profile user agent');
  let response;
  try {
    response = await httpsGet(KERNEL_GITHUB_API);
  } catch (error) {
    if (installed) return installed.execPath;
    throw error;
  }
  if (response.statusCode !== 200) {
    if (installed) return installed.execPath;
    throw new Error(`Kernel release lookup failed: HTTP ${response.statusCode}`);
  }
  let releases;
  try { releases = JSON.parse(response.body); } catch (error) {
    if (installed) return installed.execPath;
    throw new Error(`Kernel release lookup returned invalid JSON: ${error.message}`);
  }
  const candidates = (Array.isArray(releases) ? releases : []).map(release => ({ release, parsed: parseKernelVersion(release.tag_name) }))
    .filter(item => item.parsed && item.parsed.major === major && !item.release.prerelease && kernelAssetForRelease(item.release));
  candidates.sort((a, b) => compareKernelVersions(b.parsed, a.parsed));
  if (!candidates.length) {
    if (installed) return installed.execPath;
    throw new Error(`No public BotBrowser kernel release found for Chrome ${major}`);
  }
  const newest = candidates[0];
  const sameVersion = candidates.filter(item => item.parsed.version === newest.parsed.version);
  sameVersion.sort((a, b) => {
    const left = kernelAssetForRelease(a.release);
    const right = kernelAssetForRelease(b.release);
    return kernelAssetDate(right).localeCompare(kernelAssetDate(left));
  });
  const release = sameVersion[0].release;
  const asset = kernelAssetForRelease(release);
  const assetDate = kernelAssetDate(asset);
  if (installed) {
    const remote = parseKernelVersion(newest.parsed.version);
    const installedDate = installed.assetDate || '';
    if (compareKernelVersions(installed, remote) >= 0 && String(installedDate) >= String(assetDate || '')) return installed.execPath;
  }
  const result = await downloadKernelAsset({
    downloadUrl: asset.browser_download_url,
    fileName: asset.name,
    version: newest.parsed.version,
    assetDate,
  });
  if (!result.execPath || !fs.existsSync(result.execPath)) throw new Error(`Kernel ${newest.parsed.version} was downloaded but no executable was found`);
  return result.execPath;
}

function ensureManagedKernel(major) {
  if (!Number.isInteger(major)) return Promise.reject(new Error('Unable to derive a BotBrowser kernel major from this profile user agent'));
  const existing = managedKernelRequests.get(major);
  if (existing) return existing;
  const request = loadManagedKernel(major);
  managedKernelRequests.set(major, request);
  request.finally(() => managedKernelRequests.delete(major)).catch(() => {});
  return request;
}

async function resolveBrowserExecutable(profile, settings) {
  const mode = settings?.executableMode || (settings?.botBrowserPath ? 'custom' : 'managed');
  if (mode === 'custom') {
    const custom = String(settings?.botBrowserPath || '').trim();
    if (!custom) throw new Error('Custom BotBrowser executable path is empty');
    return custom;
  }
  // Profiles without a detectable Chrome major cannot select a managed kernel;
  // return the legacy sentinel so the caller emits the normal executable error.
  if (!resolveKernel(profile)) return DEFAULT_BOTBROWSER_PATH;
  return ensureManagedKernel(resolveKernel(profile));
}

async function updateManagedKernelsForProfiles() {
  const majors = new Set(store.get('profiles', []).map(resolveKernel).filter(Number.isInteger));
  await Promise.all([...majors].map(major => ensureManagedKernel(major).catch(() => null)));
}

function queueManagedKernelForProfile(profile) {
  const major = resolveKernel(profile || {});
  if (!Number.isInteger(major)) return;
  ensureManagedKernel(major).catch(error => console.warn(`Managed kernel ${major} preparation failed:`, error.message));
}

async function autoUpdateManagedKernels() {
  const dir = getKernelsDir();
  if (!fs.existsSync(dir)) return { checked: 0, updated: 0 };
  const majors = new Set(fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => parseKernelVersion(entry.name)?.major)
    .filter(Number.isInteger));
  let updated = 0;
  for (const major of majors) {
    const previous = findInstalledManagedKernel(major)?.execPath;
    await ensureManagedKernel(major);
    if (findInstalledManagedKernel(major)?.execPath !== previous) updated += 1;
  }
  return { checked: majors.size, updated };
}

ipcMain.handle('kernel:getDir', () => getKernelsDir());

ipcMain.handle('kernel:getCapabilities', async () => {
  const capabilities = { platform: process.platform, arch: process.arch, zipExtractor: true, sevenZipExtractor: false };
  if (process.platform === 'win32') {
    try { await runCmd('where', ['7z']); capabilities.sevenZipExtractor = true; } catch {}
  }
  return capabilities;
});

ipcMain.handle('kernel:listInstalled', () => {
  const dir = getKernelsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const vdir = path.join(dir, e.name);
      const meta = path.join(vdir, '.meta.json');
      let info = { version: e.name, installedAt: null, platform: null, execPath: null };
      if (fs.existsSync(meta)) {
        try { info = { ...info, ...JSON.parse(fs.readFileSync(meta, 'utf8')) }; } catch {}
      }
      return info;
    });
});

function getKernelVersionDir(version) {
  if (typeof version !== 'string' || version.length === 0 || version === '.' || version === '..' || /[\\/]/.test(version)) {
    return null;
  }
  const kernelsDir = path.resolve(getKernelsDir());
  const versionDir = path.resolve(kernelsDir, version);
  const relative = path.relative(kernelsDir, versionDir);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return null;
  }
  return versionDir;
}

ipcMain.handle('kernel:delete', (_, version) => {
  const dir = getKernelVersionDir(version);
  if (!dir) return false;
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
});

ipcMain.handle('kernel:cancelDownload', async (_, version) => {
  const active = kernelDownloads.get(version);
  if (!active) return false;
  active.cancelled = true;
  active.request?.destroy(new Error('Download cancelled'));
  active.response?.destroy();
  active.fileStream?.destroy();
  if (active.fileStream && !active.fileStream.closed) {
    await new Promise(resolve => active.fileStream.once('close', resolve));
  }
  return true;
});

/**
 * Download a kernel asset, then auto-install it.
 * - macOS .dmg: mount with hdiutil and copy .app into the managed kernel directory
 * - Linux .deb: extract into the managed kernel directory without requiring sudo
 * - Linux .AppImage: chmod +x
 * - Windows .7z/.zip: extract with built-in tools
 */
async function downloadKernelAsset({ downloadUrl, fileName, version, assetDate = null }) {
  const kernelsDir = getKernelsDir();
  const installKey = assetDate ? `${version}_${assetDate}` : version;
  const versionDir = getKernelVersionDir(installKey);
  if (!versionDir || (assetDate && !parseKernelVersion(installKey))) throw new Error('Invalid kernel version or asset date');
  fs.mkdirSync(versionDir, { recursive: true });

  const destPath = path.join(versionDir, fileName);

  // Download first
  await new Promise((resolve, reject) => {
    const active = { request: null, response: null, fileStream: null, cancelled: false };
    kernelDownloads.set(version, active);
    const cleanup = () => {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {
        setTimeout(() => { try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {} }, 25);
      }
    };
    const fail = (error) => {
      kernelDownloads.delete(version);
      if (active.fileStream && !active.fileStream.closed) active.fileStream.once('close', cleanup);
      else cleanup();
      reject(error);
    };
    function doDownload(url, redirectCount) {
      if (redirectCount > 5) { fail(new Error('Too many redirects')); return; }
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const req = protocol.get(url, { headers: { 'User-Agent': 'BotBrowserControl/1.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.resume();
          if (!location) { fail(new Error('Redirect without location')); return; }
          doDownload(location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) { fail(new Error(`Download failed: HTTP ${res.statusCode}`)); return; }
        active.response = res;

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const fileStream = fs.createWriteStream(destPath);
        active.fileStream = fileStream;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const progress = Math.round((downloaded / total) * 100);
            mainWindow?.webContents.send('kernel:downloadProgress', { version, progress, downloaded, total });
          }
        });

        res.pipe(fileStream);
        fileStream.on('finish', () => { kernelDownloads.delete(version); fileStream.close(resolve); });
        fileStream.on('error', error => fail(active.cancelled ? new Error('Download cancelled') : error));
      });
      active.request = req;
      req.on('error', error => fail(active.cancelled ? new Error('Download cancelled') : error));
      req.setTimeout(180000, () => { req.destroy(); fail(new Error('Download timeout')); });
    }
    doDownload(downloadUrl, 0);
  });

  // Auto-install
  let execPath = null;
  let installStatus = 'downloaded';
  let installNote = '';

  try {
    if (IS_MAC && fileName.endsWith('.dmg')) {
      // Keep managed installs private to Control so user-installed apps remain untouched.
      const mountResult = await runCmd('hdiutil', ['attach', '-nobrowse', '-noverify', '-noautoopen', destPath]);
      // Find mount point from output (last line with /Volumes/)
      const mountPoint = (mountResult.stdout || '').split('\n')
        .map(l => l.trim())
        .filter(l => l.includes('/Volumes/'))
        .pop()?.split(/\s+/).pop();

      if (mountPoint && fs.existsSync(mountPoint)) {
        // Find .app bundle in mount
        const apps = fs.readdirSync(mountPoint).filter(f => f.endsWith('.app'));
        if (apps.length > 0) {
          const appName = apps[0];
          const srcApp = path.join(mountPoint, appName);
          const dstApp = path.join(versionDir, appName);
          await runCmd('cp', ['-R', srcApp, dstApp]);

          // Remove quarantine flag (xattr) so unsigned app can open
          try { await runCmd('xattr', ['-rd', 'com.apple.quarantine', dstApp]); } catch {}
          // Ad-hoc codesign to allow launch
          try { await runCmd('codesign', ['--force', '--deep', '--sign', '-', dstApp]); } catch {}

          // Find the actual executable inside .app
          const infoPlistPath = path.join(dstApp, 'Contents', 'Info.plist');
          let execName = 'Chromium';
          if (fs.existsSync(infoPlistPath)) {
            const plistContent = fs.readFileSync(infoPlistPath, 'utf8');
            const match = plistContent.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
            if (match) execName = match[1];
          }
          execPath = path.join(dstApp, 'Contents', 'MacOS', execName);
          installStatus = 'installed';
          installNote = 'Installed in managed kernels';
        }
        // Unmount
        try { await runCmd('hdiutil', ['detach', mountPoint, '-quiet']); } catch {}
      }
    } else if (IS_LINUX && fileName.endsWith('.AppImage')) {
      fs.chmodSync(destPath, 0o755);
      execPath = destPath;
      installStatus = 'ready';
      installNote = 'AppImage is ready to use';
    } else if (IS_LINUX && fileName.endsWith('.deb')) {
      await runCmd('dpkg-deb', ['-x', destPath, versionDir]);
      execPath = findFilesRecursive(versionDir, '').find(file =>
        /^(?:chrome|chromium|botbrowser)$/i.test(path.basename(file)) && fs.statSync(file).isFile()) || null;
      installStatus = execPath ? 'extracted' : 'downloaded';
      installNote = execPath ? 'Extracted in managed kernels' : 'Browser executable not found in package';
    } else if (IS_LINUX && fileName.toLowerCase().endsWith('.tar.gz')) {
      await runCmd('tar', ['-xzf', destPath, '-C', versionDir]);
      const files = findFilesRecursive(versionDir, '');
      execPath = files.find(file => {
        try { return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111) && /(?:botbrowser|chrom(?:e|ium))/i.test(path.basename(file)); } catch { return false; }
      }) || null;
      installStatus = execPath ? 'extracted' : 'downloaded';
      installNote = execPath ? 'Extracted successfully' : 'Archive extracted; executable not found';
    } else if (IS_WIN && fileName.endsWith('.7z')) {
      await runCmd('7z', ['x', '-y', `-o${versionDir}`, destPath]);
      const exes = findFilesRecursive(versionDir, '.exe');
      execPath = exes.find(file => /(?:^|[\\/])(?:chrome|chromium|botbrowser)\.exe$/i.test(file)) ||
        exes.find(file => !/uninstall/i.test(path.basename(file))) || null;
      installStatus = 'extracted';
      installNote = 'Extracted successfully';
    } else if (IS_WIN && fileName.endsWith('.zip')) {
      // Extract to versionDir
      if (fileName.endsWith('.zip')) {
        await runCmd('powershell', ['-Command', `Expand-Archive -Force -Path "${destPath}" -DestinationPath "${versionDir}"`]);
      }
      // Find .exe
      const exes = findFilesRecursive(versionDir, '.exe');
      execPath = exes.find(file => /(?:^|[\\/])(?:chrome|chromium|botbrowser)\.exe$/i.test(file)) ||
        exes.find(file => !/uninstall/i.test(path.basename(file))) || null;
      installStatus = 'extracted';
      installNote = 'Extracted successfully';
    } else if (IS_WIN && fileName.endsWith('.exe')) {
      execPath = destPath;
      installStatus = 'ready';
      installNote = 'Installer ready — run to install';
    }
  } catch (installErr) {
    installNote = `Install step failed: ${installErr.message}`;
  }

  const meta = {
    version, installedAt: new Date().toISOString(),
    assetDate,
    platform: process.platform, fileName, execPath, downloadUrl,
    installStatus, installNote,
  };
  fs.writeFileSync(path.join(versionDir, '.meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  if ((installStatus === 'installed' || installStatus === 'extracted') && /\.(?:dmg|deb|7z|zip|tar\.gz)$/i.test(fileName)) {
    try { fs.rmSync(destPath, { force: true }); } catch {}
  }
  const protectedKernels = new Set([installKey, ...kernelDownloads.keys()]);
  for (const instance of runningInstances.values()) {
    const relative = path.relative(kernelsDir, instance.executablePath || '');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      protectedKernels.add(relative.split(path.sep)[0]);
    }
  }
  cleanupOldKernelVersions(kernelsDir, protectedKernels);

  mainWindow?.webContents.send('kernel:downloadComplete', { version, execPath, destPath, installStatus, installNote });
  return { version, execPath, destPath, installStatus, installNote };
}

ipcMain.handle('kernel:download', (_, options) => downloadKernelAsset(options));

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

function findFilesRecursive(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFilesRecursive(full, ext));
    else if (entry.name.toLowerCase().endsWith(ext)) results.push(full);
  }
  return results;
}

// ─── Config File Helpers ──────────────────────────────────────────────────────

function writeStandaloneConfigFile(profile, profileId) {
  const configs = buildConfigsBlock(profile);
  const json = JSON.stringify({ configs }, null, 2);
  const tmpPath = path.join(os.tmpdir(), `botbrowser-config-${profileId}.json`);
  fs.writeFileSync(tmpPath, json, 'utf8');
  tempFiles.set(profileId, tmpPath);
  return tmpPath;
}

function injectConfigsIntoEncFile(encFilePath, profile, profileId) {
  try {
    const raw = fs.readFileSync(encFilePath, 'utf8');
    const enc = JSON.parse(raw);
    enc.configs = buildConfigsBlock(profile);
    const tmpPath = path.join(os.tmpdir(), `botbrowser-enc-${profileId}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(enc, null, 2), 'utf8');
    tempFiles.set(profileId, tmpPath);
    return tmpPath;
  } catch (e) {
    return writeStandaloneConfigFile(profile, profileId);
  }
}

function cleanupTempFile(profileId) {
  const p = tempFiles.get(profileId);
  if (p && fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
  tempFiles.delete(profileId);
}

function buildConfigsBlock(profile) {
  const configs = {};

  if (profile.locale) configs.locale = profile.locale;
  if (profile.languages) configs.languages = profile.languages;
  if (profile.timezone) configs.timezone = profile.timezone;

  if (profile.location) {
    if (typeof profile.location === 'string' && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(profile.location.trim())) {
      const [lat, lon] = profile.location.split(',').map(Number);
      configs.location = { latitude: lat, longitude: lon };
    } else {
      configs.location = profile.location;
    }
  }

  if (profile.colorScheme) configs.colorScheme = profile.colorScheme;
  if (profile.browserBrand) configs.browserBrand = profile.browserBrand;
  if (profile.brandFullVersion) configs.brandFullVersion = profile.brandFullVersion;
  if (profile.uaFullVersion) configs.uaFullVersion = profile.uaFullVersion;

  if (profile.platform) configs.platform = profile.platform;
  if (profile.platformVersion) configs.platformVersion = profile.platformVersion;
  if (profile.model) configs.model = profile.model;
  if (profile.architecture) configs.architecture = profile.architecture;
  if (profile.bitness) configs.bitness = profile.bitness;
  if (profile.mobile !== undefined && profile.mobile !== '') configs.mobile = !!profile.mobile;

  if (profile.proxyServer) {
    configs.proxy = { server: profile.proxyServer };
    if (profile.proxyIp) configs.proxy.ip = profile.proxyIp;
  }

  if (profile.customHeaders && typeof profile.customHeaders === 'object' && Object.keys(profile.customHeaders).length > 0) {
    configs.customHeaders = profile.customHeaders;
  }

  if (profile.windowSize) configs.window = profile.windowSize;
  if (profile.screenSize) configs.screen = profile.screenSize;
  if (profile.orientation) configs.orientation = profile.orientation;
  if (profile.disableDeviceScaleFactorOnGUI) configs.disableDeviceScaleFactorOnGUI = true;

  if (profile.webgl) configs.webgl = profile.webgl;
  if (profile.webgpu) configs.webgpu = profile.webgpu;
  if (profile.webrtc) configs.webrtc = profile.webrtc;
  if (profile.webrtcICE) configs.webrtcICE = profile.webrtcICE;
  if (profile.speechVoices) configs.speechVoices = profile.speechVoices;
  if (profile.mediaDevices) configs.mediaDevices = profile.mediaDevices;
  if (profile.mediaTypes) configs.mediaTypes = profile.mediaTypes;
  if (profile.fonts) configs.fonts = profile.fonts;
  if (profile.keyboard) configs.keyboard = profile.keyboard;

  if (profile.noiseCanvas !== undefined && profile.noiseCanvas !== '') configs.noiseCanvas = !!profile.noiseCanvas;
  if (profile.noiseWebglImage !== undefined && profile.noiseWebglImage !== '') configs.noiseWebglImage = !!profile.noiseWebglImage;
  if (profile.noiseAudioContext !== undefined && profile.noiseAudioContext !== '') configs.noiseAudioContext = !!profile.noiseAudioContext;
  if (profile.noiseClientRects !== undefined && profile.noiseClientRects !== '') configs.noiseClientRects = !!profile.noiseClientRects;
  if (profile.noiseTextRects !== undefined && profile.noiseTextRects !== '') configs.noiseTextRects = !!profile.noiseTextRects;

  if (profile.alwaysActive !== undefined) configs.alwaysActive = !!profile.alwaysActive;
  if (profile.disableDebugger !== undefined) configs.disableDebugger = !!profile.disableDebugger;
  if (profile.disableConsoleMessage !== undefined) configs.disableConsoleMessage = !!profile.disableConsoleMessage;
  if (profile.portProtection !== undefined) configs.portProtection = !!profile.portProtection;
  if (profile.mobileForceTouch !== undefined) configs.mobileForceTouch = !!profile.mobileForceTouch;
  if (profile.networkInfoOverride !== undefined) configs.networkInfoOverride = !!profile.networkInfoOverride;
  if (profile.enableVariationsInContext !== undefined) configs.enableVariationsInContext = !!profile.enableVariationsInContext;

  if (profile.injectRandomHistory !== undefined && profile.injectRandomHistory !== '') {
    const v = profile.injectRandomHistory;
    if (v === true || v === 'true') configs.injectRandomHistory = true;
    else if (v === false || v === 'false') configs.injectRandomHistory = false;
    else if (!isNaN(Number(v))) configs.injectRandomHistory = Number(v);
  }

  if (profile.fps !== undefined && profile.fps !== '' && profile.fps !== 'profile') configs.fps = isNaN(Number(profile.fps)) ? profile.fps : Number(profile.fps);
  if (profile.timeScale !== undefined && profile.timeScale !== '') { const ts = parseFloat(profile.timeScale); if (!isNaN(ts)) configs.timeScale = ts; }
  if (profile.noiseSeed !== undefined && profile.noiseSeed !== '') { const ns = parseInt(profile.noiseSeed); if (!isNaN(ns)) configs.noiseSeed = ns; }
  if (profile.timeSeed !== undefined && profile.timeSeed !== '') { const ts = parseInt(profile.timeSeed); if (!isNaN(ts)) configs.timeSeed = ts; }
  if (profile.stackSeed !== undefined && profile.stackSeed !== '') {
    const ss = profile.stackSeed;
    if (ss === 'profile' || ss === 'real') configs.stackSeed = ss;
    else if (!isNaN(parseInt(ss))) configs.stackSeed = parseInt(ss);
  }

  return configs;
}

function buildLaunchArgs(profile, userDataDir, botProfileArg) {
  const args = [];

  if (botProfileArg) args.push(`--bot-profile=${botProfileArg}`);
  if (profile.profileDirPath && fs.existsSync(profile.profileDirPath)) {
    args.push(`--bot-profile-dir=${profile.profileDirPath}`);
  }

  args.push(`--user-data-dir=${userDataDir}`);
  args.push('--restore-last-session');
  args.push(`--no-first-run`);

  if (profile.name) args.push(`--bot-title=${profile.name}`);

  if (profile.proxyServer && profile.proxyServer.trim()) args.push(`--proxy-server=${profile.proxyServer.trim()}`);
  if (profile.proxyIp && profile.proxyIp.trim()) args.push(`--proxy-ip=${profile.proxyIp.trim()}`);
  if (profile.proxyBypassRgx && profile.proxyBypassRgx.trim()) args.push(`--proxy-bypass-rgx=${profile.proxyBypassRgx.trim()}`);
  if (profile.proxyPacUrl && profile.proxyPacUrl.trim()) args.push(`--proxy-pac-url=${profile.proxyPacUrl.trim()}`);
  if (profile.disableQuic === true || profile.disableQuic === 'true') args.push('--disable-quic');

  if (profile.browserBrand && profile.browserBrand !== '') args.push(`--bot-browser-brand=${profile.browserBrand}`);
  if (profile.brandFullVersion && profile.brandFullVersion !== '') args.push(`--bot-brand-full-version=${profile.brandFullVersion}`);
  if (profile.uaFullVersion && profile.uaFullVersion !== '') args.push(`--bot-ua-full-version=${profile.uaFullVersion}`);
  if (profile.userAgent && profile.userAgent.trim()) args.push(`--user-agent=${profile.userAgent.trim()}`);
  const kernel = resolveKernel(profile);
  if (kernel) args.push(`--bot-kernel=${kernel}`);

  if (profile.locale && profile.locale !== '') args.push(`--bot-locale=${profile.locale}`);
  if (profile.timezone && profile.timezone !== '') args.push(`--bot-timezone=${profile.timezone}`);
  if (profile.languages && profile.languages !== '') args.push(`--bot-languages=${profile.languages}`);
  if (profile.location && profile.location !== '') args.push(`--bot-location=${profile.location}`);
  if (profile.colorScheme) args.push(`--bot-color-scheme=${profile.colorScheme}`);

  if (profile.platform && profile.platform !== '') args.push(`--bot-platform=${profile.platform}`);
  if (profile.platformVersion) args.push(`--bot-platform-version=${profile.platformVersion}`);
  if (profile.model) args.push(`--bot-model=${profile.model}`);
  if (profile.architecture) args.push(`--bot-architecture=${profile.architecture}`);
  if (profile.bitness) args.push(`--bot-bitness=${profile.bitness}`);
  if (profile.mobile !== undefined && profile.mobile !== '') args.push(`--bot-mobile=${!!profile.mobile}`);

  if (profile.windowSize) args.push(`--bot-window=${profile.windowSize}`);
  if (profile.screenSize) args.push(`--bot-screen=${profile.screenSize}`);
  if (profile.dprMode) args.push(`--bot-dpr=${profile.dprMode}`);
  if (profile.orientation) args.push(`--bot-orientation=${profile.orientation}`);
  if (profile.keyboard) args.push(`--bot-keyboard=${profile.keyboard}`);
  if (profile.fonts) args.push(`--bot-fonts=${profile.fonts}`);
  if (profile.disableDeviceScaleFactorOnGUI) args.push('--bot-disable-device-scale-factor');

  if (profile.webgl) args.push(`--bot-webgl=${profile.webgl}`);
  if (profile.webgpu) args.push(`--bot-webgpu=${profile.webgpu}`);
  if (profile.webrtc) args.push(`--bot-webrtc=${profile.webrtc}`);
  if (profile.speechVoices) args.push(`--bot-speech-voices=${profile.speechVoices}`);
  if (profile.mediaDevices) args.push(`--bot-media-devices=${profile.mediaDevices}`);
  if (profile.mediaTypes) args.push(`--bot-media-types=${profile.mediaTypes}`);

  if (profile.noiseCanvas !== undefined && profile.noiseCanvas !== '') args.push(`--bot-noise-canvas=${!!profile.noiseCanvas}`);
  if (profile.noiseWebglImage !== undefined && profile.noiseWebglImage !== '') args.push(`--bot-noise-webgl-image=${!!profile.noiseWebglImage}`);
  if (profile.noiseAudioContext !== undefined && profile.noiseAudioContext !== '') args.push(`--bot-noise-audio-context=${!!profile.noiseAudioContext}`);
  if (profile.noiseClientRects !== undefined && profile.noiseClientRects !== '') args.push(`--bot-noise-client-rects=${!!profile.noiseClientRects}`);
  if (profile.noiseTextRects !== undefined && profile.noiseTextRects !== '') args.push(`--bot-noise-text-rects=${!!profile.noiseTextRects}`);

  if (profile.disableDebugger === true || profile.disableDebugger === 'true') args.push('--bot-disable-debugger');
  if (!(profile.disableConsoleMessage === false || profile.disableConsoleMessage === 'false')) args.push('--bot-disable-console-message');
  args.push('--bot-always-active');
  if (profile.portProtection === true || profile.portProtection === 'true') args.push('--bot-port-protection');
  if (profile.localDnsMode === 'local') args.push('--bot-local-dns=local');
  else if (profile.localDnsMode === 'custom') { args.push('--bot-local-dns=custom'); if (profile.localDnsServers) args.push('--bot-local-dns-servers=' + profile.localDnsServers); }
  else if (profile.localDns === true || profile.localDns === 'true') args.push('--bot-local-dns');
  if (profile.mobileForceTouch === true || profile.mobileForceTouch === 'true') args.push('--bot-mobile-force-touch');
  if (profile.enableVariationsInContext === true || profile.enableVariationsInContext === 'true') args.push('--bot-enable-variations-in-context');
  if (profile.networkInfoOverride === true || profile.networkInfoOverride === 'true') args.push('--bot-network-info-override');

  if (profile.injectRandomHistory !== undefined && profile.injectRandomHistory !== '') {
    const v = profile.injectRandomHistory;
    if (v === true || v === 'true') args.push('--bot-inject-random-history=true');
    else if (v !== false && v !== 'false' && !isNaN(Number(v))) args.push(`--bot-inject-random-history=${Number(v)}`);
  }

  if (profile.webrtcICE && profile.webrtcICE !== 'profile' && profile.webrtcICE !== '') {
    args.push(`--bot-webrtc-ice=${profile.webrtcICE}`);
  }

  if (profile.noiseSeed !== undefined && profile.noiseSeed !== '') { const ns = parseInt(profile.noiseSeed); if (!isNaN(ns) && ns >= 0) args.push(`--bot-noise-seed=${ns}`); }
  if (profile.timeSeed !== undefined && profile.timeSeed !== '') { const ts = parseInt(profile.timeSeed); if (!isNaN(ts) && ts >= 0) args.push(`--bot-time-seed=${ts}`); }
  if (profile.stackSeed !== undefined && profile.stackSeed !== '') {
    const ss = profile.stackSeed;
    if (ss === 'profile' || ss === 'real') args.push(`--bot-stack-seed=${ss}`);
    else if (!isNaN(parseInt(ss))) args.push(`--bot-stack-seed=${parseInt(ss)}`);
  }
  if (profile.timeScale !== undefined && profile.timeScale !== '') { const ts = parseFloat(profile.timeScale); if (!isNaN(ts) && ts > 0 && ts < 1) args.push(`--bot-time-scale=${ts}`); }
  if (profile.fps !== undefined && profile.fps !== '' && profile.fps !== 'profile') args.push(`--bot-fps=${profile.fps}`);
  if (profile.videoFps !== undefined && profile.videoFps !== '' && profile.videoFps !== 'profile') args.push(`--bot-video-fps=${profile.videoFps}`);

  if (profile.gpuEmulation === false || profile.gpuEmulation === 'false') args.push('--bot-gpu-emulation=false');

  const emitBytePolicy = (flag, value) => {
    if (value === 'profile' || value === 'real') { args.push(`${flag}=${value}`); return; }
    const number = Number(value);
    if (value !== undefined && value !== null && value !== '' && Number.isInteger(number) && number > 0) args.push(`${flag}=${number}`);
  };
  emitBytePolicy('--bot-js-heap-size-limit', profile.jsHeapSizeLimit);
  emitBytePolicy('--bot-storage-quota', profile.storageQuota);

  if (profile.customHeaders && typeof profile.customHeaders === 'object' && Object.keys(profile.customHeaders).length > 0) {
    args.push('--bot-custom-headers=' + JSON.stringify(profile.customHeaders));
  }

  if (profile.ipService) args.push(`--bot-ip-service=${profile.ipService}`);

  if (profile.mirrorController) args.push(`--bot-mirror-controller-endpoint=${profile.mirrorController}`);
  if (profile.mirrorClient) args.push(`--bot-mirror-client-endpoint=${profile.mirrorClient}`);

  if (profile.canvasRecordFile) args.push(`--bot-canvas-record-file=${profile.canvasRecordFile}`);
  if (profile.audioRecordFile) args.push(`--bot-audio-record-file=${profile.audioRecordFile}`);

  if (profile.v8Log) {
    args.push(`--bot-v8-log=${profile.v8Log}`);
    if (profile.v8Log !== 'none' && profile.v8LogDir) args.push(`--bot-v8-log-dir=${profile.v8LogDir}`);
  }

  if (profile.botScript) args.push(`--bot-script=${profile.botScript}`);

  if (profile.remoteDebuggingPort) args.push(`--remote-debugging-port=${profile.remoteDebuggingPort}`);

  if (profile.cookies && profile.cookies.trim()) {
    const cookieVal = profile.cookies.trim();
    if (cookieVal.startsWith('@')) {
      args.push(`--bot-cookies=${cookieVal}`);
    } else {
      try { JSON.parse(cookieVal); args.push('--bot-cookies=' + cookieVal); } catch {; }
    }
  }

  if (profile.bookmarks && profile.bookmarks.trim()) {
    try { JSON.parse(profile.bookmarks.trim()); args.push('--bot-bookmarks=' + profile.bookmarks.trim()); } catch {; }
  }

  if (profile.startUrl && profile.startUrl.trim()) args.push(profile.startUrl.trim());

  return args;
}

function tryParseBotProfile(value) {
  const match = String(value || '').match(/\d+/);
  const kernel = match ? Number(match[0]) : null;
  return kernel >= 1 && kernel <= 999 ? kernel : null;
}

function resolveKernel(profile) {
  const override = tryParseBotProfile(profile.kernelOverride || profile.kernelVersion || profile.kernel);
  if (override) return override;
  const ua = String(profile.userAgent || '');
  const chrome = ua.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/i);
  if (chrome) return Number(chrome[1]);
  if (/AppleWebKit\//i.test(ua) && /Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    const version = ua.match(/Version\/(\d+)/i);
    if (version && Number(version[1]) >= 26) return 149;
  }
  return null;
}

// ─── CDP Cookie Save ──────────────────────────────────────────────────────────

async function saveCookiesViaCDP(profileId, port, userDataDir) {
  return saveCookieData(profileId, port, userDataDir, {
    store,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload)
  });
}

// ─── Profile Status ───────────────────────────────────────────────────────────

function updateProfileStatus(profileId, status) {
  const profiles = store.get('profiles', []);
  const idx = profiles.findIndex(p => p.id === profileId);
  if (idx !== -1) {
    profiles[idx].status = status;
    store.set('profiles', profiles);
    mainWindow?.webContents.send('profile:statusChanged', { profileId, status });
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  ({ default: Store } = await import('electron-store'));
  store = new Store(STORE_OPTIONS);
  nativeTheme.themeSource = 'dark';

  const profiles = store.get('profiles', []);
  const hadStale = profiles.some(p => p.status === 'running');
  if (hadStale) {
    store.set('profiles', profiles.map(p =>
      p.status === 'running' ? { ...p, status: 'stopped' } : p
    ));
  }

  createWindow();
  // Refresh managed kernels for profiles already configured, then re-check periodically.
  setTimeout(() => updateManagedKernelsForProfiles().catch(error => console.warn('Managed kernel preparation failed:', error.message)), 1000);
  // Keep managed kernels current without blocking app startup or requiring a token.
  autoUpdateManagedKernels().catch(error => console.warn('Managed kernel update check failed:', error.message));
  const testKernelInterval = Number(process.env.BOTBROWSER_TEST_KERNEL_INTERVAL_MS);
  const kernelUpdateInterval = process.env.BOTBROWSER_TEST_USER_DATA_DIR &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.BOTBROWSER_TEST_RELEASES_API_BASE || '') &&
    Number.isSafeInteger(testKernelInterval) && testKernelInterval >= 100
      ? testKernelInterval : 6 * 60 * 60 * 1000;
  managedKernelUpdateTimer = setInterval(() => {
    if (kernelDownloads.size !== 0) return;
    updateManagedKernelsForProfiles().catch(error => console.warn('Managed kernel preparation failed:', error.message));
    autoUpdateManagedKernels().catch(error => console.warn('Managed kernel update check failed:', error.message));
  }, kernelUpdateInterval);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const [, inst] of runningInstances) { try { inst.process.kill(); } catch {} }
  for (const [profileId] of tempFiles) { cleanupTempFile(profileId); }
  if (!IS_MAC) app.quit();
});

app.on('before-quit', () => {
  if (managedKernelUpdateTimer) clearInterval(managedKernelUpdateTimer);
  for (const [, inst] of runningInstances) { try { inst.process.kill(); } catch {} }
  for (const [profileId] of tempFiles) { cleanupTempFile(profileId); }
});
