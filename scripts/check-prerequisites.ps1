$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dshEntry = Join-Path $projectRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$doubaoApp = $env:DOUBAO_APP
if ([string]::IsNullOrWhiteSpace($doubaoApp)) {
  $runningDoubaos = @(Get-CimInstance Win32_Process -Filter "Name = 'Doubao.exe'" |
    Where-Object { $_.ExecutablePath })
  $listenerPids = @()
  try {
    $listenerPids = @(Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { }
  $runningDoubao = $runningDoubaos |
    Where-Object { $_.ProcessId -in $listenerPids } |
    Select-Object -First 1
  if (-not $runningDoubao) { $runningDoubao = $runningDoubaos | Select-Object -First 1 }
  if ($runningDoubao) { $doubaoApp = $runningDoubao.ExecutablePath }
}
$doubaoData = $env:DOUBAO_DATA_DIR
if ([string]::IsNullOrWhiteSpace($doubaoData)) {
  $doubaoData = Join-Path $env:LOCALAPPDATA 'Doubao\User Data'
}
$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
$ready = $true

function Write-Check([string]$name, [bool]$passed, [string]$detail) {
  $state = if ($passed) { 'READY' } else { 'WAIT' }
  Write-Output ('[{0}] {1}: {2}' -f $state, $name, $detail)
  if (-not $passed) { $script:ready = $false }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeDetail = if ($nodeCommand) { $nodeCommand.Source } else { 'node must be on PATH' }
Write-Check 'Node.js' ([bool]$nodeCommand) $nodeDetail

$dshReady = $false
$dshDetail = if (-not $nodeCommand) {
  'node is unavailable; cannot run the DSH CLI'
} elseif (-not (Test-Path -LiteralPath $dshEntry)) {
  'DSH CLI entrypoint is missing; run npm ci'
} else {
  'dsh --version failed to start'
}
if ($nodeCommand -and (Test-Path -LiteralPath $dshEntry)) {
  $process = $null
  try {
    $processStart = New-Object System.Diagnostics.ProcessStartInfo
    $processStart.FileName = $nodeCommand.Source
    $processStart.Arguments = '"' + $dshEntry + '" --version'
    $processStart.WorkingDirectory = $projectRoot
    $processStart.UseShellExecute = $false
    $processStart.CreateNoWindow = $true
    $processStart.RedirectStandardOutput = $true
    $processStart.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processStart
    if (-not $process.Start()) {
      $dshDetail = 'dsh --version failed to start'
    } else {
      $stdoutTask = $process.StandardOutput.ReadToEndAsync()
      $stderrTask = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(10000)) {
        try { $process.Kill() } catch { }
        $dshDetail = 'dsh --version timed out after 10 seconds'
      } elseif ($process.ExitCode -eq 0) {
        $dshReady = $true
        $dshDetail = $stdoutTask.Result.Trim()
        if ([string]::IsNullOrWhiteSpace($dshDetail)) { $dshDetail = $stderrTask.Result.Trim() }
        if ([string]::IsNullOrWhiteSpace($dshDetail)) { $dshDetail = 'dsh --version exited with code 0' }
      } else {
        $dshDetail = "dsh --version exited with code $($process.ExitCode)"
      }
    }
  } catch {
    $dshDetail = 'dsh --version failed to start'
  } finally {
    if ($process) { $process.Dispose() }
  }
}
Write-Check 'DSH CLI' $dshReady $dshDetail

$appPathDetail = if ($doubaoApp) { $doubaoApp } else { 'set DOUBAO_APP or start Doubao' }
Write-Check 'Doubao app' ([bool]($doubaoApp -and (Test-Path -LiteralPath $doubaoApp))) $appPathDetail
$dataPathSource = if ([string]::IsNullOrWhiteSpace($env:DOUBAO_DATA_DIR)) { 'default' } else { 'DOUBAO_DATA_DIR' }
$dataPathDetail = "$doubaoData ($dataPathSource)"
Write-Check 'Doubao user data' (Test-Path -LiteralPath $doubaoData) $dataPathDetail

$cdpReady = $false
$cdpDetail = 'port 9225 listener could not be verified'
try {
  $listeners = @(Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    $cdpDetail = 'no listener on 127.0.0.1:9225'
  } elseif (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -gt 0) {
    $cdpDetail = 'port 9225 has a non-loopback listener'
  } elseif (@($listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count -eq 0) {
    $cdpDetail = 'port 9225 has no IPv4 loopback listener'
  } elseif ([string]::IsNullOrWhiteSpace($doubaoApp)) {
    $cdpDetail = 'port 9225 listener cannot be tied to a Doubao.exe path'
  } else {
    $expectedDoubaoPath = [System.IO.Path]::GetFullPath($doubaoApp)
    $doubaoProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Doubao.exe'" |
      Where-Object {
        $_.ExecutablePath -and
        [string]::Equals(
          [System.IO.Path]::GetFullPath($_.ExecutablePath),
          $expectedDoubaoPath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      })
    $doubaoPids = @($doubaoProcesses | ForEach-Object { [int]$_.ProcessId })
    $foreignListeners = @($listeners | Where-Object { $_.OwningProcess -notin $doubaoPids })
    if ($foreignListeners.Count -gt 0) {
      $cdpDetail = 'port 9225 is not owned by Doubao.exe'
    } else {
      $version = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/json/version' -TimeoutSec 2
      $webSocketUri = [Uri]$version.webSocketDebuggerUrl
      $localHosts = @('localhost', '127.0.0.1', '::1')
      if (($webSocketUri.Scheme -eq 'ws') -and
          ($webSocketUri.Port -eq 9225) -and
          ($webSocketUri.Host -in $localHosts)) {
        $cdpReady = $true
        $browser = if ($version.Browser) { $version.Browser } else { 'browser version not reported' }
        $cdpDetail = "Doubao.exe owns a loopback CDP listener ($browser)"
      } else {
        $cdpDetail = 'port 9225 did not return a local CDP WebSocket endpoint'
      }
    }
  }
} catch {
  $cdpDetail = 'listener or CDP endpoint could not be verified'
}
Write-Check 'Doubao CDP' $cdpReady $cdpDetail

function Test-McpServerEnabled([string]$text, [string]$serverName) {
  $targetSection = "mcp_servers.$serverName"
  $inTargetSection = $false
  $sectionFound = $false
  $enabled = $true
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
      $inTargetSection = ($Matches[1] -eq $targetSection)
      if ($inTargetSection) { $sectionFound = $true }
      continue
    }
    if ($inTargetSection -and $line -match '^\s*enabled\s*=') {
      $enabled = ($line -match '^\s*enabled\s*=\s*true\s*(?:#.*)?$')
      break
    }
  }
  return ($sectionFound -and $enabled)
}

$configText = if (Test-Path -LiteralPath $codexConfig) { Get-Content -LiteralPath $codexConfig -Raw } else { '' }
$hasDsh = Test-McpServerEnabled $configText 'deepseek_harness'
$hasDoubao = Test-McpServerEnabled $configText 'doubao_desktop'
Write-Check 'Codex DSH MCP' $hasDsh 'deepseek_harness entry exists and is enabled'
Write-Check 'Codex Doubao MCP' $hasDoubao 'doubao_desktop entry exists and is enabled'

if (-not $ready) { exit 2 }
