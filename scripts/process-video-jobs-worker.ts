import { config as loadEnv } from 'dotenv'
import { setTimeout as wait } from 'node:timers/promises'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { processVideoToHls } from '@/lib/videos/processing'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

type ProcessingJob = {
  id: string
  video_asset_id: string
  source_key: string | null
  status: string
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

const workerName = (process.env.VIDEO_PROCESSING_WORKER_NAME || 'PC-LUIZ-HLS').trim()
const displayName = (process.env.VIDEO_PROCESSING_WORKER_DISPLAY_NAME || process.env.CI_VIMEO_WORKER_DISPLAY_NAME || 'Luiz RTX').trim()
const machineIp = (process.env.VIDEO_PROCESSING_WORKER_IP || '10.13.136.117').trim()
const pollMs = envNumber('VIDEO_PROCESSING_WORKER_POLL_MS', 15_000)
const concurrency = Math.max(1, Math.min(4, envNumber('VIDEO_PROCESSING_WORKER_CONCURRENCY', 1)))
const staleMinutes = envNumber('VIDEO_PROCESSING_STALE_MINUTES', 180)
const requeueStale = envFlag('VIDEO_PROCESSING_REQUEUE_STALE', false)
const once = envFlag('VIDEO_PROCESSING_WORKER_ONCE', false)

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
      gpu: true,
    },
    config: {
      role: 'secondary-video-processing-server',
      concurrency,
      encoder: process.env.VIDEO_HLS_ENCODER || null,
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
        status: 'queued',
        progress: 0,
        error_message: `Reenfileirado por ausencia de progresso por ${staleMinutes} minutos.`,
      })
      .eq('status', 'processing')
      .lt('updated_at', staleBefore)
  }

  const { data: candidates, error } = await db
    .from('video_processing_jobs')
    .select('id, video_asset_id, source_key, status, created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(5)

  if (error) throw error

  for (const candidate of candidates || []) {
    const { data: claimed, error: claimError } = await db
      .from('video_processing_jobs')
      .update({
        status: 'processing',
        started_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .select('id, video_asset_id, source_key, status')
      .maybeSingle()

    if (claimError) throw claimError
    if (claimed) return claimed as ProcessingJob
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
  await updateHeartbeat(db, {
    status: 'running',
    current_stage: 'convertendo para HLS',
    current_video: title,
    progress_percent: 1,
  })

  await processVideoToHls({
    assetId: job.video_asset_id,
    jobId: job.id,
    userId: null,
    onProgress: async (event) => {
      await updateHeartbeat(db, {
        status: 'running',
        current_stage: event.stage,
        current_video: title,
        progress_percent: event.progress,
      })
    },
  })

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
    concurrency,
    pollMs,
    encoder: process.env.VIDEO_HLS_ENCODER || 'libx264',
    requeueStale,
    once,
  }))

  while (true) {
    await updateHeartbeat(db, {
      status: 'running',
      current_stage: 'procurando jobs HLS',
      progress_percent: 0,
    })

    await Promise.all(Array.from({ length: concurrency }, (_, index) => workerSlot(db, index + 1)))

    await updateHeartbeat(db, {
      status: 'idle',
      current_stage: 'sem jobs HLS na fila',
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
