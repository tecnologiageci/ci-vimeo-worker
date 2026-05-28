param(
  [string]$WorkerName = "PC-LUIZ-HLS",
  [string]$DisplayName = "Luiz RTX",
  [string]$WorkerIp = "10.13.136.117",
  [string]$QueueStatus = "queued",
  [string]$QueueLabel = "uploads novos HLS",
  [int]$Concurrency = 1,
  [int]$PollMs = 15000,
  [switch]$Gpu,
  [switch]$Once
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $RepoRoot
$LogFile = Join-Path $LogDir "video-processing-$WorkerName.log"

$env:VIDEO_PROCESSING_WORKER_NAME = $WorkerName
$env:VIDEO_PROCESSING_WORKER_DISPLAY_NAME = $DisplayName
$env:VIDEO_PROCESSING_WORKER_IP = $WorkerIp
$env:VIDEO_PROCESSING_QUEUE_STATUS = $QueueStatus
$env:VIDEO_PROCESSING_QUEUE_LABEL = $QueueLabel
$env:VIDEO_PROCESSING_WORKER_CONCURRENCY = "$Concurrency"
$env:VIDEO_PROCESSING_WORKER_POLL_MS = "$PollMs"
$env:VIDEO_HLS_UPLOAD_CONCURRENCY = if ($env:VIDEO_HLS_UPLOAD_CONCURRENCY) { $env:VIDEO_HLS_UPLOAD_CONCURRENCY } else { "4" }
if ($Once) {
  $env:VIDEO_PROCESSING_WORKER_ONCE = "1"
}

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
Write-Host "Queue: $QueueStatus ($QueueLabel)"
Write-Host "Repo: $RepoRoot"
Write-Host "Concurrency: $Concurrency | Poll: $PollMs ms | Encoder: $env:VIDEO_HLS_ENCODER"

Start-Transcript -Path $LogFile -Append | Out-Null
try {
  npm run video:process-worker
  exit $LASTEXITCODE
} finally {
  Stop-Transcript | Out-Null
}
