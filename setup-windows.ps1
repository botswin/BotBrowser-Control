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
  if (-not $AssetUrl -or -not $Sha256) {
    $manifest = Invoke-RestMethod -Uri $ManifestUrl
    $asset = $manifest.assets | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq $arch -and ($Version -eq 'latest' -or $_.version -eq $Version) }
    if (@($asset).Count -ne 1) { throw "No unique Windows $arch asset for version $Version" }
    $AssetUrl = $asset.url; $Sha256 = $asset.sha256
  }
  $archive = Join-Path $temp 'package.zip'
  Invoke-WebRequest -Uri $AssetUrl -OutFile $archive
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $Sha256.ToUpperInvariant()) { throw 'SHA-256 checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
  $target = Join-Path $InstallDir ($Version -replace '[^A-Za-z0-9._-]', '_')
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  if (Test-Path $target) { throw "Version already installed: $target" }
  Move-Item -LiteralPath $stage -Destination $target
  Write-Output "Installed BotBrowser Control $Version to $target"
} finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
