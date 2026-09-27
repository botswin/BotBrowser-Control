const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..');
const docs = ['README.md', 'INSTALL.md', 'BUILD.md'];
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const section = (text, heading) => text.split(heading)[1].split('\n## ')[0];

test('public docs keep Control links separate from Kernel links', () => {
  const text = docs.map(read).join('\n');
  expect(text).toContain('https://github.com/botswin/BotBrowser-Control/releases');
  expect(text).toContain('https://github.com/botswin/BotBrowser-Control/issues');
  expect(text).not.toMatch(/https:\/\/github\.com\/botswin\/BotBrowser\/issues/);
  expect(JSON.parse(read('package.json')).homepage).toBe('https://github.com/botswin/BotBrowser-Control');
});

test('INSTALL keeps Control assets separate from Kernel downloads', () => {
  const install = read('INSTALL.md');
  const assets = section(install, '## Future tagged release assets');
  const kernel = section(install, '## Configure the Kernel');
  expect(assets).toContain('https://github.com/botswin/BotBrowser-Control/releases');
  expect(assets).not.toContain('https://github.com/botswin/BotBrowser/releases');
  expect(kernel).toContain('https://github.com/botswin/BotBrowser/releases');
  expect(kernel).toMatch(/Kernel downloads, not Control application installers/);
});

test('public docs avoid unsupported release and update claims', () => {
  const text = docs.map(read).join('\n');
  expect(text).toMatch(/does not currently publish Release assets/i);
  expect(text).toMatch(/reinstalls current `main`; it is not an automatic update service/i);
  expect(text).toContain('Windows x64 and arm64');
  expect(text).not.toMatch(/[\u2013\u2014]/);
});

test('README separates source bootstrap commands and manual builds require Node 24', () => {
  const readme = read('README.md');
  expect(readme).toMatch(/macOS:\n\n```bash\ncurl -fsSL .*setup-macos\.sh \| bash\n```/);
  expect(readme).toMatch(/Linux:\n\n```bash\ncurl -fsSL .*setup-linux\.sh \| bash\n```/);
  expect(readme).toMatch(/Windows PowerShell:\n\n```powershell\nirm .*setup-windows-source\.ps1 \| iex\n```/);
  for (const doc of docs) expect(read(doc)).toContain('Node.js 24.15.0 and npm');
});