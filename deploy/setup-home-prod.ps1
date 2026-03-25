param(
  [string]$ProdRoot = "C:\Rhino_deploy",
  [string]$RepoUrl = "https://github.com/DawoonJeong-git/Rhino_development.git",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$devRoot = Split-Path -Parent $PSScriptRoot
$sourceConfig = Join-Path $devRoot "config.local.json"

if (Test-Path $ProdRoot) {
  throw "Production folder already exists: $ProdRoot"
}

Write-Host "Creating production clone at $ProdRoot"
git clone --branch $Branch $RepoUrl $ProdRoot

$configExample = Join-Path $ProdRoot "config.local.json.example"
$configTarget = Join-Path $ProdRoot "config.local.json"

if ((Test-Path $sourceConfig) -and -not (Test-Path $configTarget)) {
  Copy-Item $sourceConfig $configTarget
  Write-Host "Copied existing local config to production: $configTarget"
} elseif ((Test-Path $configExample) -and -not (Test-Path $configTarget)) {
  Copy-Item $configExample $configTarget
  Write-Host "Created production config template: $configTarget"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Edit $configTarget"
Write-Host "2. Run: cd $ProdRoot"
Write-Host "3. Run: npm.cmd install"
Write-Host "4. Run: powershell -ExecutionPolicy Bypass -File deploy\\start-server.ps1"
