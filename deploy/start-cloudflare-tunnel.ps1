param(
  [string]$TunnelName = "space-work-home",
  [string]$CloudflaredPath = "C:\Cloudflared\bin\cloudflared.exe",
  [switch]$Managed,
  [switch]$StopOnly,
  [string]$PidFile = "",
  [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"

function Stop-ManagedProcess {
  param(
    [string]$PidPath
  )

  if (-not $PidPath -or -not (Test-Path $PidPath)) {
    return
  }

  $rawPid = (Get-Content $PidPath -Raw -ErrorAction SilentlyContinue).Trim()

  if ($rawPid -match '^\d+$') {
    $existingProcess = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue

    if ($existingProcess) {
      Stop-Process -Id $existingProcess.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 400
    }
  }

  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

function Stop-MatchingProcesses {
  param(
    [string]$ProcessName,
    [string[]]$Patterns
  )

  try {
    $matchingProcesses = Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" -ErrorAction Stop |
      Where-Object {
        $commandLine = [string]($_.CommandLine)
        $matchesAllPatterns = [bool]$commandLine

        if ($matchesAllPatterns) {
          foreach ($pattern in $Patterns) {
            if ($pattern -and $commandLine -notlike "*$pattern*") {
              $matchesAllPatterns = $false
              break
            }
          }
        }

        $matchesAllPatterns
      }
  } catch {
    return
  }

  foreach ($processInfo in $matchingProcesses) {
    if ($processInfo.ProcessId -and $processInfo.ProcessId -ne $PID) {
      Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Normalize-ProcessEnvironmentPath {
  $resolvedPath = [string]$env:Path

  if (-not $resolvedPath -and $env:PATH) {
    $resolvedPath = [string]$env:PATH
  }

  Remove-Item Env:PATH -ErrorAction SilentlyContinue

  if ($resolvedPath) {
    $env:Path = $resolvedPath
  }
}

if (-not $StopOnly -and -not (Test-Path $CloudflaredPath)) {
  throw "cloudflared executable was not found: $CloudflaredPath"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $Managed) {
  & $CloudflaredPath tunnel run $TunnelName
  exit $LASTEXITCODE
}

if (-not $LogDir) {
  $LogDir = Join-Path $repoRoot "logs"
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if (-not $PidFile) {
  $PidFile = Join-Path $LogDir "cloudflare-tunnel.pid"
}

$stdoutLog = Join-Path $LogDir "cloudflare-tunnel.out.log"
$stderrLog = Join-Path $LogDir "cloudflare-tunnel.err.log"

Stop-ManagedProcess -PidPath $PidFile
Stop-MatchingProcesses -ProcessName "cloudflared.exe" -Patterns @("tunnel", "run", $TunnelName)
Stop-MatchingProcesses -ProcessName "powershell.exe" -Patterns @($repoRoot, "start-cloudflare-tunnel.ps1", $TunnelName)
Stop-MatchingProcesses -ProcessName "cmd.exe" -Patterns @("cloudflared.exe", "tunnel", "run", $TunnelName)

if ($StopOnly) {
  Write-Host "Cloudflare tunnel stopped in managed mode."
  Write-Host "PID file: $PidFile"
  Write-Host "Tunnel: $TunnelName"
  exit 0
}

Normalize-ProcessEnvironmentPath
$tunnelProcess = Start-Process `
  -FilePath $CloudflaredPath `
  -ArgumentList @("tunnel", "run", $TunnelName) `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Milliseconds 700

if ($tunnelProcess.HasExited) {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  throw "Cloudflare tunnel exited immediately. Check $stderrLog"
}

Set-Content -Path $PidFile -Value $tunnelProcess.Id -NoNewline

Write-Host "Cloudflare tunnel restarted in managed mode."
Write-Host "PID: $($tunnelProcess.Id)"
Write-Host "Tunnel: $TunnelName"
Write-Host "STDOUT: $stdoutLog"
Write-Host "STDERR: $stderrLog"
