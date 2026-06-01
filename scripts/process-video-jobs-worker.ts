import { config as loadEnv } from 'dotenv'
import { setTimeout as wait } from 'node:timers/promises'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { processVideoCaptionsOnly, processVideoToHls } from '@/lib/videos/processing'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

type ProcessingJob = {
  id: string
  video_asset_id: string
  source_key: string | null
  status: string
  job_type?: string | null
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
  queueName === 'legacy' ? 'fila antiga HLS' : 'uploads novos HLS',
)
const pollMs = envNumber('VIDEO_PROCESSING_WORKER_POLL_MS', 15_000)
const heartbeatMs = envNumber('VIDEO_PROCESSING_HEARTBEAT_MS', 15_000)
const concurrency = Math.max(1, Math.min(4, envNumber('VIDEO_PROCESSING_WORKER_CONCURRENCY', 1)))
const staleMinutes = envNumber('VIDEO_PROCESSING_STALE_MINUTES', 45)
const jobStallMinutes = envNumber('VIDEO_PROCESSING_JOB_STALL_MINUTES', 90)
const requeueStale = envFlag('VIDEO_PROCESSING_REQUEUE_STALE', true)
const once = envFlag('VIDEO_PROCESSING_WORKER_ONCE', false)
const pauseLegacyForUploads = envFlag('VIDEO_PROCESSING_PAUSE_LEGACY_FOR_UPLOADS', queueName === 'legacy')

function hasCaptionTracks(asset: any) {
  return Boolean(asset?.captions_key)
    || (Array.isArray(asset?.caption_tracks) && asset.caption_tracks.length > 0)
}

async function countActiveUploadJobs(db: any) {
  const { count, error } = await db
    .from('video_processing_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('queue_name', 'uploads')
    .in('status', ['queued', 'processing'])

  if (error) throw error
  return count || 0
}

async function updateHeartbeat(db: any, patch: Record<string, unknown> = {}) {
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
      captions: envFlag('VIDEO_CAPTIONS_ENABLED', true),
      gpu: true,
    },
    config: {
      role: 'secondary-video-processing-server',
      queueName,
      queueStatus,
      queueLabel,
      concurrency,
      encoder: process.env.VIDEO_HLS_ENCODER || null,
      captionsEnabled: envFlag('VIDEO_CAPTIONS_ENABLED', true),
      captionsModel: process.env.VIDEO_CAPTIONS_MODEL || 'large-v3',
      captionsDevice: process.env.VIDEO_CAPTIONS_DEVICE || 'cuda',
      captionsTranslate: process.env.VIDEO_CAPTIONS_TRANSLATE !== '0',
      pauseLegacyForUploads,
    },
    last_error: patch.last_error || patch.lastError || null,
    heartbeat_at: new Date().toISOString(),
  }, { onConflict: 'worker_name' })
}

async function claimNextJob(db: any): Promise<ProcessingJob | null> {
  if (requeueStale) {
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000).toISOString()
    await db
      .from('video_processing_jobs')
      .update({
        status: queueStatus,
        progress: 0,
        current_stage: `reenfileirado por ausencia de progresso por ${staleMinutes} minutos`,
        error_message: `Reenfileirado por ausencia de progresso por ${staleMinutes} minutos.`,
      })
      .eq('status', 'processing')
      .eq('queue_name', queueName)
      .lt('updated_at', staleBefore)
  }

  const { data: candidates, error } = await db
    .from('video_processing_jobs')
    .select('id, video_asset_id, source_key, status, job_type, created_at, queue_name')
    .eq('status', queueStatus)
    .eq('queue_name', queueName)
    .order('created_at', { ascending: true })
    .limit(5)

  if (error) throw error

  for (const candidate of candidates || []) {
    const { data: claimed, error: claimError } = await db
      .from('video_processing_jobs')
      .update({
        status: 'processing',
        processing_worker_name: workerName,
        current_stage: 'reservado pelo worker',
        started_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', candidate.id)
      .eq('status', queueStatus)
      .eq('queue_name', queueName)
      .select('id, video_asset_id, source_key, status, job_type')
      .maybeSingle()

    if (claimError) throw claimError
    if (claimed) return claimed as ProcessingJob
  }

  return null
}

async function processJob(db: any, job: ProcessingJob) {
  const { data: asset } = await db
    .from('video_assets')
    .select('title,status,hls_manifest_key,captions_key,caption_tracks')
    .eq('id', job.video_asset_id)
    .maybeSingle()

  const title = asset?.title || job.video_asset_id
  console.log(`[${workerName}] processando ${title} (${job.id})`)
  const captionsOnly = job.job_type === 'captions'
    || (queueName === 'legacy' && asset?.hls_manifest_key && !hasCaptionTracks(asset))
  let currentStage = captionsOnly ? 'gerando legendas pt-BR, ingles e espanhol' : 'convertendo para HLS'
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
          current_stage: currentStage,
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
          status: queueStatus,
          progress: 0,
          processing_worker_name: null,
          current_stage: 'reenfileirado por worker travado',
          error_message: message,
        })
        .eq('id', job.id)
        .eq('status', 'processing')
        .eq('queue_name', queueName),
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
    const processor = captionsOnly ? processVideoCaptionsOnly : processVideoToHls
    await processor({
      assetId: job.video_asset_id,
      jobId: job.id,
      userId: null,
      onProgress: async (event) => {
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
  } finally {
    clearTimers()
  }

  console.log(`[${workerName}] concluido ${title} (${job.id})`)
}

async function workerSlot(db: any, slot: number) {
  while (true) {
    const job = await claimNextJob(db)
    if (!job) return

    try {
      await processJob(db, job)
    } catch (error) {
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
    concurrency,
    pollMs,
    heartbeatMs,
    encoder: process.env.VIDEO_HLS_ENCODER || 'libx264',
    staleMinutes,
    jobStallMinutes,
    requeueStale,
    once,
    pauseLegacyForUploads,
  }))

  while (true) {
    if (queueName === 'legacy' && pauseLegacyForUploads) {
      const activeUploads = await countActiveUploadJobs(db)
      if (activeUploads > 0) {
        await updateHeartbeat(db, {
          status: 'idle',
          current_stage: `aguardando uploads novos (${activeUploads})`,
          progress_percent: 0,
        })
        if (once) break
        await wait(pollMs)
        continue
      }
    }

    await updateHeartbeat(db, {
      status: 'running',
      current_stage: `procurando jobs: ${queueLabel}`,
      progress_percent: 0,
    })

    await Promise.all(Array.from({ length: concurrency }, (_, index) => workerSlot(db, index + 1)))

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
