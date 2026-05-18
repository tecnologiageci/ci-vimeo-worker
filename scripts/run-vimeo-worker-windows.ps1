param(
  [string]$WorkerName = $env:COMPUTERNAME,
  [string]$FolderUri = "",
  [int]$Limit = 0,
  [int]$VideoConcurrency = 4,
  [int]$HlsConcurrency = 1,
  [int]$UploadConcurrency = 2,
  [int]$HlsBacklogLimit = 8,
  [switch]$Execute,
  [switch]$Notify,
  [switch]$Gpu,
  [switch]$RefreshQueue
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

if (-not (Test-Path ".env.local")) {
  throw "Arquivo .env.local nao encontrado em $repoRoot. Copie as credenciais antes de rodar."
}

$env:VIMEO_MIGRATION_EXECUTE = if ($Execute) { "1" } else { "0" }
$env:VIMEO_MIGRATION_PROCESS = "1"
$env:VIMEO_MIGRATION_TRANSFER_MODE = "local-file"
$env:VIMEO_MIGRATION_QUEUE_CACHE = "1"
$env:VIMEO_MIGRATION_REFRESH_QUEUE = if ($RefreshQueue) { "1" } else { "0" }
$env:VIMEO_MIGRATION_SKIP_SUBFOLDER_DISCOVERY = "1"
$env:VIMEO_MIGRATION_INCLUDE_ROOT = "0"
$env:VIMEO_MIGRATION_PIPELINE_HLS = "1"
$env:VIMEO_MIGRATION_HLS_BACKLOG_LIMIT = "$HlsBacklogLimit"
$env:VIMEO_MIGRATION_VIDEO_CONCURRENCY = "$VideoConcurrency"
$env:VIMEO_MIGRATION_HLS_CONCURRENCY = "$HlsConcurrency"
$env:VIDEO_HLS_UPLOAD_CONCURRENCY = "$UploadConcurrency"
$env:VIMEO_MIGRATION_NOTIFY = if ($Notify) { "1" } else { "0" }
$env:VIMEO_MIGRATION_NOTIFY_NAME = $WorkerName
$env:CI_VIMEO_WORKER_NAME = $WorkerName

if ($FolderUri) {
  $env:VIMEO_MIGRATION_FOLDER_URI = $FolderUri
}

if ($Limit -gt 0) {
  $env:VIMEO_MIGRATION_LIMIT = "$Limit"
}

if ($Gpu) {
  $env:VIDEO_HLS_ENCODER = "h264_nvenc"
  if (-not $env:VIDEO_HLS_NVENC_PRESET) {
    $env:VIDEO_HLS_NVENC_PRESET = "p4"
  }
  if (-not $env:VIDEO_HLS_NVENC_CQ) {
    $env:VIDEO_HLS_NVENC_CQ = "23"
  }
} else {
  $env:VIDEO_HLS_ENCODER = "libx264"
  if (-not $env:VIDEO_HLS_X264_PRESET) {
    $env:VIDEO_HLS_X264_PRESET = "veryfast"
  }
  if (-not $env:VIDEO_HLS_X264_CRF) {
    $env:VIDEO_HLS_X264_CRF = "23"
  }
}

Write-Host "Worker: $WorkerName" -ForegroundColor Cyan
Write-Host "Modo: $(if ($Execute) { 'REAL' } else { 'DRY-RUN' })"
Write-Host "Videos: $VideoConcurrency | HLS: $HlsConcurrency | Upload HLS: $UploadConcurrency | Encoder: $env:VIDEO_HLS_ENCODER"
Write-Host ""

npm run video:migrate-vimeo
