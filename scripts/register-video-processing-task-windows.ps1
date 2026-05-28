param(
  [string]$InstallPath = "C:\ci-vimeo-agent",
  [string]$TaskName = "CI Video Processing Luiz",
  [string]$WorkerName = "PC-LUIZ-RTX",
  [string]$DisplayName = "Luiz RTX",
  [string]$WorkerIp = "10.13.136.117",
  [int]$Concurrency = 1,
  [int]$PollMs = 15000,
  [switch]$Gpu
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $InstallPath "scripts\run-video-processing-worker-windows.ps1"
if (-not (Test-Path $RunScript)) {
  throw "Script nao encontrado: $RunScript"
}

$Arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$RunScript`"",
  "-WorkerName", "`"$WorkerName`"",
  "-DisplayName", "`"$DisplayName`"",
  "-WorkerIp", "`"$WorkerIp`"",
  "-Concurrency", "$Concurrency",
  "-PollMs", "$PollMs"
)

if ($Gpu) {
  $Arguments += "-Gpu"
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($Arguments -join " ") -WorkingDirectory $InstallPath
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
