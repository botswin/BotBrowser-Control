const fs = (() => {
  try { return require('original-fs'); } catch { return require('fs'); }
})();
const path = require('path');
const { execFile } = require('child_process');
const JSZip = require('jszip');

function assertSafeVersion(version) {
  if (!version || !/^[^/\\]+$/.test(version)) throw new Error('Invalid update version');
}

function assertAbsolute(name, value) {
  if (!value || !path.isAbsolute(value)) throw new Error(`Invalid ${name}`);
}

function ensureExecutable(filePath) {
  try { fs.chmodSync(filePath, 0o755); } catch (error) {
    throw new Error(`Unable to mark the updated executable: ${error.message}`);
  }
}

function getMacAppBundlePath(executablePath) {
  assertAbsolute('application executable', executablePath);
  const markerMatch = executablePath.match(/[\\/]Contents[\\/]MacOS[\\/]/i);
  const markerIndex = markerMatch?.index ?? -1;
  if (markerIndex < 0) throw new Error('Application executable is not inside a macOS app bundle');
  const bundlePath = executablePath.slice(0, markerIndex);
  if (!bundlePath.toLowerCase().endsWith('.app')) throw new Error('Application bundle has an invalid path');
  return bundlePath;
}

function getPosixInstallUnit({ platform, executablePath, appImagePath }) {
  assertAbsolute('application executable', executablePath);
  if (platform === 'darwin') {
    const livePath = getMacAppBundlePath(executablePath);
    return { kind: 'directory', livePath, executableRelative: path.relative(livePath, executablePath) };
  }
  if (platform === 'linux') {
    if (appImagePath) {
      assertAbsolute('AppImage installation', appImagePath);
      const originalPath = fs.realpathSync(appImagePath);
      if (!/\.appimage$/i.test(originalPath) || !fs.statSync(originalPath).isFile()) {
        throw new Error('Invalid AppImage installation');
      }
      return { kind: 'file', livePath: originalPath };
    }
    if (/[\\/](?:\.mount_[^\\/]*|appimage_extracted_[^\\/]*|squashfs-root)[\\/]/i.test(executablePath)) {
      throw new Error('AppImage updates require the original installation path');
    }
    if (/\.appimage$/i.test(executablePath)) return { kind: 'file', livePath: executablePath };
    return { kind: 'directory', livePath: path.dirname(executablePath), executableRelative: path.basename(executablePath) };
  }
  throw new Error('POSIX updates require macOS or Linux');
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

async function extractTarGzUpdatePackage(packagePath, stagingRoot, version, executableName) {
  const partial = path.join(stagingRoot, `.${version}.dist.part`);
  const target = path.join(stagingRoot, `${version}.dist`);
  if (fs.existsSync(target)) return { stagedDir: target, executablePath: findExecutable(target, executableName) };
  const verboseListing = await execFileAsync('tar', ['-tvzf', packagePath]);
  for (const line of verboseListing.stdout.split(/\r?\n/).filter(Boolean)) {
    if (/^[lh]/i.test(line)) throw new Error('Invalid update archive: links are not allowed');
  }
  const listing = await execFileAsync('tar', ['-tzf', packagePath]);
  for (const entryName of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entryName.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error('Invalid update archive');
  }
  fs.mkdirSync(partial, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', packagePath, '-C', partial]);
    const executablePath = findExecutable(partial, executableName);
    if (!executablePath) throw new Error('Update archive is missing the application executable');
    fs.renameSync(partial, target);
    return { stagedDir: target, executablePath: path.join(target, path.relative(partial, executablePath)) };
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

async function extractUpdatePackage(packagePath, stagingRoot, version, executableName = 'BotBrowser Control.exe') {
  assertAbsolute('package path', packagePath);
  assertAbsolute('staging directory', stagingRoot);
  assertSafeVersion(version);
  if (/\.(?:tar\.gz|tgz)$/i.test(packagePath)) return extractTarGzUpdatePackage(packagePath, stagingRoot, version, executableName);
  if (/\.appimage$/i.test(packagePath)) throw new Error('AppImage packages are applied as files, not extracted');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const partial = path.join(stagingRoot, `.${version}.dist.part`);
  const target = path.join(stagingRoot, `${version}.dist`);
  if (fs.existsSync(target)) return { stagedDir: target, executablePath: findExecutable(target, executableName) };
  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  fs.mkdirSync(partial, { recursive: true });
  try {
    for (const [entryName, entry] of Object.entries(zip.files)) {
      const normalized = entryName.replace(/\\/g, '/');
      if (!normalized || normalized.includes('..') || normalized.startsWith('/')) throw new Error('Invalid update archive');
      const destination = path.resolve(partial, normalized);
      if (destination !== partial && !destination.startsWith(`${partial}${path.sep}`)) throw new Error('Invalid update archive');
      if (entry.dir) fs.mkdirSync(destination, { recursive: true });
      else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, await entry.async('nodebuffer')); }
    }
    const executablePath = findExecutable(partial, executableName);
    if (!executablePath) throw new Error('Update archive is missing the application executable');
    fs.renameSync(partial, target);
    return { stagedDir: target, executablePath: path.join(target, path.relative(partial, executablePath)) };
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

function findExecutable(root, executableName) {
  if (!fs.existsSync(root)) return null;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.name.toLowerCase() === executableName.toLowerCase()) return candidate;
    }
  }
  return null;
}

