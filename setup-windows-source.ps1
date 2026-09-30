$ErrorActionPreference = 'Stop'
$NodeVersion = '24.15.0'
$Arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw 'Windows x64 or arm64 is required' }
}
$InstallDir = if ($env:CONTROL_INSTALL_DIR) { $env:CONTROL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'BotBrowser Control Source' }
$NodeDir = Join-Path $InstallDir 'node'
$RepoDir = Join-Path $InstallDir 'BotBrowser-Control'
$RepoZipUrl = if ($env:CONTROL_REPO_ZIP_URL) { $env:CONTROL_REPO_ZIP_URL } else { 'https://github.com/botswin/BotBrowser-Control/archive/refs/heads/main.zip' }
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ('botbrowser-control-' + [guid]::NewGuid())

New-Item -ItemType Directory -Path $InstallDir, $TempDir -Force | Out-Null
try {
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe')) -or (& (Join-Path $NodeDir 'node.exe') --version).Trim() -ne "v$NodeVersion" -or (& (Join-Path $NodeDir 'node.exe') -p process.arch).Trim() -ne $Arch) {
    $NodeZip = Join-Path $TempDir 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$Arch.zip" -OutFile $NodeZip
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Expand-Archive $NodeZip -DestinationPath $TempDir -Force
    Move-Item (Join-Path $TempDir "node-v$NodeVersion-win-$Arch") $NodeDir
  }

  $RepoZip = Join-Path $TempDir 'control.zip'
  Invoke-WebRequest $RepoZipUrl -OutFile $RepoZip
  if (Test-Path $RepoDir) { Remove-Item $RepoDir -Recurse -Force }
  Expand-Archive $RepoZip -DestinationPath $InstallDir -Force
  Move-Item (Join-Path $InstallDir 'BotBrowser-Control-main') $RepoDir
  $env:PATH = "$NodeDir;$env:PATH"
  $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  Write-Host '[4/6] Installing Node.js dependencies (this may take several minutes)...'
  Push-Location $RepoDir
  & (Join-Path $NodeDir 'npm.cmd') ci
  & (Join-Path $NodeDir 'npm.cmd') run pack -- --win "--$Arch"
  Pop-Location

  $UnpackedDir = if ($Arch -eq 'arm64') { 'win-arm64-unpacked' } else { 'win-unpacked' }
  $Exe = Join-Path $RepoDir "dist\$UnpackedDir\BotBrowser Control.exe"
  if (-not (Test-Path $Exe)) { throw 'Windows build produced no executable' }
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'BotBrowser Control.lnk'))
  $Shortcut.TargetPath = $Exe
  $Shortcut.WorkingDirectory = Split-Path $Exe
  $Shortcut.Save()
  Write-Host '[6/6] Launching BotBrowser Control...'
  Start-Process $Exe
} finally {
  if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
