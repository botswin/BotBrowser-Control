# Installing BotBrowser Control

Step-by-step installation guide for macOS, Windows, and Linux.

---

## macOS

### From DMG (recommended)

1. Download `BotBrowser.Control-*-arm64.dmg` (Apple Silicon) or `BotBrowser.Control-*-x64.dmg` (Intel) from [Releases](https://github.com/botswin/BotBrowser/releases)
2. Double-click the `.dmg` file to mount it
3. Drag **BotBrowser Control** into your `/Applications` folder
4. Eject the DMG
5. On first launch, right-click the app → **Open** (to bypass Gatekeeper on unsigned builds)

### From source

```bash
# Requires Node.js 18+ (https://nodejs.org)
git clone https://github.com/botswin/BotBrowser.git
cd BotBrowser/botbrowser-control
npm install
npm start
```

### Build your own DMG

```bash
npm install
npm run build:mac        # builds both x64 + arm64 DMG & ZIP into dist/
```

---

## Windows

### From NSIS Installer (recommended)

1. Download `BotBrowser.Control.Setup-*.exe` from [Releases](https://github.com/botswin/BotBrowser/releases)
2. Double-click the installer
3. Follow the setup wizard (choose install directory, create shortcuts)
4. Launch from the Start Menu or Desktop shortcut

### Portable (no install needed)

1. Download `BotBrowser.Control-*-portable.exe`
2. Run it directly — no installation required

### From source

```powershell
# Requires Node.js 18+ (https://nodejs.org)
git clone https://github.com/botswin/BotBrowser.git
cd BotBrowser\botbrowser-control
npm install
npm start
```

### Build your own installer

```powershell
npm install
npm run build:win        # builds NSIS + portable + ZIP into dist\
```

---

## Linux

### AppImage (works on any distro)

```bash
# Download
wget https://github.com/botswin/BotBrowser/releases/download/vX.X.X/BotBrowser.Control-X.X.X.AppImage

# Make executable
chmod +x BotBrowser.Control-*.AppImage

# Run
./BotBrowser.Control-*.AppImage
```

### Debian / Ubuntu (.deb)

```bash
# Download and install
wget https://github.com/botswin/BotBrowser/releases/download/vX.X.X/botbrowser-control_X.X.X_amd64.deb
sudo dpkg -i botbrowser-control_*.deb

# Fix any missing dependencies
sudo apt install -f

# Launch
botbrowser-control
```

### Red Hat / Fedora / CentOS (.rpm)

```bash
# Download and install
wget https://github.com/botswin/BotBrowser/releases/download/vX.X.X/botbrowser-control-X.X.X.x86_64.rpm
sudo rpm -i botbrowser-control-*.rpm

# Or with dnf
sudo dnf install botbrowser-control-*.rpm

# Launch
botbrowser-control
```

### From source

```bash
# Requires Node.js 18+ — install via nvm or your package manager
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 20

git clone https://github.com/botswin/BotBrowser.git
cd BotBrowser/botbrowser-control
npm install
npm start
```

### Build your own packages

```bash
npm install
npm run build:linux      # builds AppImage + .deb + .rpm + tar.gz into dist/
```

---

## Verifying Your Node.js Version

```bash
node --version   # must be v18.0.0 or later
npm --version    # must be v9.0.0 or later
```

If you need to upgrade Node.js:

```bash
# Using nvm (macOS/Linux)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20

# Using fnm (faster, cross-platform)
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 20

# Using winget (Windows)
winget install OpenJS.NodeJS
```

---

## First-time Configuration

After installation, configure the path to your BotBrowser binary:

1. Open BotBrowser Control
2. Click **Settings** in the left sidebar
3. Under **BotBrowser Executable**, click **Browse** and locate:
   - **macOS:** `/Applications/Chromium.app/Contents/MacOS/Chromium`
   - **Windows:** `C:\Program Files\BotBrowser\chrome.exe`
   - **Linux:** `/usr/bin/botbrowser` or wherever you extracted BotBrowser
4. Click **Save Settings**

> **Don't have BotBrowser yet?** Download it from [github.com/botswin/BotBrowser](https://github.com/botswin/BotBrowser)

---

## Uninstalling

### macOS
- Drag `BotBrowser Control.app` from `/Applications` to Trash
- Remove app data (optional): `rm -rf ~/Library/Application\ Support/BotBrowser\ Control`

### Windows
- Go to **Settings → Apps → Installed Apps**, find **BotBrowser Control**, click **Uninstall**
- Or run `%LOCALAPPDATA%\Programs\BotBrowser Control\Uninstall BotBrowser Control.exe`
- Remove app data (optional): delete `%APPDATA%\BotBrowser Control`

### Linux (AppImage)
- Delete the `.AppImage` file
- Remove app data (optional): `rm -rf ~/.config/BotBrowser\ Control`

### Linux (.deb)
```bash
sudo apt remove botbrowser-control
```

### Linux (.rpm)
```bash
sudo rpm -e botbrowser-control
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| App shows "Electron" in title bar | Update to latest version from source |
| "BotBrowser executable not found" | Set the correct path in Settings |
| App won't open on macOS (Gatekeeper) | Right-click → Open, then click Open in the dialog |
| White screen on startup | Run `npm start` in terminal to see error output |
| `ENOENT: node_modules` error | Run `npm install` in the project directory |
| Profiles stuck as "Running" after force-quit | Restart the app — stale status is reset automatically on launch |
| Can't install `.deb` — missing deps | Run `sudo apt install -f` after `dpkg -i` |

---

For more help, open an issue at [github.com/botswin/BotBrowser/issues](https://github.com/botswin/BotBrowser/issues)