import { config as loadEnv } from 'dotenv'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

type WorkerCommand = {
  id: string
  command: 'start' | 'stop' | 'pause' | 'resume' | 'update_config'
  payload?: Record<string, any>
}

type CommandResult = {
  id: string
  status: 'completed' | 'failed'
  error?: string
}

type QueueJob = {
  id: string
  title: string
  source_payload: Record<string, any>
}

type TaskResult = {
  id: string
  status: 'completed' | 'failed' | 'released'
  error?: string
}

type AgentState = {
  status: 'idle' | 'running' | 'paused' | 'stopping' | 'error'
  runName: string | null
  currentVideo: string | null
  currentStage: string | null
  progressPercent: number
  lastError: string | null
  paused: boolean
  queueMode: boolean
}

type CpuSnapshot = {
  idle: number
  total: number
}

type SystemMetrics = {
  cpuPercent: number | null
  memoryPercent: number
  memoryUsedGb: number
  memoryTotalGb: number
  gpu: {
    gpuPercent: number
    encoderPercent: number | null
    memoryPercent: number | null
    memoryUsedMb: number | null
    memoryTotalMb: number | null
    tempC: number | null
  } | null
  collectedAt: string
}

const workerName = envText('CI_VIMEO_WORKER_NAME', process.env.COMPUTERNAME || os.hostname())
const displayName = envText('CI_VIMEO_WORKER_DISPLAY_NAME', workerName)
const hubUrl = envText(
  'HUB_WORKER_CONTROL_URL',
  envText('NEXT_PUBLIC_APP_URL', envText('APP_URL', envText('HUB_URL', 'https://hub.conhecimentointegrado.com.br'))),
).replace(/\/$/, '')
const workerSecret = envText('VIDEO_WORKER_CONTROL_SECRET', envText('CRON_SECRET', ''))
const pollMs = envNumber('CI_VIMEO_AGENT_POLL_MS', 10_000)
const machineType = envText('CI_VIMEO_WORKER_TYPE', inferMachineType())
const logDir = path.join(process.cwd(), 'logs')
const agentLogPath = path.join(logDir, `agent-${sanitizeFileName(workerName)}.log`)
const dataDir = path.join(process.cwd(), 'data')
const statusFilePath = path.join(dataDir, 'worker-agent-status.json')

mkdirSync(logDir, { recursive: true })
mkdirSync(dataDir, { recursive: true })
const agentLog = createWriteStream(agentLogPath, { flags: 'a' })

let child: ChildProcessWithoutNullStreams | null = null
let childPid: number | null = null
let pendingResults: CommandResult[] = []
let pendingTaskResults: TaskResult[] = []
let activeTaskIds: string[] = []
let queueConfig: Record<string, any> = {}
let lastCpuSnapshot: CpuSnapshot | null = null
let gpuMetricsCache: { at: number; value: SystemMetrics['gpu'] } = { at: 0, value: null }
const state: AgentState = {
  status: 'idle',
  runName: null,
  currentVideo: null,
  currentStage: null,
  progressPercent: 0,
  lastError: null,
  paused: false,
  queueMode: false,
}

function envText(name: string, fallback = '') {
  const value = process.env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name] || '')
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function inferMachineType() {
  const name = `${process.env.COMPUTERNAME || ''} ${os.hostname()}`.toLowerCase()
  if (name.includes('rtx')) return 'rtx'
  if (name.includes('gtx')) return 'gtx'
  return os.platform() === 'win32' ? 'windows' : 'linux'
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'worker'
}

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  agentLog.write(`${line}\n`)
}

