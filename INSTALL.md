# Install BotBrowser Control

Control and the BotBrowser Kernel are separate downloads.

## Current availability

Control does not currently publish Release assets. Do not use the BotBrowser Kernel release page for Control installers. Future tagged Control assets will be published on [BotBrowser Control Releases](https://github.com/botswin/BotBrowser-Control/releases).

The source bootstrap commands below download the current `main` source and build it locally. Re-running a command reinstalls current `main`; it is not an automatic update service.

## Source bootstrap

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/botswin/BotBrowser-Control/main/setup-macos.sh | bash
```

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/botswin/BotBrowser-Control/main/setup-linux.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/botswin/BotBrowser-Control/main/setup-windows-source.ps1 | iex
```

## Build from source

Manual source builds require Node.js 24.15.0 and npm.

```bash
git clone https://github.com/botswin/BotBrowser-Control.git
cd BotBrowser-Control
npm ci
npm start
```

## Future tagged release assets

The tagged-release workflow is configured to build these Control assets:

- macOS x64 and arm64: DMG and ZIP
- Windows x64 and arm64: NSIS installer and ZIP; Windows x64 also has a portable EXE
- Linux x64 and arm64: AppImage, DEB, and tar.gz

Names follow the `electron-builder` product name, such as `BotBrowser Control Setup <version>.exe`, `BotBrowser Control-<version>-arm64.dmg`, and `botbrowser-control_<version>_amd64.deb`. Download only from the [Control Releases page](https://github.com/botswin/BotBrowser-Control/releases) after an asset exists.

## Configure the Kernel

After Control starts, open Settings and choose the BotBrowser executable installed on your system. Kernel binaries are published separately at [botswin/BotBrowser](https://github.com/botswin/BotBrowser/releases). These are Kernel downloads, not Control application installers.

## Support

Open Control issues at [botswin/BotBrowser-Control/issues](https://github.com/botswin/BotBrowser-Control/issues).