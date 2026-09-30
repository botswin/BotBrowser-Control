const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const asar = require('@electron/asar');
const JSZip = require('jszip');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUpdatePackage: extractInNode } = require('../src/main/update-apply');

test('extracts a real app.asar payload through Electron file operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-update-asar-'));
  const userDataDir = path.join(root, 'user-data');
  const sourceDir = path.join(root, 'asar-source');
  const asarPath = path.join(root, 'app.asar');
  const packagePath = path.join(root, 'update.zip');
  const stagingRoot = path.join(root, 'staging');
  let app;
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'main.js'), 'module.exports = "fixture";\n');
    await asar.createPackage(sourceDir, asarPath);
    const asarBytes = fs.readFileSync(asarPath);
    const zip = new JSZip();
    zip.file('resources/app.asar', asarBytes);
    zip.file('BotBrowser Control.exe', 'fixture executable');
    fs.writeFileSync(packagePath, await zip.generateAsync({ type: 'nodebuffer' }));

    const nodeExtracted = await extractInNode(
      packagePath, path.join(root, 'node-staging'), 'node-asar-regression', 'BotBrowser Control.exe'
    );
    expect(fs.readFileSync(path.join(nodeExtracted.stagedDir, 'resources', 'app.asar'))).toEqual(asarBytes);

    app = await _electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOTBROWSER_TEST_USER_DATA_DIR: userDataDir,
        BOTBROWSER_TEST_UPDATE_ZIP: packagePath,
        BOTBROWSER_TEST_UPDATE_STAGE: stagingRoot
      }
    });
    const result = await app.evaluate(async () => {
      const requireFromMain = process.mainModule.require.bind(process.mainModule);
      const path = requireFromMain('node:path');
      const fs = requireFromMain('original-fs');
      const crypto = requireFromMain('node:crypto');
      const { extractUpdatePackage } = requireFromMain(
        path.resolve('src/main/update-apply')
      );
      const packagePath = process.env.BOTBROWSER_TEST_UPDATE_ZIP;
      const stagingRoot = process.env.BOTBROWSER_TEST_UPDATE_STAGE;
      const extracted = await extractUpdatePackage(
        packagePath, stagingRoot, 'asar-regression', 'BotBrowser Control.exe'
      );
      const extractedAsar = fs.readFileSync(path.join(extracted.stagedDir, 'resources', 'app.asar'));
      return {
        executableExists: fs.existsSync(extracted.executablePath),
        asarHash: crypto.createHash('sha256').update(extractedAsar).digest('hex')
      };
    });

    expect(result).toEqual({
      executableExists: true,
      asarHash: crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex')
    });
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
