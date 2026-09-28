# Install BotBrowser Control

Control and the BotBrowser Kernel are separate downloads.

## Current availability

The supported installation path is local source bootstrap. The scripts download this public repository, install dependencies, build on the customer machine, and launch Control. A tagged prebuilt release is optional, not required. Do not use the BotBrowser Kernel release page as a Control installer source.

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

Managed Kernel mode is enabled by default. Control checks the public [botswin/BotBrowser releases](https://github.com/botswin/BotBrowser/releases), downloads the profile's required major when missing, and automatically selects the installed executable. It also checks for newer full versions and newer asset dates periodically. Kernel downloads, not Control application installers, come from this separate release page.

Use Settings > Executable Mode > Custom path only when you intentionally want to override managed Kernel selection.

## Support

Open Control issues at [botswin/BotBrowser-Control/issues](https://github.com/botswin/BotBrowser-Control/issues).
