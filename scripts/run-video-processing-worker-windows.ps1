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
$env:VIDEO_PROCESSING_QUEUE_NAME = if ($QueueName) { $QueueName } elseif ($QueueStatus -eq "queued_legacy") { "legacy" } else { "uploads" }
$env:VIDEO_PROCESSING_QUEUE_STATUS = $QueueStatus
$env:VIDEO_PROCESSING_QUEUE_LABEL = $QueueLabel
$env:VIDEO_PROCESSING_WORKER_CONCURRENCY = "$Concurrency"
$env:VIDEO_PROCESSING_WORKER_POLL_MS = "$PollMs"
$env:VIDEO_PROCESSING_HEARTBEAT_MS = "$HeartbeatMs"
$env:VIDEO_PROCESSING_STALE_MINUTES = "$StaleMinutes"
$env:VIDEO_PROCESSING_JOB_STALL_MINUTES = "$JobStallMinutes"
$env:VIDEO_PROCESSING_REQUEUE_STALE = "1"
$env:VIDEO_HLS_UPLOAD_CONCURRENCY = if ($env:VIDEO_HLS_UPLOAD_CONCURRENCY) { $env:VIDEO_HLS_UPLOAD_CONCURRENCY } else { "4" }
$env:VIDEO_CAPTIONS_ENABLED = if ($env:VIDEO_CAPTIONS_ENABLED) {
  $env:VIDEO_CAPTIONS_ENABLED
} else {
  "0"
}
$DefaultCaptionsPython = Join-Path $RepoRoot ".venv-captions\Scripts\python.exe"
if (-not $env:VIDEO_CAPTIONS_PYTHON -and (Test-Path $DefaultCaptionsPython)) {
  $env:VIDEO_CAPTIONS_PYTHON = $DefaultCaptionsPython
}
$env:VIDEO_CAPTIONS_SCRIPT = if ($env:VIDEO_CAPTIONS_SCRIPT) { $env:VIDEO_CAPTIONS_SCRIPT } else { Join-Path $RepoRoot "scripts\generate-video-captions.py" }
$env:VIDEO_CAPTIONS_MODEL = if ($env:VIDEO_CAPTIONS_MODEL) { $env:VIDEO_CAPTIONS_MODEL } else { "large-v3" }
$env:VIDEO_CAPTIONS_DEVICE = if ($Gpu) { "cuda" } elseif ($env:VIDEO_CAPTIONS_DEVICE) { $env:VIDEO_CAPTIONS_DEVICE } else { "auto" }
$env:VIDEO_CAPTIONS_COMPUTE_TYPE = if ($env:VIDEO_CAPTIONS_COMPUTE_TYPE) { $env:VIDEO_CAPTIONS_COMPUTE_TYPE } else { "float16" }
$env:VIDEO_CAPTIONS_TRANSCRIPTION_BATCH_SIZE = if ($env:VIDEO_CAPTIONS_TRANSCRIPTION_BATCH_SIZE) { $env:VIDEO_CAPTIONS_TRANSCRIPTION_BATCH_SIZE } else { "16" }
$env:VIDEO_CAPTIONS_VAD_FILTER = if ($env:VIDEO_CAPTIONS_VAD_FILTER) { $env:VIDEO_CAPTIONS_VAD_FILTER } else { "0" }
$env:VIDEO_CAPTIONS_TRANSLATE = if ($env:VIDEO_CAPTIONS_TRANSLATE) { $env:VIDEO_CAPTIONS_TRANSLATE } else { "1" }
$env:VIDEO_CAPTIONS_TRANSLATION_DEVICE = if ($env:VIDEO_CAPTIONS_TRANSLATION_DEVICE) { $env:VIDEO_CAPTIONS_TRANSLATION_DEVICE } else { "cpu" }
$env:VIDEO_CAPTIONS_PT_EN_MODEL = if ($env:VIDEO_CAPTIONS_PT_EN_MODEL) { $env:VIDEO_CAPTIONS_PT_EN_MODEL } else { "Helsinki-NLP/opus-mt-mul-en" }
$env:VIDEO_CAPTIONS_EN_ES_MODEL = if ($env:VIDEO_CAPTIONS_EN_ES_MODEL) { $env:VIDEO_CAPTIONS_EN_ES_MODEL } else { "Helsinki-NLP/opus-mt-en-es" }
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
Write-Host "Queue: $env:VIDEO_PROCESSING_QUEUE_NAME / $QueueStatus ($QueueLabel)"
Write-Host "Repo: $RepoRoot"
Write-Host "Concurrency: $Concurrency | Poll: $PollMs ms | Heartbeat: $HeartbeatMs ms | Stale: $StaleMinutes min | Stall: $JobStallMinutes min | Encoder: $env:VIDEO_HLS_ENCODER | Captions: $env:VIDEO_CAPTIONS_ENABLED | CaptionDevice: $env:VIDEO_CAPTIONS_DEVICE | CaptionCompute: $env:VIDEO_CAPTIONS_COMPUTE_TYPE"

Start-Transcript -Path $LogFile -Append | Out-Null
try {
  & npm.cmd run video:process-worker
  exit $LASTEXITCODE
} finally {
  Stop-Transcript | Out-Null
}
