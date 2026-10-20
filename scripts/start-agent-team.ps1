param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 4174
$baseUrl = "http://127.0.0.1:$port"
$serverPath = Join-Path $projectRoot 'server\index.mjs'
$distIndex = Join-Path $projectRoot 'dist\index.html'
$dataDir = Join-Path $projectRoot 'data'

function Test-TeamApi {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "$baseUrl/api/health"
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-TeamApi {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    if (Test-TeamApi) { return }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  throw "Agent Team did not start within 20 seconds. See $dataDir\agent-team-api.error.log"
}

if (-not (Test-Path $serverPath)) {
  throw "Agent Team server was not found: $serverPath"
}

if (-not (Test-Path $distIndex)) {
  $npm = Get-Command npm.cmd -ErrorAction Stop
  Push-Location $projectRoot
  try {
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw 'Agent Team web build failed.' }
  } finally {
    Pop-Location
  }
}

if (-not (Test-TeamApi)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $dataDir 'agent-team-api.log'
  $stderr = Join-Path $dataDir 'agent-team-api.error.log'
  $env:TEAM_PORT = "$port"
  Start-Process -FilePath $node -ArgumentList @($serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  Wait-TeamApi
}

if (-not $NoBrowser) {
  Start-Process $baseUrl
}

Write-Output "Agent Team is ready: $baseUrl"
