$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
node server.mjs
