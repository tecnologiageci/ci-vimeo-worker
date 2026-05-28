param(
  [string]$WorkerName = "PC-LUIZ-RTX",
  [string]$DisplayName = "Luiz RTX",
  [string]$WorkerIp = "10.13.136.117",
  [int]$Concurrency = 1,
  [int]$PollMs = 15000,
  [switch]$Gpu
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $RepoRoot

$env:VIDEO_PROCESSING_WORKER_NAME = $WorkerName
$env:VIDEO_PROCESSING_WORKER_DISPLAY_NAME = $DisplayName
$env:VIDEO_PROCESSING_WORKER_IP = $WorkerIp
$env:VIDEO_PROCESSING_WORKER_CONCURRENCY = "$Concurrency"
$env:VIDEO_PROCESSING_WORKER_POLL_MS = "$PollMs"
$env:VIDEO_HLS_UPLOAD_CONCURRENCY = if ($env:VIDEO_HLS_UPLOAD_CONCURRENCY) { $env:VIDEO_HLS_UPLOAD_CONCURRENCY } else { "4" }

if ($Gpu) {
  $env:VIDEO_HLS_ENCODER = "h264_nvenc"
  if (-not $env:VIDEO_HLS_NVENC_PRESET) {
    $env:VIDEO_HLS_NVENC_PRESET = "p4"
  }
  if (-not $env:VIDEO_HLS_NVENC_CQ) {
    $env:VIDEO_HLS_NVENC_CQ = "23"
  }
} elseif (-not $env:VIDEO_HLS_ENCODER) {
  $env:VIDEO_HLS_ENCODER = "libx264"
}

Write-Host "Worker: $WorkerName ($DisplayName)"
Write-Host "Repo: $RepoRoot"
Write-Host "Concurrency: $Concurrency | Poll: $PollMs ms | Encoder: $env:VIDEO_HLS_ENCODER"

npm run video:process-worker
