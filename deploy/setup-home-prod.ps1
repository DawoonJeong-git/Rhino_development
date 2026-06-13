param(
  [string]$ProdRoot = "C:\SpaceWork_deploy",
  [string]$RepoUrl = "",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$devRoot = Split-Path -Parent $PSScriptRoot
$sourceConfig = Join-Path $devRoot "config.local.json"

if (-not $RepoUrl) {
  try {
    $RepoUrl = (git -C $devRoot remote get-url origin).Trim()
  } catch {
    $RepoUrl = ""
  }
}

if (-not $RepoUrl) {
  throw "Repository URL could not be resolved automatically. Pass -RepoUrl explicitly."
}

if (Test-Path $ProdRoot) {
  throw "Production folder already exists: $ProdRoot"
}

Write-Host "Creating production clone at $ProdRoot"
git clone --branch $Branch $RepoUrl $ProdRoot

$sparseScript = Join-Path $ProdRoot "deploy\configure-runtime-sparse-checkout.ps1"
if (Test-Path $sparseScript) {
  Write-Host "Configuring production sparse checkout"
  powershell -ExecutionPolicy Bypass -File $sparseScript -RepoRoot $ProdRoot
}

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
Write-Host "4. Run: deploy\\CLICK_1_START_BOTH_WEB.bat"
Write-Host "5. After a selected Git push, run: deploy\\CLICK_3_GIT_PULL_DEPLOY.bat"
