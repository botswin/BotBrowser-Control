param([string]$Installer = (Join-Path $PSScriptRoot '..\setup-windows-source.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Installer), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($definition in $ast.EndBlock.Statements) {
  if ($definition -is [Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($definition.Extent.Text))
  }
}
$branch = $ast.Find({
  param($item)
  $item -is [Management.Automation.Language.IfStatementAst] -and
    $item.Extent.Text.Contains('Reusing verified Node.js from the current installation')
}, $true)
if (-not $branch) { throw 'Cannot find the installer Node reuse branch' }
$condition = [scriptblock]::Create($branch.Clauses[0].Item1.Extent.Text)
$fixture = Join-Path $PSScriptRoot ('..\test-results\node-probe-' + [guid]::NewGuid())
$ExistingNodeDir = Join-Path $fixture 'valid'
$invalidDir = Join-Path $fixture 'invalid'
New-Item -ItemType Directory -Path $ExistingNodeDir, $invalidDir -Force | Out-Null
$node = Join-Path $ExistingNodeDir 'node.exe'
Add-Type -OutputAssembly $node -OutputType ConsoleApplication -TypeDefinition @'
using System;
public class NodeProbeFixture {
  public static int Main(string[] args) {
    var mode = Environment.GetEnvironmentVariable("CONTROL_TEST_NODE_MODE");
    var version = args.Length == 1 && args[0] == "--version";
    if ((version && mode == "empty-version") || (!version && mode == "empty-arch")) return 0;
    if (mode == "stderr") { Console.Error.WriteLine("Node failed"); return 9; }
    Console.WriteLine(version
      ? (mode == "wrong-version" ? "v0.0.0" : "v24.15.0")
      : (mode == "wrong-arch" ? "ia32" : Environment.GetEnvironmentVariable("CONTROL_TEST_NODE_ARCH")));
    if ((version && mode == "exit-version") || (!version && mode == "exit-arch")) return 7;
    return 0;
  }
}
'@
[IO.File]::WriteAllText((Join-Path $invalidDir 'node.exe'), 'not an executable')
$NodeVersion = '24.15.0'
$cases = @(
  @{ Name = 'matching x64'; Mode = 'valid'; Arch = 'x64'; Expected = $true },
  @{ Name = 'matching arm64 output'; Mode = 'valid'; Arch = 'arm64'; Expected = $true },
  @{ Name = 'missing Node'; Mode = 'missing'; Arch = 'x64'; Expected = $false },
  @{ Name = 'empty version'; Mode = 'empty-version'; Arch = 'x64'; Expected = $false },
  @{ Name = 'empty architecture'; Mode = 'empty-arch'; Arch = 'x64'; Expected = $false },
  @{ Name = 'wrong version'; Mode = 'wrong-version'; Arch = 'x64'; Expected = $false },
  @{ Name = 'wrong architecture'; Mode = 'wrong-arch'; Arch = 'x64'; Expected = $false },
  @{ Name = 'version exits nonzero with valid output'; Mode = 'exit-version'; Arch = 'x64'; Expected = $false },
  @{ Name = 'architecture exits nonzero with valid output'; Mode = 'exit-arch'; Arch = 'x64'; Expected = $false },
  @{ Name = 'stderr and failure'; Mode = 'stderr'; Arch = 'x64'; Expected = $false },
  @{ Name = 'invalid executable'; Mode = 'invalid'; Arch = 'x64'; Expected = $false }
)
$oldMode = $env:CONTROL_TEST_NODE_MODE
$oldArch = $env:CONTROL_TEST_NODE_ARCH
$failures = 0
try {
  foreach ($case in $cases) {
    $env:CONTROL_TEST_NODE_MODE = $case.Mode
    $env:CONTROL_TEST_NODE_ARCH = $case.Arch
    $Arch = $case.Arch
    $ExistingNodeDir = switch ($case.Mode) {
      'missing' { Join-Path $fixture 'missing' }
      'invalid' { $invalidDir }
      default { Join-Path $fixture 'valid' }
    }
    try {
      $actual = & $condition
      if ($actual -isnot [bool] -or $actual -ne $case.Expected) {
        throw "Expected reuse=$($case.Expected), received '$actual'"
      }
      Write-Output "PASS: $($case.Name)"
    } catch {
      $failures++
      Write-Output "FAIL: $($case.Name): $($_.FullyQualifiedErrorId): $($_.Exception.Message)"
    }
  }
} finally {
  $env:CONTROL_TEST_NODE_MODE = $oldMode
  $env:CONTROL_TEST_NODE_ARCH = $oldArch
}
Write-Output "NODE_PROBE_RESULTS=$($cases.Count - $failures)/$($cases.Count)"
if ($failures) { exit 1 }