function parseOutputLine(line: string) {
  const clean = line.trim()
  if (!clean) return

  const copyMatch = clean.match(/^\[copy\]\s+(.+?)\s+->\s+(.+)$/)
  if (copyMatch) {
    state.currentStage = 'download/upload R2'
    state.currentVideo = copyMatch[2]
    state.progressPercent = Math.max(state.progressPercent, 5)
    return
  }

  const hlsMatch = clean.match(/^\[hls\]\s+(convertendo|processando duplicado ja copiado):\s+(.+)$/)
  if (hlsMatch) {
    state.currentStage = hlsMatch[1].includes('duplicado') ? 'HLS duplicado' : 'convertendo HLS'
    state.currentVideo = hlsMatch[2]
    state.progressPercent = Math.max(state.progressPercent, 50)
    return
  }

  const queueMatch = clean.match(/fila pronta:\s+(\d+)\s+videos/i)
  if (queueMatch) {
    state.currentStage = `fila com ${queueMatch[1]} vídeos`
    state.progressPercent = Math.max(state.progressPercent, 2)
    return
  }

  if (clean.includes('[vimeo] resumo:')) {
    state.currentStage = 'finalizando'
    state.progressPercent = 100
  }
}

function getMachineIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && address.address.startsWith('10.13.136.')) {
        return address.address
      }
    }
  }
  return null
}

function readCpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }
  return { idle, total }
}

