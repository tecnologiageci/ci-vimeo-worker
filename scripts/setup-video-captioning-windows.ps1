param(
  [string]$InstallPath = "C:\ci-vimeo-agent",
  [switch]$DownloadModels
)

$ErrorActionPreference = "Stop"

function Ensure-Command {
  param(
    [string]$Name,
    [string]$WingetId
  )

  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    return
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Comando '$Name' nao encontrado e winget nao esta instalado."
  }

  winget install --id $WingetId --silent --accept-package-agreements --accept-source-agreements
}

function Invoke-BasePython {
  param([string[]]$Arguments)

  if (Get-Command python -ErrorAction SilentlyContinue) {
    & python @Arguments
    return
  }

  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.11 @Arguments
    return
  }

  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    "C:\Program Files\Python311\python.exe",
    "C:\Python311\python.exe"
  )

  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) {
      & $Candidate @Arguments
      return
    }
  }

  throw "Python 3.11 nao encontrado apos instalacao."
}

$RepoRoot = $InstallPath
$Requirements = Join-Path $RepoRoot "requirements-video-captions.txt"
$Venv = Join-Path $RepoRoot ".venv-captions"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Requirements)) {
  throw "Arquivo nao encontrado: $Requirements"
}

Ensure-Command -Name "python" -WingetId "Python.Python.3.11"

Set-Location $RepoRoot
if (-not (Test-Path $Python)) {
  Invoke-BasePython -Arguments @("-m", "venv", $Venv)
}

& $Python -m pip install --upgrade pip setuptools wheel
& $Python -m pip install -r $Requirements

if ($DownloadModels) {
  $Script = Join-Path $RepoRoot "scripts\generate-video-captions.py"
  $WarmupDir = Join-Path $RepoRoot "models\caption-warmup"
  New-Item -ItemType Directory -Force -Path $WarmupDir | Out-Null
  & $Python $Script --warmup --output-dir $WarmupDir --result-json (Join-Path $WarmupDir "warmup.json")
}

Write-Output "Captioning pronto."
& $Python --version
& $Python -c "import faster_whisper, transformers, torch; print('faster-whisper/transformers ok'); print('torch cuda:', torch.cuda.is_available())"
