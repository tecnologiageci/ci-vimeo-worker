import { config as loadEnv } from 'dotenv'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

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

type AgentState = {
  status: 'idle' | 'running' | 'paused' | 'stopping' | 'error'
  runName: string | null
  currentVideo: string | null
  currentStage: string | null
  progressPercent: number
  lastError: string | null
  paused: boolean
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

mkdirSync(logDir, { recursive: true })
const agentLog = createWriteStream(agentLogPath, { flags: 'a' })

let child: ChildProcessWithoutNullStreams | null = null
let childPid: number | null = null
let pendingResults: CommandResult[] = []
const state: AgentState = {
  status: 'idle',
  runName: null,
  currentVideo: null,
  currentStage: null,
  progressPercent: 0,
  lastError: null,
  paused: false,
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

function boolArg(value: any, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'sim'].includes(String(value).toLowerCase())
}

function numberArg(value: any, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI_VIMEO_WORKER_NAME: workerName,
    VIMEO_MIGRATION_RUN_NAME: runName,
  }

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

function startMigration(commandId: string, payload: Record<string, any>) {
  if (child) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Worker já está rodando.' })
    return
  }
  if (state.paused) {
    pendingResults.push({ id: commandId, status: 'failed', error: 'Worker está pausado.' })
    return
  }
  if (!existsSync('.env.local') && !existsSync('.env')) {
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
    startMigration(command.id, command.payload || {})
    return
  }
  if (command.command === 'stop') {
    stopMigration(command.id)
    return
  }
  if (command.command === 'pause') {
    state.paused = true
    if (!child) state.status = 'paused'
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
  if (command.command === 'resume') {
    state.paused = false
    if (!child) state.status = 'idle'
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
  if (command.command === 'update_config') {
    pendingResults.push({ id: command.id, status: 'completed' })
    return
  }
}

function readConfigSummary() {
  return {
    pollMs,
    hubUrl,
    notifications: process.env.VIMEO_MIGRATION_NOTIFY || null,
    encoder: process.env.VIDEO_HLS_ENCODER || null,
  }
}

async function heartbeat() {
  if (!workerSecret) {
    throw new Error('VIDEO_WORKER_CONTROL_SECRET ou CRON_SECRET não configurado.')
  }

  const commandResults = pendingResults
  pendingResults = []

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
      },
      config: readConfigSummary(),
      commandResults,
    }),
  })

  const body = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(body.error || `Hub respondeu HTTP ${response.status}`)

  for (const command of (body.commands || []) as WorkerCommand[]) {
    handleCommand(command)
  }
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
