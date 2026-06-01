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

function Get-DescendantProcessIds {
  param([int[]]$ParentIds)

  $allProcesses = Get-CimInstance Win32_Process
  $pending = @($ParentIds)
  $descendants = @()

  while ($pending.Count -gt 0) {
    $parentId = $pending[0]
    if ($pending.Count -gt 1) {
      $pending = $pending[1..($pending.Count - 1)]
    } else {
      $pending = @()
    }

    $children = @($allProcesses | Where-Object { $_.ParentProcessId -eq $parentId })
    foreach ($child in $children) {
      $descendants += [int]$child.ProcessId
      $pending += [int]$child.ProcessId
    }
  }

  return $descendants
}

function Stop-ProcessTree {
  param([int[]]$RootIds)

  $ids = @()
  foreach ($rootId in $RootIds) {
    $ids += Get-DescendantProcessIds -ParentIds @($rootId)
    $ids += $rootId
  }

  $ids = @($ids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique -Descending)
  foreach ($id in $ids) {
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      Write-SupervisorLog "Processo antigo encerrado: $id"
    } catch {
      Write-SupervisorLog "Nao consegui encerrar processo $id: $($_.Exception.Message)"
    }
  }
}

function Stop-ExistingWorkerProcesses {
  $workerNamePattern = '(?i)-WorkerName\s+"?' + [regex]::Escape($WorkerName) + '"?(?:\s|$)'
  $roots = @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.ProcessId -ne $PID `
          -and $_.CommandLine `
          -and $_.CommandLine -match $workerNamePattern `
          -and (
            $_.CommandLine -like "*supervise-video-processing-worker-windows.ps1*" `
              -or $_.CommandLine -like "*run-video-processing-worker-windows.ps1*"
          )
      } |
      Select-Object -ExpandProperty ProcessId
  )

  if ($roots.Count -gt 0) {
    Write-SupervisorLog "Encerrando processos antigos de $WorkerName antes de iniciar: $($roots -join ', ')"
    Stop-ProcessTree -RootIds $roots
  }
}

if (-not (Test-Path $RunScript)) {
  Write-SupervisorLog "Script nao encontrado: $RunScript"
  exit 1
}

Set-Location $RepoRoot
Write-SupervisorLog "Supervisor iniciado para $WorkerName em $RepoRoot"
Stop-ExistingWorkerProcesses

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
