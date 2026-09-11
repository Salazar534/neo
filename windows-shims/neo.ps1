# Global Neo launcher — works from any directory.
$ErrorActionPreference = "Stop"
$rootFile = Join-Path $env:LOCALAPPDATA "Neo\neo_root.txt"
if (Test-Path $rootFile) {
  $NeoRoot = (Get-Content -Raw $rootFile).Trim()
} else {
  $NeoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -ErrorAction SilentlyContinue
  if (-not $NeoRoot) { $NeoRoot = $PSScriptRoot + "\.." }
}
$entry = Join-Path $NeoRoot "bin\neo.mjs"
if (-not (Test-Path $entry)) {
  Write-Host "NEO: missing $entry" -ForegroundColor Red
  exit 1
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "NEO: node not found on PATH" -ForegroundColor Red
  exit 1
}
$env:NEO_WORKSPACE = (Get-Location).Path
& node $entry @args
exit $LASTEXITCODE
