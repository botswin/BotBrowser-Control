$ErrorActionPreference = 'Stop'
$NodeVersion = '24.15.0'
$Arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw 'Windows x64 or arm64 is required' }
}
$InstallDir = if ($env:CONTROL_INSTALL_DIR) { $env:CONTROL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'BotBrowser Control Source' }
$RepoZipUrl = if ($env:CONTROL_REPO_ZIP_URL) { $env:CONTROL_REPO_ZIP_URL } else { 'https://github.com/botswin/BotBrowser-Control/archive/refs/heads/main.zip' }
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ('botbrowser-control-' + [guid]::NewGuid())
$StageDir = "$InstallDir.staging-$([guid]::NewGuid())"
$NodeDir = Join-Path $StageDir 'node'
$RepoDir = Join-Path $StageDir 'BotBrowser-Control'
$ExistingNodeDir = Join-Path $InstallDir 'node'
$SkipLaunch = $env:CONTROL_SKIP_LAUNCH -eq '1'
$SkipShortcuts = $env:CONTROL_SKIP_SHORTCUTS -eq '1'

function Invoke-NpmWithHeartbeat([string[]]$Arguments, [string]$Phase, [string]$Description) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $quotedArgs = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '""') + '"' }) -join ' '
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /c ""' + (Join-Path $NodeDir 'npm.cmd') + '" ' + $quotedArgs + '"'
  $startInfo.WorkingDirectory = (Get-Location).ProviderPath
  $startInfo.UseShellExecute = $false
  $process = [Diagnostics.Process]::Start($startInfo)
  while (-not $process.WaitForExit(5000)) {
    Write-Host ("[$Phase] $Description still running ({0:mm\:ss})..." -f $watch.Elapsed)
  }
  $process.WaitForExit()
  $watch.Stop()
  if ($process.ExitCode -ne 0) { throw "$Description failed with exit code $($process.ExitCode)" }
}

function Invoke-DownloadWithHeartbeat([string]$Uri, [string]$OutFile, [string]$Phase, [string]$Description) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    Write-Host "[$Phase] $Description via curl..."
    $arguments = @('--fail', '--location', '--connect-timeout', '20', '--retry', '2', '--progress-bar', '--output', $OutFile, $Uri)
    $quotedArgs = ($arguments | ForEach-Object { '"' + $_.Replace('"', '""') + '"' }) -join ' '
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $curl.Source
    $startInfo.Arguments = $quotedArgs
    $startInfo.UseShellExecute = $false
    try {
      $process = [Diagnostics.Process]::Start($startInfo)
      while (-not $process.WaitForExit(5000)) {
        Write-Host ("[$Phase] $Description still running ({0:mm\:ss})..." -f $watch.Elapsed)
      }
      if ($process.ExitCode -eq 0 -and (Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) {
        $watch.Stop()
        return
      }
      Write-Warning "$Description via curl failed with exit code $($process.ExitCode); falling back to Invoke-WebRequest."
    } catch {
      Write-Warning "$Description via curl could not start; falling back to Invoke-WebRequest."
    }
  }

  Write-Host "[$Phase] $Description via Invoke-WebRequest..."
  Invoke-WebRequest $Uri -OutFile $OutFile -TimeoutSec 120
  if (-not (Test-Path $OutFile) -or (Get-Item $OutFile).Length -eq 0) {
    throw "$Description produced an empty download"
  }
  $watch.Stop()
}

New-Item -ItemType Directory -Path $StageDir, $TempDir -Force | Out-Null
try {
  if ((Test-Path (Join-Path $ExistingNodeDir 'node.exe')) -and
      ((& (Join-Path $ExistingNodeDir 'node.exe') --version).Trim() -eq "v$NodeVersion") -and
      ((& (Join-Path $ExistingNodeDir 'node.exe') -p process.arch).Trim() -eq $Arch)) {
    Write-Host '[1/6] Reusing verified Node.js from the current installation...'
    Copy-Item $ExistingNodeDir $NodeDir -Recurse
  } else {
    Write-Host '[1/6] Downloading Node.js...'
    $NodeZip = Join-Path $TempDir 'node.zip'
    Invoke-DownloadWithHeartbeat "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$Arch.zip" $NodeZip '1/6' 'Downloading Node.js'
    Write-Host '[2/6] Extracting Node.js...'
    Expand-Archive $NodeZip -DestinationPath $TempDir -Force
    Move-Item (Join-Path $TempDir "node-v$NodeVersion-win-$Arch") $NodeDir
  }

  Write-Host '[2/6] Downloading BotBrowser Control source...'
  $RepoZip = Join-Path $TempDir 'control.zip'
  Invoke-DownloadWithHeartbeat $RepoZipUrl $RepoZip '2/6' 'Downloading BotBrowser Control source'
  Write-Host '[3/6] Extracting BotBrowser Control source...'
  Expand-Archive $RepoZip -DestinationPath $StageDir -Force
  Move-Item (Join-Path $StageDir 'BotBrowser-Control-main') $RepoDir
  $env:PATH = "$NodeDir;$env:PATH"
  $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  Write-Host '[4/6] Installing Node.js dependencies (this may take several minutes)...'
  Push-Location $RepoDir
  Invoke-NpmWithHeartbeat @('ci') '4/6' 'Installing Node.js dependencies'
  Write-Host '[5/6] Packaging BotBrowser Control...'
  Invoke-NpmWithHeartbeat @('run', 'pack', '--', '--win', "--$Arch") '5/6' 'Packaging BotBrowser Control'
  Pop-Location

  $UnpackedDir = if ($Arch -eq 'arm64') { 'win-arm64-unpacked' } else { 'win-unpacked' }
  $Exe = Join-Path $RepoDir "dist\$UnpackedDir\BotBrowser Control.exe"
  if (-not (Test-Path $Exe)) { throw 'Windows build produced no executable' }
  Write-Host '[6/6] Activating staged installation...'
  if (Test-Path $InstallDir) {
    $BackupDir = "$InstallDir.backup-$((Get-Date).ToString('yyyyMMddHHmmss'))-$([guid]::NewGuid())"
    Move-Item $InstallDir $BackupDir
    try {
      Move-Item $StageDir $InstallDir
    } catch {
      Move-Item $BackupDir $InstallDir
      throw
    }
  } else {
    Move-Item $StageDir $InstallDir
  }
  $RepoDir = Join-Path $InstallDir 'BotBrowser-Control'
  $Exe = Join-Path $RepoDir "dist\$UnpackedDir\BotBrowser Control.exe"
  if ($SkipShortcuts) {
    Write-Host '[6/6] Shortcut creation skipped.'
  } else {
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'BotBrowser Control.lnk'))
    $Shortcut.TargetPath = $Exe
    $Shortcut.WorkingDirectory = Split-Path $Exe
    $Shortcut.Save()
  }
  if ($SkipLaunch) {
    Write-Host '[6/6] BotBrowser Control launch skipped.'
  } else {
    Write-Host '[6/6] Launching BotBrowser Control...'
    Start-Process $Exe
  }
} finally {
  if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
