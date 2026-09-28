# BotBrowser Control

Desktop profile manager for [BotBrowser Kernel](https://github.com/botswin/BotBrowser).

[Install](INSTALL.md) | [Build](BUILD.md) | [Issues](https://github.com/botswin/BotBrowser-Control/issues) | [Homepage](https://github.com/botswin/BotBrowser-Control)

## What it does

Create and manage local browser profiles, configure launch settings, and start or stop BotBrowser from one desktop application. By default Control manages the matching BotBrowser Kernel for each profile, downloads a missing Kernel, and selects its executable automatically.

## Install

The primary installation path is source bootstrap: the setup scripts download this public repository, install dependencies, build locally, and launch Control. Prebuilt Release assets are optional and are not required. If published, they may include a `manifest.json` for checksum-aware installers.

For the current main branch, use the source bootstrap script for your platform. It downloads the current main source, rebuilds Control locally, and replaces that source installation. Re-running it is a reinstall of current main, not an automatic application update.

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

See [INSTALL.md](INSTALL.md) for source and future tagged-release installation details.

## Build and test

Manual source builds require Node.js 24.15.0 and npm.

```bash
npm ci
npm start
npm run test:baseline
```

The release workflow explicitly builds macOS x64 and arm64, Windows x64 and arm64, and Linux x64 and arm64. See [BUILD.md](BUILD.md).

## Kernel downloads

Control is separate from the BotBrowser Kernel. Obtain Kernel binaries and Kernel release information only from [botswin/BotBrowser](https://github.com/botswin/BotBrowser). Control release assets, issues, and homepage use [botswin/BotBrowser-Control](https://github.com/botswin/BotBrowser-Control).

Managed Kernel mode is the default. Control checks public BotBrowser releases at startup and periodically, keeps the newest full version and asset date for installed majors, and downloads a profile's required major when it is missing. A custom executable path remains available as an advanced override in Settings.

## Support

Report Control problems at [BotBrowser Control issues](https://github.com/botswin/BotBrowser-Control/issues).

## License

MIT. See [LICENSE](LICENSE).
## Privacy boundary

Control keeps profile configuration, cookies, and browser data on the local machine. It has no profile upload or cloud sync endpoint. Network requests are limited to release metadata, explicitly selected update assets, and pages opened by the user.
