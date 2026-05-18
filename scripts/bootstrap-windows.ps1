param(
  [string]$InstallPath = "C:\ci-vimeo-runner",
  [string]$WorkerName = $env:COMPUTERNAME,
  [string]$RepoUrl = "https://github.com/tecnologiageci/ci-vimeo-worker.git",
  [string]$Branch = "main",
  [switch]$InstallZeroTier,
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

Write-Step "Instalando dependencias basicas"
Ensure-WingetPackage -CommandName "git" -PackageId "Git.Git"
Ensure-WingetPackage -CommandName "node" -PackageId "OpenJS.NodeJS.LTS"
Ensure-WingetPackage -CommandName "ffmpeg" -PackageId "Gyan.FFmpeg"

if ($InstallZeroTier) {
  Ensure-WingetPackage -CommandName "zerotier-cli" -PackageId "ZeroTier.ZeroTierOne"
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
