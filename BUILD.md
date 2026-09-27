# Build BotBrowser Control

## Local build

Manual source builds require Node.js 24.15.0 and npm.

```bash
npm ci
npm start
```

Build packages on a platform that supports the target:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Output is written to `dist/`.

## Supported build targets

The package configuration explicitly defines:

- macOS x64 and arm64: DMG and ZIP
- Windows x64 and arm64: NSIS installer and ZIP
- Windows x64: portable EXE
- Linux x64 and arm64: AppImage, DEB, and tar.gz

The Windows workflow uploads `dist/*.exe` and `dist/*-win.zip`. The macOS workflow uploads DMG plus macOS ZIP files. The Linux workflow uploads AppImage, DEB, RPM, and tar.gz files; RPM is only uploaded when produced by the runner configuration.

## Tagged release workflow

`.github/workflows/build.yml` runs on `v*.*.*` tags. It builds macOS, Windows, and Linux jobs, then attaches produced artifacts to a GitHub Release in [botswin/BotBrowser-Control](https://github.com/botswin/BotBrowser-Control/releases).

This repository has no current Control Release asset claim in this document. A tag and successful workflow are required before a Control asset exists.

## Naming

`electron-builder` uses the product name `BotBrowser Control`. Typical outputs include `BotBrowser Control Setup <version>.exe`, `BotBrowser Control-<version>-arm64.dmg`, and `botbrowser-control_<version>_amd64.deb`. Treat exact filenames as release artifacts, not a stable API.

## Kernel separation

This build document covers Control only. BotBrowser Kernel binaries are obtained from [botswin/BotBrowser](https://github.com/botswin/BotBrowser/releases), which is a separate Kernel release stream.