function readCpuPercent() {
  const next = readCpuSnapshot()
  if (!lastCpuSnapshot) {
    lastCpuSnapshot = next
    return null
  }
  const idleDelta = next.idle - lastCpuSnapshot.idle
  const totalDelta = next.total - lastCpuSnapshot.total
  lastCpuSnapshot = next
  if (totalDelta <= 0) return null
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

function nvidiaSmiCandidates() {
  const candidates = [process.env.NVIDIA_SMI_PATH, 'nvidia-smi'].filter(Boolean) as string[]
  if (os.platform() === 'win32') {
    candidates.unshift('C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
  }
  return [...new Set(candidates)]
}

function parseGpuNumber(value: string) {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

async function readGpuMetrics(): Promise<SystemMetrics['gpu']> {
  if (Date.now() - gpuMetricsCache.at < 30_000) return gpuMetricsCache.value

  const queryVariants = [
    {
      args: [
        '--query-gpu=utilization.gpu,utilization.encoder,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      hasEncoder: true,
    },
    {
      args: [
        '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      hasEncoder: false,
    },
  ]
  for (const command of nvidiaSmiCandidates()) {
    if (command.includes(':\\') && !existsSync(command)) continue
    for (const variant of queryVariants) {
      try {
        const output = await new Promise<string>((resolve, reject) => {
          execFile(command, variant.args, { timeout: 4000, windowsHide: true }, (error, stdout) => {
            if (error) {
              reject(error)
              return
            }
            resolve(stdout)
          })
        })
        const first = output.trim().split(/\r?\n/)[0]
        if (!first) continue
        const parts = first.split(',')
        const gpuRaw = parts[0]
        const encoderRaw = variant.hasEncoder ? parts[1] : ''
        const usedRaw = variant.hasEncoder ? parts[2] : parts[1]
        const totalRaw = variant.hasEncoder ? parts[3] : parts[2]
        const tempRaw = variant.hasEncoder ? parts[4] : parts[3]
        const gpuPercent = parseGpuNumber(gpuRaw || '')
        const encoderPercent = parseGpuNumber(encoderRaw || '')
        const memoryUsedMb = parseGpuNumber(usedRaw || '')
        const memoryTotalMb = parseGpuNumber(totalRaw || '')
        const tempC = parseGpuNumber(tempRaw || '')
        const value = gpuPercent == null ? null : {
          gpuPercent,
          encoderPercent,
          memoryUsedMb,
          memoryTotalMb,
          memoryPercent: memoryUsedMb != null && memoryTotalMb ? Math.max(0, Math.min(100, (memoryUsedMb / memoryTotalMb) * 100)) : null,
          tempC,
        }
        gpuMetricsCache = { at: Date.now(), value }
        return value
      } catch {
        continue
      }
    }
  }

  gpuMetricsCache = { at: Date.now(), value: null }
  return null
}

async function collectSystemMetrics(): Promise<SystemMetrics> {
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const usedMemory = Math.max(0, totalMemory - freeMemory)
  return {
    cpuPercent: readCpuPercent(),
    memoryPercent: totalMemory > 0 ? Math.max(0, Math.min(100, (usedMemory / totalMemory) * 100)) : 0,
    memoryUsedGb: usedMemory / 1024 / 1024 / 1024,
    memoryTotalGb: totalMemory / 1024 / 1024 / 1024,
    gpu: await readGpuMetrics(),
    collectedAt: new Date().toISOString(),
  }
}

function boolArg(value: any, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'sim'].includes(String(value).toLowerCase())
}

function numberArg(value: any, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function hasRuntimeConfig() {
  return existsSync('.env.local') ||
    existsSync('.env') ||
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.VIMEO_ACCESS_TOKEN)
}

function sanitizeChildEnv(env: NodeJS.ProcessEnv) {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.startsWith('=') || key.includes('=') || key.includes('\0')) continue
    if (value == null) continue
    const stringValue = String(value)
    if (stringValue.includes('\0')) continue
    clean[key] = stringValue
  }
  return clean
}

function buildStartCommand(payload: Record<string, any>) {
  const runName = String(payload.runName || payload.run_name || 'manual').trim()
  const folderUri = String(payload.folderUri || payload.folder_uri || '').trim()
  const limit = numberArg(payload.limit, 0)
  const videoConcurrency = numberArg(payload.videoConcurrency ?? payload.video_concurrency, 4)
  const hlsConcurrency = numberArg(payload.hlsConcurrency ?? payload.hls_concurrency, 1)
  const uploadConcurrency = numberArg(payload.uploadConcurrency ?? payload.upload_concurrency, 2)
  const execute = boolArg(payload.execute, true)
  const notify = boolArg(payload.notify, true)
  const gpu = boolArg(payload.gpu, machineType.includes('gtx') || machineType.includes('rtx'))

  const env: NodeJS.ProcessEnv = sanitizeChildEnv({
    ...process.env,
    CI_VIMEO_WORKER_NAME: workerName,
    VIMEO_MIGRATION_RUN_NAME: runName,
  })

  if (os.platform() === 'win32') {
    const runner = path.join(process.cwd(), 'scripts', 'run-vimeo-worker-windows.ps1')
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runner,
      '-WorkerName',
      workerName,
      '-VideoConcurrency',
      String(videoConcurrency),
      '-HlsConcurrency',
      String(hlsConcurrency),
      '-UploadConcurrency',
      String(uploadConcurrency),
    ]
    if (folderUri) args.push('-FolderUri', folderUri)
    if (limit > 0) args.push('-Limit', String(limit))
    if (execute) args.push('-Execute')
    if (notify) args.push('-Notify')
    if (gpu) args.push('-Gpu')
    return { command: 'powershell.exe', args, env, runName }
  }

  env.VIMEO_MIGRATION_EXECUTE = execute ? '1' : '0'
  env.VIMEO_MIGRATION_NOTIFY = notify ? '1' : '0'
  env.VIMEO_MIGRATION_NOTIFY_NAME = workerName
  env.VIMEO_MIGRATION_VIDEO_CONCURRENCY = String(videoConcurrency)
  env.VIMEO_MIGRATION_HLS_CONCURRENCY = String(hlsConcurrency)
  env.VIDEO_HLS_UPLOAD_CONCURRENCY = String(uploadConcurrency)
  if (folderUri) env.VIMEO_MIGRATION_FOLDER_URI = folderUri
  if (limit > 0) env.VIMEO_MIGRATION_LIMIT = String(limit)
  if (gpu) env.VIDEO_HLS_ENCODER = 'h264_nvenc'

  return { command: 'npm', args: ['run', 'video:migrate-vimeo'], env, runName }
}

function buildQueueBatchCommand(jobs: QueueJob[], payload: Record<string, any>) {
  const runName = String(payload.runName || payload.run_name || 'fila-central').trim()
  const videoConcurrency = Math.max(1, numberArg(payload.videoConcurrency ?? payload.video_concurrency, 1))
  const hlsConcurrency = Math.max(1, numberArg(payload.hlsConcurrency ?? payload.hls_concurrency, 1))
  const uploadConcurrency = Math.max(1, numberArg(payload.uploadConcurrency ?? payload.upload_concurrency, 1))
  const notify = boolArg(payload.notify, false)
  const gpu = boolArg(payload.gpu, machineType.includes('gtx') || machineType.includes('rtx'))
  const batchId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const queueFilePath = path.join(dataDir, `queue-batch-${sanitizeFileName(workerName)}-${batchId}.json`)
  const taskIds = jobs.map((job) => job.id)
  writeFileSync(queueFilePath, JSON.stringify({ items: jobs.map((job) => job.source_payload) }, null, 2))

  const env: NodeJS.ProcessEnv = sanitizeChildEnv({
    ...process.env,
    CI_VIMEO_WORKER_NAME: workerName,
    VIMEO_MIGRATION_RUN_NAME: runName,
    VIMEO_MIGRATION_EXECUTE: '1',
    VIMEO_MIGRATION_NOTIFY: notify ? '1' : '0',
    VIMEO_MIGRATION_NOTIFY_NAME: workerName,
    VIMEO_MIGRATION_QUEUE_CACHE: '0',
    VIMEO_MIGRATION_QUEUE_FILE: queueFilePath,
    VIMEO_MIGRATION_QUEUE_TASK_IDS: JSON.stringify(taskIds),
    VIMEO_MIGRATION_PROCESS: '1',
    VIMEO_MIGRATION_VIDEO_CONCURRENCY: String(videoConcurrency),
    VIMEO_MIGRATION_HLS_CONCURRENCY: String(hlsConcurrency),
    VIDEO_HLS_UPLOAD_CONCURRENCY: String(uploadConcurrency),
  })
  if (gpu) env.VIDEO_HLS_ENCODER = 'h264_nvenc'

  const isWindows = os.platform() === 'win32'

  return {
    command: isWindows ? 'cmd.exe' : 'npm',
    args: isWindows ? ['/c', 'npm.cmd', 'run', 'migrate'] : ['run', 'migrate'],
    env,
    runName,
    queueFilePath,
    taskIds,
  }
}

function startQueueMode(commandId: string, payload: Record<string, any>) {
  if (child) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Worker já está rodando.' })
    return
  }
  if (!hasRuntimeConfig()) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Arquivo .env.local não encontrado.' })
    return
  }

  queueConfig = { ...payload, queueMode: true }
  state.queueMode = true
  state.paused = false
  state.status = 'running'
  state.runName = String(payload.runName || payload.run_name || 'fila-central').trim()
  state.currentStage = 'aguardando tarefa da fila'
  state.currentVideo = null
  state.progressPercent = 0
  state.lastError = null
  pendingResults.push({ id: commandId, status: 'completed' })
}

