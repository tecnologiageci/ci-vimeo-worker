param(
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

$ErrorActionPreference = "Continue"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$SupervisorLog = Join-Path $LogDir "video-processing-supervisor-$WorkerName.log"
$RunScript = Join-Path $RepoRoot "scripts\run-video-processing-worker-windows.ps1"

function Write-SupervisorLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
  Add-Content -Path $SupervisorLog -Value $line
  Write-Host $line
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + $Value.Replace('"', '\"') + '"'
}

if (-not (Test-Path $RunScript)) {
  Write-SupervisorLog "Script nao encontrado: $RunScript"
  exit 1
}

Set-Location $RepoRoot
Write-SupervisorLog "Supervisor iniciado para $WorkerName em $RepoRoot"

while ($true) {
  if ($AutoPull) {
    try {
      Write-SupervisorLog "Atualizando repo antes de iniciar worker."
      git fetch origin main | Out-Null
      git merge --ff-only origin/main | Out-Null
    } catch {
      Write-SupervisorLog "Nao consegui atualizar repo: $($_.Exception.Message)"
    }
  }

  $workerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $RunScript,
    "-WorkerName", $WorkerName,
    "-DisplayName", $DisplayName,
    "-WorkerIp", $WorkerIp,
    "-QueueName", $QueueName,
    "-QueueStatus", $QueueStatus,
    "-QueueLabel", $QueueLabel,
    "-Concurrency", "$Concurrency",
    "-PollMs", "$PollMs",
    "-HeartbeatMs", "$HeartbeatMs",
    "-StaleMinutes", "$StaleMinutes",
    "-JobStallMinutes", "$JobStallMinutes"
  )

  if ($Gpu) {
    $workerArgs += "-Gpu"
  }

  Write-SupervisorLog "Iniciando worker: $WorkerName / $QueueName / $QueueStatus"
  $argumentLine = ($workerArgs | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  $child = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -Wait
  $exitCode = if ($child.ExitCode -ne $null) { $child.ExitCode } else { 0 }
  Write-SupervisorLog "Worker saiu com codigo $exitCode. Reiniciando em $RestartDelaySeconds segundos."
  Start-Sleep -Seconds $RestartDelaySeconds
}
