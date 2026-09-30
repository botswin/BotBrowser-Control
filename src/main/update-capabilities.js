const { getPosixInstallUnit } = require('./update-apply');

const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);

function unavailable(platform, arch, reason) {
  return reason
    ? { canInstall: false, platform, arch, format: null, reason }
    : { canInstall: false, platform, arch, format: null };
}

function getUpdateCapabilities({ isPackaged, platform, arch, executablePath, appImagePath }) {
  if (!isPackaged || !SUPPORTED_ARCHES.has(arch)) return unavailable(platform, arch);

  if (platform === 'win32') return { canInstall: true, platform, arch, format: 'zip' };

  if (platform !== 'darwin' && platform !== 'linux') return unavailable(platform, arch);

  try {
    const unit = getPosixInstallUnit({ platform, executablePath, appImagePath });
    if (platform === 'darwin') {
      return unit.kind === 'directory'
        ? { canInstall: true, platform, arch, format: 'zip' }
        : unavailable(platform, arch);
    }
    return { canInstall: true, platform, arch, format: unit.kind === 'file' ? 'appimage' : 'tar.gz' };
  } catch {
    return unavailable(platform, arch, 'install_path_unavailable');
  }
}

module.exports = { getUpdateCapabilities };
