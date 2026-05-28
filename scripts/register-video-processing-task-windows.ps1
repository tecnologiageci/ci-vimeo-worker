param(
  [string]$InstallPath = "C:\ci-vimeo-agent",
  [string]$TaskName = "CI Video Processing Luiz",
  [string]$WorkerName = "PC-LUIZ-HLS",
  [string]$DisplayName = "Luiz RTX",
  [string]$WorkerIp = "10.13.136.117",
  [string]$QueueName = "",
  [string]$QueueStatus = "queued",
  [string]$QueueLabel = "uploads novos HLS",
  [int]$Concurrency = 1,
  [int]$PollMs = 15000,
  [int]$HeartbeatMs = 15000,
  [int]$StaleMinutes = 45,
  [int]$JobStallMinutes = 90,
  [int]$RestartDelaySeconds = 20,
  [switch]$Gpu,
  [switch]$AutoPull
)

$ErrorActionPreference = "Stop"

$SupervisorScript = Join-Path $InstallPath "scripts\supervise-video-processing-worker-windows.ps1"
if (-not (Test-Path $SupervisorScript)) {
  throw "Script nao encontrado: $SupervisorScript"
}

$Arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$SupervisorScript`"",
  "-WorkerName", "`"$WorkerName`"",
  "-DisplayName", "`"$DisplayName`"",
  "-WorkerIp", "`"$WorkerIp`"",
  "-QueueName", "`"$QueueName`"",
  "-QueueStatus", "`"$QueueStatus`"",
  "-QueueLabel", "`"$QueueLabel`"",
  "-Concurrency", "$Concurrency",
  "-PollMs", "$PollMs",
  "-HeartbeatMs", "$HeartbeatMs",
  "-StaleMinutes", "$StaleMinutes",
  "-JobStallMinutes", "$JobStallMinutes",
  "-RestartDelaySeconds", "$RestartDelaySeconds"
)

if ($Gpu) {
  $Arguments += "-Gpu"
}

if ($AutoPull) {
  $Arguments += "-AutoPull"
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($Arguments -join " ") -WorkingDirectory $InstallPath
$Triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -AtStartup)
)
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