function startQueueBatch(jobs: QueueJob[]) {
  if (child || jobs.length === 0) return
  const start = buildQueueBatchCommand(jobs, queueConfig)
  activeTaskIds = start.taskIds
  state.status = 'running'
  state.currentStage = `lote com ${jobs.length} video(s)`
  state.currentVideo = jobs.map((job) => job.title).join(', ').slice(0, 220)
  state.progressPercent = 1
  state.lastError = null

  const runLogPath = path.join(logDir, `queue-${sanitizeFileName(workerName)}-${Date.now()}.log`)
  const runLog = createWriteStream(runLogPath, { flags: 'a' })
  log(`iniciando lote da fila: ${jobs.length} tarefas`)

  try {
    child = spawn(start.command, start.args, {
      cwd: process.cwd(),
      env: start.env,
      detached: os.platform() !== 'win32',
    })
  } catch (error) {
    runLog.end()
    const message = error instanceof Error ? error.message : String(error)
    state.status = 'error'
    state.lastError = message
    pendingTaskResults.push(...activeTaskIds.map((id) => ({ id, status: 'released' as const, error: message })))
    activeTaskIds = []
    child = null
    childPid = null
    log(`erro ao iniciar lote da fila: ${message}`)
    return
  }
  childPid = child.pid || null

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    runLog.write(text)
    for (const line of text.split(/\r?\n/)) parseOutputLine(line)
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    runLog.write(text)
    const line = text.trim()
    if (line) state.lastError = line.slice(0, 500)
  })

  child.on('error', (error) => {
    state.status = 'error'
    state.lastError = error.message
    pendingTaskResults.push(...activeTaskIds.map((id) => ({ id, status: 'released' as const, error: error.message })))
    activeTaskIds = []
    log(`erro ao iniciar lote da fila: ${error.message}`)
  })

  child.on('close', (code) => {
    runLog.end()
    log(`lote da fila terminou com codigo ${code}`)
    const finishedIds = activeTaskIds
    activeTaskIds = []
    child = null
    childPid = null

    if (state.status === 'stopping') {
      pendingTaskResults.push(...finishedIds.map((id) => ({ id, status: 'released' as const, error: 'Worker parado manualmente.' })))
      state.queueMode = false
      state.status = state.paused ? 'paused' : 'idle'
      state.currentStage = 'parado'
      return
    }

    if (code === 0) {
      pendingTaskResults.push(...finishedIds.map((id) => ({ id, status: 'completed' as const })))
      state.status = state.paused ? 'paused' : 'running'
      state.currentStage = state.paused ? 'pausado apos lote' : 'aguardando proximo lote'
      state.progressPercent = state.paused ? state.progressPercent : 0
      return
    }

    pendingTaskResults.push(...finishedIds.map((id) => ({ id, status: 'released' as const, error: `Processo terminou com código ${code}` })))
    state.status = 'error'
    state.lastError = `Processo terminou com código ${code}`
  })
}

