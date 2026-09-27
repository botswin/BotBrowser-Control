const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function assertSafeVersion(version) {
  if (!version || !/^[^/\\]+$/.test(version)) throw new Error('Invalid update version');
}

function assertAbsolute(name, value) {
  if (!value || !path.isAbsolute(value)) throw new Error(`Invalid ${name}`);
}

async function extractUpdatePackage(packagePath, stagingRoot, version, executableName = 'BotBrowser Control.exe') {
  assertAbsolute('package path', packagePath);
  assertAbsolute('staging directory', stagingRoot);
  assertSafeVersion(version);
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

function applyDirectorySwap({ liveDir, stagedDir, oldDir = `${liveDir}.old`, executableRelative = 'BotBrowser Control.exe', commitPath, version }) {
  assertAbsolute('live directory', liveDir);
  assertAbsolute('staged directory', stagedDir);
  assertAbsolute('old directory', oldDir);
  assertSafeVersion(version);
  if (commitPath) assertAbsolute('commit path', commitPath);
  const stagedExecutable = path.join(stagedDir, executableRelative);
  if (!fs.existsSync(stagedExecutable)) throw new Error('Staged update is missing the application executable');
  fs.rmSync(oldDir, { recursive: true, force: true });
  let movedLive = false;
  try {
    if (fs.existsSync(liveDir)) { fs.renameSync(liveDir, oldDir); movedLive = true; }
    fs.renameSync(stagedDir, liveDir);
    if (!fs.existsSync(path.join(liveDir, executableRelative))) throw new Error('Updated application executable is missing');
    if (commitPath) {
      const temp = `${commitPath}.part`;
      fs.mkdirSync(path.dirname(commitPath), { recursive: true });
      fs.writeFileSync(temp, version, 'utf8');
      fs.renameSync(temp, commitPath);
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
    return { status: 'applied', version, liveDir };
  } catch (error) {
    fs.rmSync(liveDir, { recursive: true, force: true });
    if (movedLive && fs.existsSync(oldDir)) fs.renameSync(oldDir, liveDir);
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

module.exports = { extractUpdatePackage, applyDirectorySwap, createWindowsSwapScript, findExecutable };
