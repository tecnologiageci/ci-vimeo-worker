param(
  [string]$InstallPath = "C:\ci-vimeo-runner",
  [string]$RepoUrl = "https://github.com/tecnologiageci/ci-vimeo-worker.git",
  [string]$Branch = "main",
  [string]$WorkerName = $env:COMPUTERNAME,
  [string]$EnvSource = "",
  [string]$ZeroTierNetworkId = "3b19b3a716c84da5",
  [switch]$InstallZeroTier,
  [switch]$SkipZeroTier,
  [switch]$SkipRepoUpdate,
  [switch]$SkipPackages,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-Command {
  param(
    [string]$Name,
    [string]$WingetId
  )

  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    Write-Host "$Name OK"
    return
  }

  if ($SkipPackages) {
    throw "$Name nao encontrado. Rode sem -SkipPackages ou instale manualmente."
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget nao encontrado. Instale $Name manualmente ou atualize o Windows App Installer."
  }

  Write-Host "Instalando $Name via winget..."
  winget install --id $WingetId --exact --accept-package-agreements --accept-source-agreements
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Get-ZeroTierCli {
  $cmd = Get-Command zerotier-cli -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $default = "C:\Program Files (x86)\ZeroTier\One\zerotier-cli.bat"
  if (Test-Path $default) {
    return $default
  }

  return ""
}

function Ensure-ZeroTierNetwork {
  param([string]$NetworkId)

  if (-not $NetworkId) {
    return
  }

  Write-Step "Configurando ZeroTier"
  $ztCli = Get-ZeroTierCli
  if (-not $ztCli) {
    Ensure-Command -Name "zerotier-cli" -WingetId "ZeroTier.ZeroTierOne"
    Refresh-Path
    $ztCli = Get-ZeroTierCli
  }

  if (-not $ztCli) {
    throw "ZeroTier instalado, mas zerotier-cli nao foi encontrado. Feche e abra o PowerShell ou reinicie o PC."
  }

  $service = Get-Service -Name "ZeroTierOneService" -ErrorAction SilentlyContinue
  if ($service) {
    Set-Service -Name "ZeroTierOneService" -StartupType Automatic
    if ($service.Status -ne "Running") {
      Start-Service -Name "ZeroTierOneService"
      Start-Sleep -Seconds 3
    }
  }

  & $ztCli join $NetworkId | ForEach-Object { Write-Host $_ }
  Start-Sleep -Seconds 2
  & $ztCli listnetworks | ForEach-Object { Write-Host $_ }
}

Write-Step "Verificando dependencias"
Ensure-Command -Name "git" -WingetId "Git.Git"
Ensure-Command -Name "node" -WingetId "OpenJS.NodeJS.LTS"
Ensure-Command -Name "ffmpeg" -WingetId "Gyan.FFmpeg"

if ($InstallZeroTier -and -not $SkipZeroTier) {
  Ensure-ZeroTierNetwork -NetworkId $ZeroTierNetworkId
}

Refresh-Path

Write-Step "Preparando pasta $InstallPath"
if (Test-Path $InstallPath) {
  $hasGit = Test-Path (Join-Path $InstallPath ".git")
  $hasFiles = (Get-ChildItem -LiteralPath $InstallPath -Force | Select-Object -First 1) -ne $null

  if ($hasGit) {
    if ($SkipRepoUpdate) {
      Write-Host "Repositorio ja existe. Pulando atualizacao por -SkipRepoUpdate."
    } else {
      Write-Host "Repositorio ja existe. Atualizando..."
      git -C $InstallPath fetch origin $Branch
      git -C $InstallPath checkout $Branch
      git -C $InstallPath pull --ff-only origin $Branch
    }
  } elseif ($hasFiles -and -not $Force) {
    throw "A pasta ja existe e nao e um repositorio git. Use -Force ou escolha outro -InstallPath."
  } else {
    if ($Force) {
      Remove-Item -LiteralPath $InstallPath -Recurse -Force
    }
    git clone --branch $Branch $RepoUrl $InstallPath
  }
} else {
  git clone --branch $Branch $RepoUrl $InstallPath
}

Write-Step "Instalando pacotes Node"
Push-Location $InstallPath
if (Test-Path "package-lock.json") {
  npm ci
} else {
  npm install
}
Pop-Location

if ($EnvSource) {
  Write-Step "Copiando arquivo de ambiente"
  if (-not (Test-Path $EnvSource)) {
    throw "EnvSource nao encontrado: $EnvSource"
  }
  Copy-Item -LiteralPath $EnvSource -Destination (Join-Path $InstallPath ".env.local") -Force
} elseif (-not (Test-Path (Join-Path $InstallPath ".env.local"))) {
  Write-Host ""
  Write-Host "ATENCAO: coloque as credenciais em $InstallPath\.env.local antes de rodar migracao real." -ForegroundColor Yellow
}

Write-Step "Criando atalho de execucao"
$shortcutPath = Join-Path $InstallPath "start-vimeo-worker.ps1"
$runnerPath = Join-Path $InstallPath "scripts\run-vimeo-worker-windows.ps1"
$shortcut = @"
param(
  [string]`$FolderUri = "",
  [int]`$Limit = 0,
  [switch]`$Execute,
  [switch]`$Notify,
  [switch]`$Gpu
)

& "$runnerPath" -WorkerName "$WorkerName" -FolderUri `$FolderUri -Limit `$Limit -Execute:`$Execute -Notify:`$Notify -Gpu:`$Gpu
"@
$shortcut | Set-Content -LiteralPath $shortcutPath -Encoding UTF8

Write-Step "Criando agent de controle"
$agentPath = Join-Path $InstallPath "start-vimeo-agent.ps1"
$agent = @"
`$ErrorActionPreference = "Stop"
Set-Location "$InstallPath"
`$env:CI_VIMEO_WORKER_NAME = "$WorkerName"
npm run agent
"@
$agent | Set-Content -LiteralPath $agentPath -Encoding UTF8

$metricsPath = Join-Path $InstallPath "start-vimeo-metrics.ps1"
$metrics = @"
`$ErrorActionPreference = "Stop"
Set-Location "$InstallPath"
`$env:CI_VIMEO_WORKER_NAME = "$WorkerName"
`$env:CI_VIMEO_WORKER_METRICS_MACHINE = "$($WorkerName.ToLower())"
npm run metrics
"@
$metrics | Set-Content -LiteralPath $metricsPath -Encoding UTF8

try {
  $existingRule = Get-NetFirewallRule -DisplayName "CI Vimeo Metrics" -ErrorAction SilentlyContinue
  if (-not $existingRule) {
    New-NetFirewallRule -Name "CI_Vimeo_Metrics" -DisplayName "CI Vimeo Metrics" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 9464 | Out-Null
    Write-Host "Firewall liberado: porta 9464"
  } else {
    Write-Host "Firewall OK: porta 9464"
  }
} catch {
  Write-Host "Nao consegui criar regra de firewall para 9464: $($_.Exception.Message)" -ForegroundColor Yellow
}

$taskName = "CI_Vimeo_Worker_Agent"
try {
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$agentPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "Agent CI Vimeo Worker" -Force | Out-Null
  Write-Host "Tarefa agendada criada: $taskName"
  if (Test-Path (Join-Path $InstallPath ".env.local")) {
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Agent iniciado."
  } else {
    Write-Host "Agent criado, mas nao iniciado porque .env.local ainda nao existe." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Nao consegui criar/iniciar a tarefa do agent: $($_.Exception.Message)" -ForegroundColor Yellow
}

$metricsTaskName = "CI_Vimeo_Worker_Metrics"
try {
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$metricsPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $metricsTaskName -Action $action -Trigger $trigger -Principal $principal -Description "Metrics CI Vimeo Worker" -Force | Out-Null
  Write-Host "Tarefa agendada criada: $metricsTaskName"
  if (Test-Path (Join-Path $InstallPath ".env.local")) {
    Start-ScheduledTask -TaskName $metricsTaskName
    Write-Host "Metrics exporter iniciado."
  } else {
    Write-Host "Metrics exporter criado, mas nao iniciado porque .env.local ainda nao existe." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Nao consegui criar/iniciar a tarefa de metricas: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Step "Teste rapido"
Push-Location $InstallPath
node -v
ffmpeg -version | Select-Object -First 1
Pop-Location

Write-Host ""
Write-Host "Worker preparado: $WorkerName" -ForegroundColor Green
Write-Host "Pasta: $InstallPath"
Write-Host ""
Write-Host "Teste seco:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-worker.ps1`" -Limit 1"
Write-Host ""
Write-Host "Rodar real:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-worker.ps1`" -Execute -Notify"
Write-Host ""
Write-Host "Iniciar agent do painel:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-agent.ps1`""
Write-Host ""
Write-Host "Iniciar metricas Grafana:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-metrics.ps1`""