function writeAtomic(filePath, value) {
  const tempPath = `${filePath}.part`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, value, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function recoverDirectorySwap({ liveDir, oldDir, markerPath }) {
  if (!fs.existsSync(markerPath)) return;
  if (!fs.existsSync(liveDir) && fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, liveDir);
  } else if (fs.existsSync(liveDir) && fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
  fs.rmSync(markerPath, { force: true });
}

function applyDirectorySwap({ liveDir, stagedDir, oldDir = `${liveDir}.old`, executableRelative = 'BotBrowser Control.exe', commitPath, markerPath, version }) {
  assertAbsolute('live directory', liveDir);
  assertAbsolute('staged directory', stagedDir);
  assertAbsolute('old directory', oldDir);
  assertSafeVersion(version);
  if (commitPath) assertAbsolute('commit path', commitPath);
  if (markerPath) assertAbsolute('marker path', markerPath);
  const stagedExecutable = path.join(stagedDir, executableRelative);
  if (!fs.existsSync(stagedExecutable)) throw new Error('Staged update is missing the application executable');
  const transactionMarker = markerPath || `${oldDir}.marker`;
  recoverDirectorySwap({ liveDir, oldDir, markerPath: transactionMarker });
  fs.rmSync(oldDir, { recursive: true, force: true });
  let movedLive = false;
  let transactionStarted = false;
  try {
    writeAtomic(transactionMarker, JSON.stringify({ status: 'applying', liveDir, stagedDir, oldDir, version }));
    transactionStarted = true;
    if (fs.existsSync(liveDir)) { fs.renameSync(liveDir, oldDir); movedLive = true; }
    fs.renameSync(stagedDir, liveDir);
    if (!fs.existsSync(path.join(liveDir, executableRelative))) throw new Error('Updated application executable is missing');
    if (commitPath) {
      writeAtomic(commitPath, version);
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.rmSync(transactionMarker, { force: true });
    return { status: 'applied', version, liveDir };
  } catch (error) {
    try {
      fs.rmSync(liveDir, { recursive: true, force: true });
      if (movedLive && fs.existsSync(oldDir)) fs.renameSync(oldDir, liveDir);
      if (transactionStarted) fs.rmSync(transactionMarker, { force: true });
    } catch {
      // Keep the marker when rollback itself fails so the next launch can recover.
    }
    throw error;
  }
}

function applyFileSwap({ livePath, stagedPath, oldPath = `${livePath}.old`, commitPath, markerPath, version }) {
  assertAbsolute('live file', livePath);
  assertAbsolute('staged file', stagedPath);
  assertAbsolute('old file', oldPath);
  assertSafeVersion(version);
  if (commitPath) assertAbsolute('commit path', commitPath);
  if (markerPath) assertAbsolute('marker path', markerPath);
  if (!fs.existsSync(stagedPath)) throw new Error('Staged update is missing the application file');
  const transactionMarker = markerPath || `${oldPath}.marker`;
  if (fs.existsSync(transactionMarker)) {
    if (!fs.existsSync(livePath) && fs.existsSync(oldPath)) fs.renameSync(oldPath, livePath);
    else if (fs.existsSync(livePath) && fs.existsSync(oldPath)) fs.rmSync(oldPath, { force: true });
    fs.rmSync(transactionMarker, { force: true });
  }
  fs.rmSync(oldPath, { force: true });
  let movedLive = false;
  let transactionStarted = false;
  try {
    writeAtomic(transactionMarker, JSON.stringify({ status: 'applying', livePath, stagedPath, oldPath, version }));
    transactionStarted = true;
    if (fs.existsSync(livePath)) { fs.renameSync(livePath, oldPath); movedLive = true; }
    fs.renameSync(stagedPath, livePath);
    ensureExecutable(livePath);
    if (!fs.existsSync(livePath)) throw new Error('Updated application file is missing');
    if (commitPath) writeAtomic(commitPath, version);
    fs.rmSync(oldPath, { force: true });
    fs.rmSync(transactionMarker, { force: true });
    return { status: 'applied', version, livePath };
  } catch (error) {
    try {
      fs.rmSync(livePath, { force: true });
      if (movedLive && fs.existsSync(oldPath)) fs.renameSync(oldPath, livePath);
      if (transactionStarted) fs.rmSync(transactionMarker, { force: true });
    } catch {
      // Keep the marker when rollback itself fails so the next launch can recover.
    }
    throw error;
  }
}

function createWindowsSwapScript({ liveDir, stagedDir, oldDir = `${liveDir}.old`, executableRelative = 'BotBrowser Control.exe', commitPath, version, pid, relaunchExe }) {
  assertAbsolute('live directory', liveDir);
  assertAbsolute('staged directory', stagedDir);
  assertAbsolute('old directory', oldDir);
  if (commitPath) assertAbsolute('commit path', commitPath);
  assertSafeVersion(version);
  const liveExe = path.join(liveDir, executableRelative);
  const stagedExe = path.join(stagedDir, executableRelative);
  const wait = pid ? `set /a n=0\r\n:wait\r\ntasklist /fi "PID eq ${Number(pid)}" 2>nul | find "${Number(pid)}" >nul\r\nif not errorlevel 1 (\r\n  set /a n+=1\r\n  if %n% lss 120 ( ping -n 2 127.0.0.1 >nul & goto wait )\r\n)\r\n` : '';
  const relaunch = relaunchExe || liveExe;
  const commitTemp = commitPath ? `${commitPath}.part` : '';
  const commit = commitPath ? `> "${commitTemp}" echo ${version}\r\nif errorlevel 1 goto rollback\r\nmove /y "${commitTemp}" "${commitPath}" >nul 2>&1\r\nif errorlevel 1 goto rollback\r\nif exist "${commitTemp}" goto rollback\r\n` : '';
  return `@echo off\r\nsetlocal\r\nset "movedLive=0"\r\n${wait}if exist "${oldDir}" (\r\n  if exist "${liveDir}" (\r\n    rmdir /s /q "${oldDir}" >nul 2>&1\r\n    if errorlevel 1 goto failed\r\n    if exist "${oldDir}" goto failed\r\n  ) else (\r\n    move "${oldDir}" "${liveDir}" >nul 2>&1\r\n    if errorlevel 1 goto failed\r\n    if not exist "${liveExe}" goto failed\r\n  )\r\n)\r\nif not exist "${stagedExe}" goto failed\r\nif exist "${liveDir}" (\r\n  move "${liveDir}" "${oldDir}" >nul 2>&1\r\n  if errorlevel 1 goto failed\r\n  if exist "${liveDir}" goto failed\r\n  set "movedLive=1"\r\n)\r\nmove "${stagedDir}" "${liveDir}" >nul 2>&1\r\nif errorlevel 1 goto rollback\r\nif exist "${stagedDir}" goto rollback\r\nif not exist "${liveExe}" goto rollback\r\n${commit}set "swapSucceeded=1"\r\nif exist "${oldDir}" if exist "${liveDir}" rmdir /s /q "${oldDir}" >nul 2>&1\r\nif "%swapSucceeded%"=="1" start "" "${relaunch}"\r\nset "exitCode=0"\r\ngoto done\r\n:rollback\r\nif exist "${liveDir}" (\r\n  rmdir /s /q "${liveDir}" >nul 2>&1\r\n  if exist "${liveDir}" goto failed\r\n)\r\nif "%movedLive%"=="1" (\r\n  move "${oldDir}" "${liveDir}" >nul 2>&1\r\n  if errorlevel 1 goto failed\r\n  if not exist "${liveExe}" goto failed\r\n)\r\n:failed\r\nif exist "${commitTemp}" del /f /q "${commitTemp}" >nul 2>&1\r\nset "exitCode=1"\r\n:done\r\nexit /b %exitCode%\r\n`;
}

module.exports = { extractUpdatePackage, applyDirectorySwap, applyFileSwap, createWindowsSwapScript, findExecutable, recoverDirectorySwap, getMacAppBundlePath, getPosixInstallUnit, ensureExecutable };
