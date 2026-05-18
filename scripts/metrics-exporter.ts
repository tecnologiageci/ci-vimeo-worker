import { config as loadEnv } from 'dotenv'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createSupabaseAdmin } from '@/lib/supabase/admin'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

const execFileAsync = promisify(execFile)
const port = Number(process.env.CI_VIMEO_METRICS_PORT || 9464)
const workerName = envText('CI_VIMEO_WORKER_NAME', process.env.COMPUTERNAME || os.hostname())
const machine = envText('CI_VIMEO_WORKER_METRICS_MACHINE', workerName.toLowerCase())
const statusFilePath = path.join(process.cwd(), 'data', 'worker-agent-status.json')

function envText(name: string, fallback = '') {
  const value = process.env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

function label(value: unknown) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')
}

function metric(name: string, labels: Record<string, unknown>, value: number) {
  const entries = Object.entries(labels)
    .filter(([, item]) => item != null && item !== '')
    .map(([key, item]) => `${key}="${label(item)}"`)
    .join(',')
  return `${name}{${entries}} ${Number.isFinite(value) ? value : 0}`
}

function readStatus() {
  try {
    if (!existsSync(statusFilePath)) return null
    return JSON.parse(readFileSync(statusFilePath, 'utf8'))
  } catch {
    return null
  }
}

async function getProcessCount(name: string) {
  try {
    if (os.platform() === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `@(Get-Process ${name} -ErrorAction SilentlyContinue).Count`,
      ], { timeout: 4000 })
      return Number(stdout.trim()) || 0
    }
    const { stdout } = await execFileAsync('pgrep', ['-fc', name], { timeout: 4000 })
    return Number(stdout.trim()) || 0
  } catch {
    return 0
  }
}

async function getGpuMetrics() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=utilization.gpu,utilization.encoder,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 })
    const first = stdout.trim().split(/\r?\n/)[0]
    const [gpu, encoder, memoryUsed, memoryTotal] = first.split(',').map((item) => Number(item.trim()))
    return { gpu, encoder, memoryUsed, memoryTotal }
  } catch {
    return { gpu: 0, encoder: 0, memoryUsed: 0, memoryTotal: 0 }
  }
}

async function getDbCounts(runName: string) {
  const db = createSupabaseAdmin()
  const counts: Record<string, number> = {}
  if (!db) return counts

  for (const status of ['draft', 'uploading', 'uploaded', 'processing', 'ready', 'failed']) {
    const { count } = await db
      .from('video_assets')
      .select('id', { count: 'exact', head: true })
      .eq('status', status)
    counts[status] = count || 0
  }
  return counts
}

async function renderMetrics() {
  const status = readStatus()
  const runName = status?.runName || process.env.VIMEO_MIGRATION_RUN_NAME || 'default'
  const baseLabels = { run: runName, worker: workerName, machine }
  const ffmpegCount = await getProcessCount('ffmpeg')
  const nodeCount = await getProcessCount('node')
  const gpu = await getGpuMetrics()
  const dbCounts = await getDbCounts(runName)
  const progress = Number(status?.progressPercent || 0)
  const isRunning = status?.status === 'running' ? 1 : 0
  const heartbeatAt = status?.heartbeatAt ? Math.floor(new Date(status.heartbeatAt).getTime() / 1000) : 0

  const lines = [
    '# HELP ci_migration_worker_info Worker information.',
    '# TYPE ci_migration_worker_info gauge',
    metric('ci_migration_worker_info', {
      ...baseLabels,
      hostname: os.hostname(),
      platform: os.platform(),
      status: status?.status || 'idle',
    }, 1),
    '# HELP ci_migration_worker_running Worker running flag.',
    '# TYPE ci_migration_worker_running gauge',
    metric('ci_migration_worker_running', baseLabels, isRunning),
    '# HELP ci_migration_worker_heartbeat_timestamp_seconds Last worker heartbeat timestamp.',
    '# TYPE ci_migration_worker_heartbeat_timestamp_seconds gauge',
    metric('ci_migration_worker_heartbeat_timestamp_seconds', baseLabels, heartbeatAt),
    '# HELP ci_migration_progress_percent Current migration progress reported by the worker.',
    '# TYPE ci_migration_progress_percent gauge',
    metric('ci_migration_progress_percent', baseLabels, progress),
    '# HELP ci_windows_ffmpeg_processes Local FFmpeg process count.',
    '# TYPE ci_windows_ffmpeg_processes gauge',
    metric('ci_windows_ffmpeg_processes', baseLabels, ffmpegCount),
    '# HELP ci_windows_node_processes Local Node process count.',
    '# TYPE ci_windows_node_processes gauge',
    metric('ci_windows_node_processes', baseLabels, nodeCount),
    '# HELP ci_gpu_utilization_percent NVIDIA GPU utilization.',
    '# TYPE ci_gpu_utilization_percent gauge',
    metric('ci_gpu_utilization_percent', baseLabels, gpu.gpu),
    '# HELP ci_gpu_encoder_utilization_percent NVIDIA encoder utilization.',
    '# TYPE ci_gpu_encoder_utilization_percent gauge',
    metric('ci_gpu_encoder_utilization_percent', baseLabels, gpu.encoder),
    '# HELP ci_gpu_memory_used_bytes NVIDIA GPU memory used.',
    '# TYPE ci_gpu_memory_used_bytes gauge',
    metric('ci_gpu_memory_used_bytes', baseLabels, gpu.memoryUsed * 1024 * 1024),
    '# HELP ci_gpu_memory_total_bytes NVIDIA GPU memory total.',
    '# TYPE ci_gpu_memory_total_bytes gauge',
    metric('ci_gpu_memory_total_bytes', baseLabels, gpu.memoryTotal * 1024 * 1024),
  ]

  for (const [statusName, count] of Object.entries(dbCounts)) {
    lines.push(metric('ci_migration_db_assets_total', { ...baseLabels, status: statusName }, count))
  }
  if (status?.lastError) {
    lines.push(metric('ci_migration_log_errors_total', baseLabels, status.status === 'error' ? 1 : 0))
  }

  return `${lines.join('\n')}\n`
}

http.createServer(async (request, response) => {
  if (request.url !== '/metrics') {
    response.writeHead(404)
    response.end('not found')
    return
  }

  try {
    const body = await renderMetrics()
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    response.end(body)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
}).listen(port, () => {
  console.log(`metrics exporter listening on :${port}`)
})
