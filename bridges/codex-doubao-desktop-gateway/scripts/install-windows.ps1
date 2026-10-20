$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = Join-Path $repoRoot 'deps\doubao-cli'
$patch = Join-Path $repoRoot 'patches\doubao-cli-windows.patch'
if (-not (Test-Path -LiteralPath $destination)) {
  git clone https://github.com/Fullstop000/doubao-cli.git $destination
  if ($LASTEXITCODE -ne 0) { throw 'Unable to clone doubao-cli.' }
}
Push-Location $destination
try {
  git checkout --detach b790ea2d127922902f7dc461b4169c28a2438f26
  if ($LASTEXITCODE -ne 0) { throw 'Unable to check out pinned doubao-cli commit.' }
  git apply --reverse --check $patch 2>$null
  if ($LASTEXITCODE -ne 0) {
    git apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'Windows patch does not apply cleanly.' }
    git apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply Windows patch.' }
  }
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install doubao-cli dependencies.' }
} finally { Pop-Location }
Write-Output "Patched doubao-cli installed at $destination"
