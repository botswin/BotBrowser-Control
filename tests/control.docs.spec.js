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
  expect(text).toMatch(/tagged Control releases publish the application assets/i);
  expect(text).toMatch(/reinstalls current `main`; it is not an automatic update service/i);
  expect(text).toContain('Windows x64 and arm64');
  expect(text).toContain('manifest.json');
  expect(text).not.toMatch(/[\u2013\u2014]/);
});

test('release workflow publishes the cross-platform manifest asset contract', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
  expect(workflow).toContain('name: Generate cross-platform release manifest');
  expect(workflow).toContain("BotBrowser Control-{version}-win.zip");
  expect(workflow).toContain("BotBrowser Control-{version}-arm64-win.zip");
  expect(workflow).toContain('hashlib.sha256');
  expect(workflow).toContain("('win32', 'x64', 'zip'");
  expect(workflow).toContain("('win32', 'arm64', 'zip'");
  expect(workflow).toContain("'platform': platform");
  expect(workflow).toContain("'format': format");
  expect(workflow).toContain("('darwin', 'x64', 'zip'");
  expect(workflow).toContain("('linux', 'arm64', 'appimage'");
  expect(workflow).toContain("f'botbrowser-control-{version}.tar.gz'");
  expect(workflow).toContain("f'botbrowser-control-{version}-arm64.tar.gz'");

  expect(workflow).toContain("'arch': arch");
  expect(workflow).toContain("'version': version");
  expect(workflow).toContain("'sha256': digest");
  expect(workflow).toContain('releases/download/{quote(tag, safe="")}');
  expect(workflow).toContain('gh release upload \"${{ github.ref_name }}\" manifest.json --clobber');
  expect(workflow).not.toMatch(/continue-on-error/);
});

test('README separates source bootstrap commands and manual builds require Node 24', () => {
  const readme = read('README.md');
  expect(readme).toMatch(/macOS:\n\n```bash\ncurl -fsSL .*setup-macos\.sh \| bash\n```/);
  expect(readme).toMatch(/Linux:\n\n```bash\ncurl -fsSL .*setup-linux\.sh \| bash\n```/);
  expect(readme).toMatch(/Windows PowerShell:\n\n```powershell\nirm .*setup-windows-source\.ps1 \| iex\n```/);
  for (const doc of docs) expect(read(doc)).toContain('Node.js 24.15.0 and npm');
});

test('renderer has no third-party runtime scripts that could access profile data', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=[\"']https?:\/\//i);
  expect(html).not.toMatch(/<link[^>]+href=[\"']https?:\/\//i);
  expect(html).not.toMatch(/myninja|daytona|fonts\.(googleapis|gstatic)\.com/i);
});

test('README states the local-only profile privacy boundary', () => {
  const readme = read('README.md');
  expect(readme).toMatch(/profile configuration, cookies, and browser data on the local machine/i);
  expect(readme).toMatch(/no profile upload or cloud sync endpoint/i);
});
