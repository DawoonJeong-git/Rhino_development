param(
  [string]$ProdRoot = "C:\SpaceWork_deploy",
  [string]$Branch = "main",
  [string]$RouteBasePath = "/main",
  [switch]$SkipRestart,
  [switch]$SkipSmoke,
  [switch]$SkipPublicSmoke
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode {
  param(
    [string]$Step
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

function Get-NormalizedHttpsUrl {
  param(
    [string]$Value
  )

  $normalizedValue = [string]$Value

  if ($normalizedValue -match '^https://') {
    return $normalizedValue.TrimEnd('/')
  }

  return ""
}

function Join-UrlPath {
  param(
    [string]$BaseUrl,
    [string]$PathSuffix
  )

  $normalizedBaseUrl = [string]$BaseUrl
  $normalizedPathSuffix = [string]$PathSuffix

  if (-not $normalizedBaseUrl) {
    return ""
  }

  if (-not $normalizedPathSuffix) {
    return $normalizedBaseUrl.TrimEnd('/')
  }

  if ($normalizedPathSuffix -eq "/") {
    return "$($normalizedBaseUrl.TrimEnd('/'))/"
  }

  $trimmedPath = "/" + $normalizedPathSuffix.Trim('/')
  return "$($normalizedBaseUrl.TrimEnd('/'))$trimmedPath"
}

function Get-ServerPort {
  param(
    [string]$RepoRoot
  )

  $defaultPort = 3000
  $envPort = [int]0

  if ([int]::TryParse([string]$env:PORT, [ref]$envPort) -and $envPort -gt 0) {
    return $envPort
  }

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

function Get-PublicBaseUrl {
  param(
    [string]$RepoRoot,
    [string]$RouteBasePath = ""
  )

  $overrideUrl = Get-NormalizedHttpsUrl -Value ([string]$env:VERIFY_RELEASE_PUBLIC_BASE_URL)
  if ($overrideUrl) {
    return $overrideUrl
  }

  $configPath = Join-Path $RepoRoot "config.local.json"
  if (-not (Test-Path $configPath)) {
    return ""
  }

  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $resolvedPublicBaseUrl = Get-NormalizedHttpsUrl -Value ([string]$config.PUBLIC_BASE_URL)

    if ($resolvedPublicBaseUrl) {
      try {
        $publicUri = [System.Uri]$resolvedPublicBaseUrl
        if ($RouteBasePath -and ($publicUri.AbsolutePath -eq "/" -or [string]::IsNullOrWhiteSpace($publicUri.AbsolutePath))) {
          return Join-UrlPath -BaseUrl $resolvedPublicBaseUrl -PathSuffix $RouteBasePath
        }
      } catch {
        return $resolvedPublicBaseUrl
      }

      return $resolvedPublicBaseUrl
    }

    $resolvedUrl = Get-NormalizedHttpsUrl -Value ([string]$config.VWORLD_API_DOMAIN)

    if ($resolvedUrl) {
      return $resolvedUrl
    }
  } catch {
    return ""
  }

  return ""
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
Assert-LastExitCode -Step "git rev-parse before update"
Write-Host "Updating production clone in $ProdRoot"
git fetch origin
Assert-LastExitCode -Step "git fetch origin"
git checkout $Branch
Assert-LastExitCode -Step "git checkout $Branch"
git pull --ff-only origin $Branch
Assert-LastExitCode -Step "git pull --ff-only origin $Branch"
$afterCommit = (git rev-parse --short HEAD).Trim()
Assert-LastExitCode -Step "git rev-parse after update"

$sparseScript = Join-Path $ProdRoot "deploy\configure-runtime-sparse-checkout.ps1"
if (Test-Path $sparseScript) {
  Write-Host "Reapplying production sparse checkout"
  powershell -ExecutionPolicy Bypass -File $sparseScript -RepoRoot $ProdRoot
  Assert-LastExitCode -Step "reapply production sparse checkout"
}

Write-Host "Refreshing dependencies"
npm.cmd install
Assert-LastExitCode -Step "npm.cmd install"

if (-not $SkipRestart) {
  Write-Host "Restarting managed production server"
  $env:PORT = "3000"
  $env:ROUTE_BASE_PATH = $RouteBasePath
  powershell -ExecutionPolicy Bypass -File (Join-Path $ProdRoot "deploy\start-server.ps1") -Managed
  Assert-LastExitCode -Step "restart managed production server"
}

if (-not $SkipSmoke) {
  $serverPort = Get-ServerPort -RepoRoot $ProdRoot
  $verifyScript = Join-Path $ProdRoot "scripts\verify-release.mjs"
  $localBaseUrl = "http://127.0.0.1:$serverPort"

  if ($RouteBasePath) {
    $localBaseUrl = Join-UrlPath -BaseUrl $localBaseUrl -PathSuffix $RouteBasePath
  }

  if (Test-Path $verifyScript) {
    $verifyArgs = @(
      $verifyScript,
      "--base-url",
      $localBaseUrl
    )

    if ($SkipPublicSmoke) {
      $verifyArgs += "--skip-public"
      Write-Host "Running post-deploy verification bundle on $localBaseUrl (public smoke skipped)"
    } else {
      $publicBaseUrl = Get-PublicBaseUrl -RepoRoot $ProdRoot -RouteBasePath $RouteBasePath

      if ($publicBaseUrl) {
        $verifyArgs += @("--public-base-url", $publicBaseUrl)
        Write-Host "Running post-deploy verification bundle on $localBaseUrl and $publicBaseUrl"
      } else {
        Write-Host "Running post-deploy verification bundle on $localBaseUrl (no HTTPS public origin configured)"
      }
    }

    & node @verifyArgs
    Assert-LastExitCode -Step "post-deploy verification bundle"
  } else {
    Write-Warning "Smoke check script not found: $verifyScript"
  }
}

Write-Host ""
Write-Host "Update complete."
Write-Host "Commit: $beforeCommit -> $afterCommit"
Write-Host "Production root: $ProdRoot"