function startMigration(commandId: string, payload: Record<string, any>) {
  if (child) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Worker já está rodando.' })
    return
  }
  if (state.paused) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Worker está pausado.' })
    return
  }
  if (!hasRuntimeConfig()) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Arquivo .env.local não encontrado.' })
    return
  }

  const start = buildStartCommand(payload)
  state.status = 'running'
  state.runName = start.runName
  state.currentStage = 'iniciando'
  state.currentVideo = null
  state.progressPercent = 0
  state.lastError = null

  const runLogPath = path.join(logDir, `run-${sanitizeFileName(workerName)}-${Date.now()}.log`)
  const runLog = createWriteStream(runLogPath, { flags: 'a' })
  log(`iniciando migracao: ${start.command} ${start.args.join(' ')}`)

  child = spawn(start.command, start.args, {
    cwd: process.cwd(),
    env: start.env,
    detached: os.platform() !== 'win32',
  })
  childPid = child.pid || null
  pendingResults.push({ id: commandId, status: 'completed' })

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    runLog.write(text)
    for (const line of text.split(/\r?\n/)) parseOutputLine(line)
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    runLog.write(text)
    const line = text.trim()
    if (line) state.lastError = line.slice(0, 500)
  })

  child.on('error', (error) => {
    state.status = 'error'
    state.lastError = error.message
    log(`erro ao iniciar processo: ${error.message}`)
  })

  child.on('close', (code) => {
    runLog.end()
    log(`processo terminou com codigo ${code}`)
    child = null
    childPid = null
    if (state.status === 'stopping') {
      state.status = 'idle'
      state.currentStage = 'parado'
      return
    }
    if (code === 0) {
      state.status = 'idle'
      state.currentStage = 'concluído'
      state.progressPercent = 100
      return
    }
    state.status = 'error'
    state.lastError = `Processo terminou com código ${code}`
  })
}

