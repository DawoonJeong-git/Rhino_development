param(
  [string]$ProdRoot = $(if (Test-Path "C:\SpaceWork_deploy") { "C:\SpaceWork_deploy" } elseif (Test-Path "C:\Rhino_deploy") { "C:\Rhino_deploy" } else { "C:\SpaceWork_deploy" }),
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ProdRoot)) {
  throw "Production folder does not exist: $ProdRoot"
}

$gitDir = Join-Path $ProdRoot ".git"
if (-not (Test-Path $gitDir)) {
  throw "Not a git repository: $ProdRoot"
}

Set-Location $ProdRoot

Write-Host "Updating production clone in $ProdRoot"
git fetch origin
git checkout $Branch
git pull origin $Branch

Write-Host "Refreshing dependencies"
npm.cmd install

Write-Host ""
Write-Host "Update complete."
Write-Host "If the server is not auto-restarting, restart it from $ProdRoot."
