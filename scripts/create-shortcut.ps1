param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$icon = Join-Path $projectRoot 'assets\agent-team.ico'
$launcher = Join-Path $projectRoot 'scripts\start-agent-team.ps1'
$destinations = @(Join-Path $projectRoot 'Agent Team.lnk')
if ($Desktop) { $destinations += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Team.lnk' }
$shell = New-Object -ComObject WScript.Shell
foreach ($destination in $destinations) {
  $shortcut = $shell.CreateShortcut($destination)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launcher
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'Agent Team 本机协作工作台'
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  Write-Output "Created: $destination"
}
