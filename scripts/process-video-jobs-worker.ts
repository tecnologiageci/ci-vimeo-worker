import { config as loadEnv } from 'dotenv'
import { setTimeout as wait } from 'node:timers/promises'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import {
  processVideoHls720Variant,
  processVideoStoryboardOnly,
  processVideoToHls,
  VideoProcessingCancelledError,
} from '@/lib/videos/processing'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

type ProcessingJob = {
  id: string
  video_asset_id: string
  source_key: string | null
  status: string
  job_type?: string | null
  queue_name?: string | null
  created_at?: string | null
  video_assets?: {
    created_at?: string | null
    processed_at?: string | null
    upload_finished_at?: string | null
  } | Array<{
    created_at?: string | null
    processed_at?: string | null
    upload_finished_at?: string | null
  }> | null
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function envFlag(name: string, fallback = false) {
  const value = (process.env[name] || '').trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'sim', 'on'].includes(value)
}

function envText(name: string, fallback: string) {
  const value = process.env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

const workerName = (process.env.VIDEO_PROCESSING_WORKER_NAME || 'PC-LUIZ-HLS').trim()
const displayName = (process.env.VIDEO_PROCESSING_WORKER_DISPLAY_NAME || process.env.CI_VIMEO_WORKER_DISPLAY_NAME || 'Luiz RTX').trim()
const machineIp = (process.env.VIDEO_PROCESSING_WORKER_IP || '10.13.136.117').trim()
const queueStatus = envText('VIDEO_PROCESSING_QUEUE_STATUS', 'queued')
const queueName = envText('VIDEO_PROCESSING_QUEUE_NAME', queueStatus === 'queued_legacy' ? 'legacy' : 'uploads')
const queueLabel = envText(
  'VIDEO_PROCESSING_QUEUE_LABEL',
  queueName === 'preview'
    ? 'preview rapido'
    : queueName === 'hls_720'
      ? 'variantes 720p'
      : queueName === 'legacy'
        ? 'fila antiga HLS'
        : 'uploads novos HLS',
)
const pollMs = envNumber('VIDEO_PROCESSING_WORKER_POLL_MS', 15_000)
const heartbeatMs = envNumber('VIDEO_PROCESSING_HEARTBEAT_MS', 15_000)
const concurrency = Math.max(1, Math.min(4, envNumber('VIDEO_PROCESSING_WORKER_CONCURRENCY', 1)))
const staleMinutes = envNumber('VIDEO_PROCESSING_STALE_MINUTES', 45)
const jobStallMinutes = envNumber('VIDEO_PROCESSING_JOB_STALL_MINUTES', 90)
const requeueStale = envFlag('VIDEO_PROCESSING_REQUEUE_STALE', true)
const prioritizeUploads = envFlag('VIDEO_PROCESSING_PRIORITIZE_UPLOADS', queueName === 'preview' || queueName === 'hls_720')
const once = envFlag('VIDEO_PROCESSING_WORKER_ONCE', false)
const PAUSED_STATUSES = new Set(['paused', 'stopping'])

class WorkerPauseRequestedError extends Error {
  constructor(message = 'Worker pausado pela interface.') {
    super(message)
    this.name = 'WorkerPauseRequestedError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPauseRequestedError(error: unknown) {
  return error instanceof WorkerPauseRequestedError
    || error instanceof VideoProcessingCancelledError
    || (error instanceof Error && ['WorkerPauseRequestedError', 'VideoProcessingCancelledError'].includes(error.name))
}

function firstRelatedAsset(job: ProcessingJob) {
  const asset = job.video_assets
  return Array.isArray(asset) ? asset[0] : asset
}

function timeValue(value?: string | null) {
  const parsed = value ? new Date(value).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function r2EnteredAt(job: ProcessingJob) {
  const asset = firstRelatedAsset(job)
  return timeValue(asset?.upload_finished_at || asset?.processed_at || asset?.created_at || job.created_at)
}

function workerQueuePreferences() {
  const queues = prioritizeUploads && queueName !== 'uploads' && queueName !== 'legacy'
    ? ['uploads', queueName]
    : [queueName]
  return Array.from(new Set(queues.filter(Boolean)))
}

function queuedStatusForQueue(name?: string | null) {
  return name === 'legacy' ? 'queued_legacy' : 'queued'
}

function queuedStatusForJob(job: ProcessingJob) {
  return queuedStatusForQueue(job.queue_name || queueName)
}

async function updateHeartbeat(db: any, patch: Record<string, unknown> = {}) {
  const { data: storedWorker, error: storedWorkerError } = await db
    .from('video_migration_workers')
    .select('config')
    .eq('worker_name', workerName)
    .maybeSingle()

  if (storedWorkerError) throw storedWorkerError
  const storedConfig = isRecord(storedWorker?.config) ? storedWorker.config : {}

  await db.from('video_migration_workers').upsert({
    worker_name: workerName,
    display_name: displayName,
    machine_ip: machineIp,
    machine_type: 'rtx',
    status: patch.status || 'running',
    current_stage: patch.current_stage || patch.currentStage || 'processador HLS',
    current_video: patch.current_video || patch.currentVideo || null,
    progress_percent: Number(patch.progress_percent ?? patch.progressPercent ?? 0) || 0,
    capabilities: {
      hlsProcessor: true,
      externalVideoProcessing: true,
      storyboard: queueName === 'preview',
      hls720: queueName === 'hls_720',
      gpu: true,
    },
    config: {
      ...storedConfig,
      role: 'secondary-video-processing-server',
      queueName,
      queueNames: workerQueuePreferences(),
      queueStatus,
      queueLabel,
      concurrency,
      encoder: process.env.VIDEO_HLS_ENCODER || null,
      prioritizeUploads,
    },
    last_error: patch.last_error || patch.lastError || null,
    heartbeat_at: new Date().toISOString(),
  }, { onConflict: 'worker_name' })
}

async function isWorkerPaused(db: any) {
  const { data, error } = await db
    .from('video_migration_workers')
    .select('status,config')
    .eq('worker_name', workerName)
    .maybeSingle()

  if (error) throw error
  const config = isRecord(data?.config) ? data.config : {}
  return PAUSED_STATUSES.has(String(data?.status || '').toLowerCase())
    || config.manualPaused === true
    || config.manual_paused === true
}

async function waitWhilePaused(db: any) {
  while (await isWorkerPaused(db)) {
    await updateHeartbeat(db, {
      status: 'paused',
      current_stage: 'pausado pela interface',
      current_video: null,
      progress_percent: 0,
    })

    if (once) return false
    await wait(pollMs)
  }

  return true
}

async function releaseJobForPause(
  db: any,
  job: ProcessingJob,
  title: string,
  currentStage: string,
  currentProgress: number,
) {
  const message = `Pausado pela interface em "${currentStage}" (${currentProgress}%). Job devolvido para a fila.`

  await db
    .from('video_processing_jobs')
    .update({
      status: queuedStatusForJob(job),
      progress: 0,
      processing_worker_name: null,
      started_at: null,
      error_message: message,
      current_stage: 'aguardando worker: pausado pela interface',
    })
    .eq('id', job.id)
    .eq('status', 'processing')
    .eq('processing_worker_name', workerName)

  const { data: asset } = await db
    .from('video_assets')
    .select('hls_manifest_key')
    .eq('id', job.video_asset_id)
    .maybeSingle()

  if (!asset?.hls_manifest_key) {
    await db
      .from('video_assets')
      .update({
        status: 'uploaded',
        last_error: null,
      })
      .eq('id', job.video_asset_id)
  }

  await updateHeartbeat(db, {
    status: 'paused',
    current_stage: 'pausado pela interface',
    current_video: null,
    progress_percent: 0,
    last_error: null,
  })

  console.log(`[${workerName}] ${message} Video: ${title}`)
}

async function claimNextJob(db: any): Promise<ProcessingJob | null> {
  if (await isWorkerPaused(db)) return null

  const queuePreferences = workerQueuePreferences()

  if (requeueStale) {
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000).toISOString()
    for (const preferredQueue of queuePreferences) {
      await db
        .from('video_processing_jobs')
        .update({
          status: queuedStatusForQueue(preferredQueue),
          progress: 0,
          error_message: `Reenfileirado por ausencia de progresso por ${staleMinutes} minutos.`,
        })
        .eq('status', 'processing')
        .eq('queue_name', preferredQueue)
        .lt('updated_at', staleBefore)
    }
  }

  for (const preferredQueue of queuePreferences) {
    const preferredStatus = queuedStatusForQueue(preferredQueue)
    const { data: candidates, error } = await db
      .from('video_processing_jobs')
      .select('id, video_asset_id, source_key, status, job_type, created_at, queue_name, video_assets(created_at, processed_at, upload_finished_at)')
      .eq('status', preferredStatus)
      .eq('queue_name', preferredQueue)
      .order('created_at', { ascending: false })
      .limit(preferredQueue === 'uploads' ? 250 : 10000)

    if (error) throw error

    const sortedCandidates = [...(candidates || [])].sort((a: ProcessingJob, b: ProcessingJob) => {
      const r2Diff = r2EnteredAt(b) - r2EnteredAt(a)
      if (r2Diff !== 0) return r2Diff
      return timeValue(b.created_at) - timeValue(a.created_at)
    })

    for (const candidate of sortedCandidates) {
      if (await isWorkerPaused(db)) return null

      const { data: claimed, error: claimError } = await db
        .from('video_processing_jobs')
        .update({
          status: 'processing',
          processing_worker_name: workerName,
          started_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', candidate.id)
        .eq('status', preferredStatus)
        .eq('queue_name', preferredQueue)
        .select('id, video_asset_id, source_key, status, job_type, queue_name, created_at')
        .maybeSingle()

      if (claimError) throw claimError
      if (claimed) return claimed as ProcessingJob
    }
  }

  return null
}

async function processJob(db: any, job: ProcessingJob) {
  const { data: asset } = await db
    .from('video_assets')
    .select('title')
    .eq('id', job.video_asset_id)
    .maybeSingle()

  const title = asset?.title || job.video_asset_id
  console.log(`[${workerName}] processando ${title} (${job.id})`)
  const jobQueueName = job.queue_name || queueName
  const storyboardOnly = job.job_type === 'storyboard' || jobQueueName === 'preview'
  const hls720Only = job.job_type === 'hls_720' || jobQueueName === 'hls_720'
  let currentStage = hls720Only ? 'gerando 720p' : storyboardOnly ? 'gerando preview rapido' : 'convertendo para HLS'
  let currentProgress = 1
  let lastProgressAt = Date.now()
  let exitingForStall = false

  const heartbeatTimer = setInterval(() => {
    void (async () => {
      await updateHeartbeat(db, {
        status: 'running',
        current_stage: currentStage,
        current_video: title,
        progress_percent: currentProgress,
      })

      await db
        .from('video_processing_jobs')
        .update({
          progress: currentProgress,
          processing_worker_name: workerName,
        })
        .eq('id', job.id)
        .eq('status', 'processing')
    })().catch(() => undefined)
  }, heartbeatMs)

  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgressAt < jobStallMinutes * 60_000) return
    if (exitingForStall) return
    exitingForStall = true

    const message = `Worker reiniciado automaticamente: sem progresso por ${jobStallMinutes} minutos em "${currentStage}".`
    console.error(`[${workerName}] ${message}`)
    Promise.allSettled([
      db
        .from('video_processing_jobs')
        .update({
          status: queuedStatusForJob(job),
          progress: 0,
          processing_worker_name: null,
          error_message: message,
        })
        .eq('id', job.id)
        .eq('status', 'processing')
        .eq('queue_name', job.queue_name || queueName),
      updateHeartbeat(db, {
        status: 'error',
        current_stage: 'reiniciando worker travado',
        current_video: title,
        progress_percent: currentProgress,
        last_error: message,
      }),
    ]).finally(() => process.exit(2))
  }, Math.max(heartbeatMs, 30_000))

  const clearTimers = () => {
    clearInterval(heartbeatTimer)
    clearInterval(stallTimer)
  }

  await updateHeartbeat(db, {
    status: 'running',
    current_stage: currentStage,
    current_video: title,
    progress_percent: currentProgress,
  })

  try {
    const processor = hls720Only
      ? processVideoHls720Variant
      : storyboardOnly
        ? processVideoStoryboardOnly
        : processVideoToHls
    await processor({
      assetId: job.video_asset_id,
      jobId: job.id,
      userId: null,
      shouldAbort: () => isWorkerPaused(db),
      onProgress: async (event) => {
        if (await isWorkerPaused(db)) {
          throw new WorkerPauseRequestedError()
        }
        if (event.progress !== currentProgress || event.stage !== currentStage) {
          lastProgressAt = Date.now()
        }
        currentStage = event.stage
        currentProgress = event.progress
        await updateHeartbeat(db, {
          status: 'running',
          current_stage: currentStage,
          current_video: title,
          progress_percent: currentProgress,
        })
      },
    })
  } catch (error) {
    if (isPauseRequestedError(error) || await isWorkerPaused(db)) {
      await releaseJobForPause(db, job, title, currentStage, currentProgress)
      throw new WorkerPauseRequestedError()
    }
    throw error
  } finally {
    clearTimers()
  }

  console.log(`[${workerName}] concluido ${title} (${job.id})`)
}

async function workerSlot(db: any, slot: number) {
  while (true) {
    if (await isWorkerPaused(db)) return

    const job = await claimNextJob(db)
    if (!job) return

    try {
      await processJob(db, job)
    } catch (error) {
      if (isPauseRequestedError(error)) {
        console.log(`[${workerName}] slot ${slot} pausado pela interface`)
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${workerName}] erro no slot ${slot}: ${message}`)
      await updateHeartbeat(db, {
        status: 'error',
        current_stage: 'erro no processamento',
        current_video: job.video_asset_id,
        last_error: message,
      })
    }
  }
}

async function main() {
  const db = createSupabaseAdmin()
  if (!db) throw new Error('Supabase service role nao configurado.')

  console.log(JSON.stringify({
    kind: 'video-processing-worker',
    workerName,
    displayName,
    machineIp,
    queueName,
    queueStatus,
    queueLabel,
    queuePreferences: workerQueuePreferences(),
    concurrency,
    pollMs,
    heartbeatMs,
    encoder: process.env.VIDEO_HLS_ENCODER || 'libx264',
    staleMinutes,
    jobStallMinutes,
    requeueStale,
    once,
    prioritizeUploads,
  }))

  while (true) {
    const canRun = await waitWhilePaused(db)
    if (!canRun) break

    await updateHeartbeat(db, {
      status: 'running',
      current_stage: `procurando jobs: ${queueLabel}`,
      progress_percent: 0,
    })

    await Promise.all(Array.from({ length: concurrency }, (_, index) => workerSlot(db, index + 1)))

    if (await isWorkerPaused(db)) {
      await updateHeartbeat(db, {
        status: 'paused',
        current_stage: 'pausado pela interface',
        current_video: null,
        progress_percent: 0,
      })
      if (once) break
      continue
    }

    await updateHeartbeat(db, {
      status: 'idle',
      current_stage: `sem jobs: ${queueLabel}`,
      progress_percent: 0,
    })

    if (once) break
    await wait(pollMs)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
