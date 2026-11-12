const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');

test('Windows source bootstrap only reuses a healthy matching Node runtime', () => {
  test.skip(process.platform !== 'win32', 'Requires Windows PowerShell and native executable fixtures');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'windows-node-probe.ps1'),
  ], { encoding: 'utf8', timeout: 60000 });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('NODE_PROBE_RESULTS=11/11');
});
