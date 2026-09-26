# Building BotBrowser Control

Complete guide to building distributable packages for macOS, Windows, and Linux.

---

## Quick Start

```bash
npm install          # install all dependencies first
npm run build        # build for ALL platforms
```

All output goes to the `dist/` folder.

---

## Prerequisites

### Node.js 18+
```bash
node --version   # must be v18.0.0+
npm --version    # must be v9.0.0+
```

Install via [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux) or [winget](https://winget.run/) (Windows):
```bash
# macOS / Linux
nvm install 20 && nvm use 20

# Windows
winget install OpenJS.NodeJS
```

### Install project dependencies
```bash
cd botbrowser-control
npm install
```

---

## Build Commands

| Command | Platforms | Output |
|---------|-----------|--------|
| `npm run build` | All | Mac DMG+ZIP, Win NSIS+Portable+ZIP, Linux AppImage+DEB+RPM+tar.gz |
| `npm run build:mac` | macOS | `.dmg` + `.zip` (x64 + arm64) |
| `npm run build:mac:x64` | macOS Intel | `.dmg` + `.zip` |
| `npm run build:mac:arm64` | macOS Apple Silicon | `.dmg` + `.zip` |
| `npm run build:win` | Windows | NSIS `.exe` + Portable + `.zip` (x64 + arm64) |
| `npm run build:win:x64` | Windows x64 | NSIS `.exe` + Portable + `.zip` |
| `npm run build:win:ia32` | Windows 32-bit | NSIS `.exe` |
| `npm run build:win:arm64` | Windows ARM64 | NSIS `.exe` |
| `npm run build:linux` | Linux | `.AppImage` + `.deb` + `.rpm` + `.tar.gz` (x64 + arm64) |
| `npm run build:linux:x64` | Linux x64 | All Linux formats |
| `npm run build:linux:arm64` | Linux ARM64 | `.AppImage` + `.deb` + `.tar.gz` |

---

## Platform-specific Notes

### Building on macOS

No extra tools needed. Builds macOS and Linux targets natively.

```bash
npm run build:mac      # native, always works
npm run build:linux    # also works on macOS (cross-compile)
npm run build:win      # requires Wine for NSIS
```

Install Wine for Windows builds:
```bash
brew install --cask wine-stable
```

### Building on Windows

```powershell
npm run build:win      # native, always works
# Mac + Linux targets require WSL or GitHub Actions
```

### Building on Linux

```bash
# Install build tools
sudo apt-get install -y libgtk-3-dev libnotify-dev libnss3 libxss1 libxtst6 rpm fakeroot

npm run build:linux    # native, always works
npm run build:win      # requires Wine: sudo apt install wine64
# macOS targets require GitHub Actions
```

---

## Output Directory

After a full `npm run build`, the `dist/` folder contains:

```
dist/
├── BotBrowser Control-1.0.0.dmg                  ← macOS Intel DMG
├── BotBrowser Control-1.0.0-arm64.dmg            ← macOS Apple Silicon DMG
├── BotBrowser Control-1.0.0-mac.zip              ← macOS Intel ZIP
├── BotBrowser Control-1.0.0-arm64-mac.zip        ← macOS Apple Silicon ZIP
│
├── BotBrowser Control Setup 1.0.0.exe            ← Windows x64 NSIS installer
├── BotBrowser Control Setup 1.0.0-arm64.exe      ← Windows ARM64 installer
├── BotBrowser Control 1.0.0.exe                  ← Windows portable
├── BotBrowser Control-1.0.0-win.zip              ← Windows ZIP
│
├── BotBrowser Control-1.0.0.AppImage             ← Linux x64 AppImage
├── BotBrowser Control-1.0.0-arm64.AppImage       ← Linux ARM64 AppImage
├── botbrowser-control_1.0.0_amd64.deb            ← Debian/Ubuntu x64
├── botbrowser-control_1.0.0_arm64.deb            ← Debian/Ubuntu ARM64
├── botbrowser-control-1.0.0.x86_64.rpm           ← Red Hat/Fedora
└── botbrowser-control-1.0.0.tar.gz               ← Generic Linux tarball
```

---

## Automated Builds with GitHub Actions

The repository includes `.github/workflows/build.yml` which:

1. Triggers on any tag push matching `v*.*.*` (e.g. `v1.0.0`)
2. Runs **3 parallel jobs**: `macos-latest`, `windows-latest`, `ubuntu-latest`
3. Uploads all artifacts to the GitHub Release automatically

### How to trigger a release

```bash
# Tag and push to trigger the workflow
git tag v1.0.0
git push origin v1.0.0
```

The Actions workflow will build all three platforms in parallel and attach every artifact to the GitHub Release.

### Workflow file location
`.github/workflows/build.yml`

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `electron-builder: command not found` | Run `npm install` first |
| `fpm not found` (RPM/DEB on Linux) | `sudo apt install ruby-dev && gem install fpm` or `sudo apt install rpm fakeroot` |
| Windows NSIS build fails on Linux/macOS | Install Wine: `brew install --cask wine-stable` or `sudo apt install wine64` |
| macOS DMG build fails on Linux | Use `macos-latest` GitHub Actions runner |
| Electron download hangs / slow | Set mirror: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install` |
| Icon error during build | Ensure `src/assets/icon.png` exists and is at least 512×512 pixels |
| `ENOTFOUND` / network errors | Check internet connection; try with VPN off |
| `code signing` errors on macOS | Set `hardenedRuntime: false` and `gatekeeperAssess: false` in package.json (already set) |

---

## Development Mode

Run without building:
```bash
npm start       # production mode
npm run dev     # development mode (enables devtools, --dev flag)
```

Package without installer (just the unpacked app directory):
```bash
npm run pack    # outputs to dist/linux-unpacked, dist/mac, or dist/win-unpacked
```