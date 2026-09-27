[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [string]$InstallDir = "$env:LOCALAPPDATA\BotBrowser Control",
  [string]$ManifestUrl = 'https://github.com/botswin/BotBrowser-Control/releases/latest/download/manifest.json',
  [string]$AssetUrl,
  [string]$Sha256
)
$ErrorActionPreference = 'Stop'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw 'Windows x64 is required' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ("botbrowser-control-" + [guid]::NewGuid())
$stage = Join-Path $temp 'stage'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  $targetVersion = $Version
  if (-not $AssetUrl -or -not $Sha256) {
    $manifest = Invoke-RestMethod -Uri $ManifestUrl
    if ($Version -eq 'latest') {
      $targetVersion = [string]$manifest.version
      if (-not $targetVersion) { throw 'Manifest version is required for latest' }
      $asset = @($manifest.assets | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq $arch -and $_.version -eq $targetVersion })
    } else {
      $asset = @($manifest.assets | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq $arch -and $_.version -eq $Version })
    }
    if ($asset.Count -ne 1) { throw "No unique Windows $arch asset for version $Version" }
    $AssetUrl = [string]$asset[0].url
    $Sha256 = [string]$asset[0].sha256
  }
  if ($Sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'SHA-256 checksum must be 64 hexadecimal characters' }
  $archive = Join-Path $temp 'package.zip'
  Invoke-WebRequest -Uri $AssetUrl -OutFile $archive
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $Sha256.ToUpperInvariant()) { throw 'SHA-256 checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
  $target = Join-Path $InstallDir ($targetVersion -replace '[^A-Za-z0-9._-]', '_')
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  if (Test-Path $target) { throw "Version already installed: $target" }
  Move-Item -LiteralPath $stage -Destination $target
  Write-Output "Installed BotBrowser Control $targetVersion to $target"
} finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
