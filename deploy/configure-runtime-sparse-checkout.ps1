param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}

$manifestPath = Join-Path $RepoRoot "deploy\runtime-sparse-checkout.txt"

if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  throw "Not a git repository: $RepoRoot"
}

if (-not (Test-Path $manifestPath)) {
  throw "Sparse checkout manifest was not found: $manifestPath"
}

Set-Location $RepoRoot

$patterns = Get-Content $manifestPath |
  Where-Object {
    $trimmed = [string]$_
    -not [string]::IsNullOrWhiteSpace($trimmed) -and -not $trimmed.TrimStart().StartsWith("#")
  }

if (-not $patterns.Count) {
  throw "Sparse checkout manifest is empty: $manifestPath"
}

git sparse-checkout init --no-cone
$patterns | git sparse-checkout set --stdin

Write-Host "Applied runtime sparse checkout in $RepoRoot"
Write-Host "Manifest: $manifestPath"