function stopMigration(commandId: string) {
  if (!child || !childPid) {
    if (activeTaskIds.length > 0) {
      pendingTaskResults.push(...activeTaskIds.map((id) => ({ id, status: 'released' as const, error: 'Worker parado manualmente.' })))
      activeTaskIds = []
    }
    state.queueMode = false
    state.status = state.paused ? 'paused' : 'idle'
    pendingResults.push({ id: commandId, status: 'completed' })
    return
  }

  state.status = 'stopping'
  state.currentStage = 'parando'
  try {
    if (os.platform() === 'win32') {
      spawn('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-childPid, 'SIGTERM')
    }
    pendingResults.push({ id: commandId, status: 'completed' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    pendingResults.push({ id: commandId, status: 'failed', error: message })
  }
}

function handleCommand(command: WorkerCommand) {
  log(`comando recebido: ${command.command} (${command.id})`)
  if (command.command === 'start') {
    const payload = command.payload || {}
    if (payload.queueMode === false || payload.queue_mode === false) {
      startMigration(command.id, payload)
    } else {
      startQueueMode(command.id, payload)
    }
    return
  }
  if (command.command === 'stop') {
    stopMigration(command.id)
    return
  }
  if (command.command === 'pause') {
    state.paused = true
    state.status = 'paused'
    state.currentStage = child ? 'pausado apos lote atual' : 'pausado'
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
  if (command.command === 'resume') {
    state.paused = false
    if (state.queueMode) {
      state.status = 'running'
      state.currentStage = child ? state.currentStage : 'aguardando tarefa da fila'
    } else if (!child) {
      state.status = 'idle'
    }
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
  if (command.command === 'update_config') {
    queueConfig = { ...queueConfig, ...(command.payload || {}) }
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
}

function readConfigSummary() {
  return {
    pollMs,
    hubUrl,
    queueMode: state.queueMode,
    queueConfig,
    notifications: process.env.VIMEO_MIGRATION_NOTIFY || null,
    encoder: process.env.VIDEO_HLS_ENCODER || null,
  }
}

function writeStatusFile() {
  try {
    writeFileSync(statusFilePath, JSON.stringify({
      workerName,
      displayName,
      machineIp: getMachineIp(),
      machineType,
      status: state.status,
      runName: state.runName,
      currentVideo: state.currentVideo,
      currentStage: state.currentStage,
      progressPercent: state.progressPercent,
      lastError: state.lastError,
      heartbeatAt: new Date().toISOString(),
      childPid,
      queueMode: state.queueMode,
      activeTaskIds,
    }, null, 2))
  } catch {
    /* Nao derruba o agent por falha no arquivo de metricas. */
  }
}

async function heartbeat() {
  if (!workerSecret) {
    writeStatusFile()
    throw new Error('VIDEO_WORKER_CONTROL_SECRET ou CRON_SECRET não configurado.')
  }

  const commandResults = pendingResults
  pendingResults = []
  const taskResults = pendingTaskResults
  pendingTaskResults = []
  const shouldRequestJobs = state.queueMode && state.status === 'running' && !state.paused && !child
  const capacity = Math.max(1, numberArg(queueConfig.videoConcurrency ?? queueConfig.video_concurrency, 1))
  const systemMetrics = await collectSystemMetrics()

  const response = await fetch(`${hubUrl}/api/videos/workers/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workerSecret}`,
    },
    body: JSON.stringify({
      workerName,
      displayName,
      machineIp: getMachineIp(),
      machineType,
      status: state.status,
      runName: state.runName,
      currentVideo: state.currentVideo,
      currentStage: state.currentStage,
      progressPercent: state.progressPercent,
      lastError: state.lastError,
      capabilities: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        hostname: os.hostname(),
        system: systemMetrics,
      },
      config: readConfigSummary(),
      commandResults,
      taskResults,
      activeTaskIds,
      requestJobs: shouldRequestJobs,
      capacity,
      leaseSeconds: 1800,
    }),
  })

  const body = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(body.error || `Hub respondeu HTTP ${response.status}`)

  for (const command of (body.commands || []) as WorkerCommand[]) {
    handleCommand(command)
  }
  if (state.queueMode && !state.paused && !child && Array.isArray(body.jobs) && body.jobs.length > 0) {
    startQueueBatch(body.jobs as QueueJob[])
  }
  writeStatusFile()
}

async function main() {
  log(`agent iniciado: ${workerName} -> ${hubUrl}`)
  while (true) {
    try {
      await heartbeat()
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      log(`heartbeat falhou: ${state.lastError}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

main().catch((error) => {
  log(`agent caiu: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
