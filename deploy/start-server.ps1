param(
  [switch]$Managed,
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

function Stop-PortListenerProcess {
  param(
    [int]$Port
  )

  if ($Port -le 0) {
    return
  }

  $listenerLines = @()

  try {
    $listenerLines = @(netstat -ano -p tcp | Select-String -Pattern "LISTENING" | Select-String -Pattern ":$Port\s")
  } catch {
    return
  }

  foreach ($listenerLine in $listenerLines) {
    $columns = ($listenerLine.ToString() -split '\s+') | Where-Object { $_ }

    if ($columns.Count -lt 5) {
      continue
    }

    $processId = 0

    if (-not [int]::TryParse($columns[-1], [ref]$processId)) {
      continue
    }

    if ($processId -le 0 -or $processId -eq $PID) {
      continue
    }

    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
    } catch {
      continue
    }

    if ($process.ProcessName -eq "node") {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 400
    }
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $Managed) {
  node server.mjs
  exit $LASTEXITCODE
}

if (-not $LogDir) {
  $LogDir = Join-Path $repoRoot "logs"
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

if (-not $PidFile) {
  $PidFile = Join-Path $LogDir "space-work-server.pid"
}

$stdoutLog = Join-Path $LogDir "space-work-server.out.log"
$stderrLog = Join-Path $LogDir "space-work-server.err.log"
$serverPort = Get-ServerPort -RepoRoot $repoRoot

Stop-ManagedProcess -PidPath $PidFile
Stop-PortListenerProcess -Port $serverPort
Stop-MatchingProcesses -ProcessName "node.exe" -Patterns @($repoRoot, "server.mjs")
Stop-MatchingProcesses -ProcessName "powershell.exe" -Patterns @($repoRoot, "deploy\start-server.ps1")
Stop-MatchingProcesses -ProcessName "cmd.exe" -Patterns @($repoRoot, "deploy\start-server.ps1")

$nodeCommand = Get-Command node -ErrorAction Stop
Normalize-ProcessEnvironmentPath
$serverProcess = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList "server.mjs" `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Milliseconds 700

if ($serverProcess.HasExited) {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  throw "Space Work server exited immediately. Check $stderrLog"
}

Set-Content -Path $PidFile -Value $serverProcess.Id -NoNewline

Write-Host "Space Work server restarted in managed mode."
Write-Host "PID: $($serverProcess.Id)"
Write-Host "STDOUT: $stdoutLog"
Write-Host "STDERR: $stderrLog"
