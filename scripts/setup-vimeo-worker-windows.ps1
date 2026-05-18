param(
  [string]$InstallPath = "C:\ci-vimeo-runner",
  [string]$RepoUrl = "https://github.com/tecnologiageci/ci-vimeo-worker.git",
  [string]$Branch = "main",
  [string]$WorkerName = $env:COMPUTERNAME,
  [string]$EnvSource = "",
  [switch]$InstallZeroTier,
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

Write-Step "Verificando dependencias"
Ensure-Command -Name "git" -WingetId "Git.Git"
Ensure-Command -Name "node" -WingetId "OpenJS.NodeJS.LTS"
Ensure-Command -Name "ffmpeg" -WingetId "Gyan.FFmpeg"

if ($InstallZeroTier) {
  Ensure-Command -Name "zerotier-cli" -WingetId "ZeroTier.ZeroTierOne"
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
