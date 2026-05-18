param(
  [string]$InstallPath = "C:\ci-vimeo-runner",
  [string]$WorkerName = $env:COMPUTERNAME,
  [string]$RepoUrl = "https://github.com/tecnologiageci/ci-vimeo-worker.git",
  [string]$Branch = "main",
  [string]$ZeroTierNetworkId = "3b19b3a716c84da5",
  [switch]$InstallZeroTier,
  [switch]$SkipZeroTier,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Ensure-WingetPackage {
  param(
    [string]$CommandName,
    [string]$PackageId
  )

  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    Write-Host "$CommandName OK"
    return
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget nao encontrado. Instale o App Installer da Microsoft Store ou instale $CommandName manualmente."
  }

  Write-Host "Instalando $CommandName..."
  winget install --id $PackageId --exact --accept-package-agreements --accept-source-agreements
  Refresh-Path
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
    Ensure-WingetPackage -CommandName "zerotier-cli" -PackageId "ZeroTier.ZeroTierOne"
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

Write-Step "Instalando dependencias basicas"
Ensure-WingetPackage -CommandName "git" -PackageId "Git.Git"
Ensure-WingetPackage -CommandName "node" -PackageId "OpenJS.NodeJS.LTS"
Ensure-WingetPackage -CommandName "ffmpeg" -PackageId "Gyan.FFmpeg"

if (-not $SkipZeroTier) {
  Ensure-ZeroTierNetwork -NetworkId $ZeroTierNetworkId
} elseif ($InstallZeroTier) {
  Ensure-ZeroTierNetwork -NetworkId $ZeroTierNetworkId
}

Refresh-Path

Write-Step "Baixando worker"
if (Test-Path $InstallPath) {
  if ($Force) {
    Remove-Item -LiteralPath $InstallPath -Recurse -Force
    git clone --branch $Branch $RepoUrl $InstallPath
  } elseif (Test-Path (Join-Path $InstallPath ".git")) {
    git -C $InstallPath fetch origin $Branch
    git -C $InstallPath checkout $Branch
    git -C $InstallPath pull --ff-only origin $Branch
  } else {
    throw "A pasta $InstallPath ja existe e nao e um repositorio git. Use -Force ou escolha outro -InstallPath."
  }
} else {
  git clone --branch $Branch $RepoUrl $InstallPath
}

Write-Step "Preparando runner"
powershell -ExecutionPolicy Bypass -File (Join-Path $InstallPath "scripts\setup-vimeo-worker-windows.ps1") `
  -InstallPath $InstallPath `
  -WorkerName $WorkerName `
  -SkipRepoUpdate `
  -SkipPackages

Write-Host ""
Write-Host "Pronto." -ForegroundColor Green
Write-Host "Teste seco:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-worker.ps1`" -Limit 1"
Write-Host ""
Write-Host "Rodar real com GPU:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-worker.ps1`" -Execute -Notify -Gpu"
Write-Host ""
Write-Host "Rodar real somente CPU:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallPath\start-vimeo-worker.ps1`" -Execute -Notify"
