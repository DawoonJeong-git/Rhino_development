param(
  [string]$ProdRoot = "C:\SpaceWork_deploy",
  [string]$Branch = "main",
  [switch]$SkipRestart,
  [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

function Get-ServerPort {
  param(
    [string]$RepoRoot
  )

  $defaultPort = 3000
  $configPath = Join-Path $RepoRoot "config.local.json"

  if (-not (Test-Path $configPath)) {
    return $defaultPort
  }

  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $resolvedPort = [int]$config.PORT

    if ($resolvedPort -gt 0) {
      return $resolvedPort
    }
  } catch {
    return $defaultPort
  }

  return $defaultPort
}

if (-not (Test-Path $ProdRoot)) {
  throw "Production folder does not exist: $ProdRoot"
}

$gitDir = Join-Path $ProdRoot ".git"
if (-not (Test-Path $gitDir)) {
  throw "Not a git repository: $ProdRoot"
}

Set-Location $ProdRoot

$beforeCommit = (git rev-parse --short HEAD).Trim()
Write-Host "Updating production clone in $ProdRoot"
git fetch origin
git checkout $Branch
git pull --ff-only origin $Branch
$afterCommit = (git rev-parse --short HEAD).Trim()

Write-Host "Refreshing dependencies"
npm.cmd install

if (-not $SkipRestart) {
  Write-Host "Restarting managed production server"
  powershell -ExecutionPolicy Bypass -File (Join-Path $ProdRoot "deploy\start-server.ps1") -Managed
}

if (-not $SkipSmoke) {
  $serverPort = Get-ServerPort -RepoRoot $ProdRoot
  $verifyScript = Join-Path $ProdRoot "scripts\verify-release.mjs"

  if (Test-Path $verifyScript) {
    Write-Host "Running post-deploy verification bundle on http://127.0.0.1:$serverPort"
    node $verifyScript --base-url "http://127.0.0.1:$serverPort"
  } else {
    Write-Warning "Smoke check script not found: $verifyScript"
  }
}

Write-Host ""
Write-Host "Update complete."
Write-Host "Commit: $beforeCommit -> $afterCommit"
Write-Host "Production root: $ProdRoot"
