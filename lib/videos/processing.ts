import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import {
  downloadObjectToFileWithProgress,
  guessContentType,
  headR2Object,
  uploadFileToR2,
  writeJsonMetadata,
  type R2DownloadProgress,
} from './r2'
import { buildStoryboardPlan, type StoryboardPlan } from './storyboard'
import type { VideoAsset } from './types'

interface RunResult {
  stdout: string
  stderr: string
}

type GeneratedCaptionTrack = {
  language: string
  label: string
  path: string
  default?: boolean
  source?: string | null
}

type StoredCaptionTrack = {
  language: string
  label: string
  key: string
  default: boolean
  source?: string | null
  generated_at: string
}

const CAPTION_AUDIO_FILE_NAME = 'caption-audio.wav'

function captionAudioKeyFromPrefix(outputPrefix: string) {
  return `${outputPrefix}/captions/${CAPTION_AUDIO_FILE_NAME}`
}

function runCommand(command: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} saiu com código ${code}: ${stderr || stdout}`))
    })
  })
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

function boundedPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)))
}

function rangedPercent(value: number, start: number, end: number) {
  if (end <= start) return boundedPercent(value)
  return boundedPercent(((value - start) / (end - start)) * 100)
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatClockDuration(value: number) {
  const total = Math.max(0, Math.floor(value))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function normalizeStageText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function mapCaptionProgress(stage: string, progress: number, details?: Record<string, unknown>) {
  const normalized = normalizeStageText(stage)

  if (normalized.includes('extraindo audio')) {
    return { stage: 'Extraindo áudio da legenda', progress: boundedPercent(progress) }
  }
  if (normalized.includes('carregando whisper')) {
    return { stage: 'Carregando IA de legenda', progress: 1 }
  }
  if (normalized.includes('transcrevendo')) {
    const transcribedSeconds = finiteNumber(details?.transcribed_seconds ?? details?.transcribedSeconds)
    const durationSeconds = finiteNumber(details?.duration_seconds ?? details?.durationSeconds)
    const captionProgress = Math.max(1, rangedPercent(progress, 5, 50))
    const suffix = durationSeconds && durationSeconds > 0 && transcribedSeconds != null
      ? ` · ${formatClockDuration(transcribedSeconds)} de ${formatClockDuration(durationSeconds)} transcritos`
      : ''
    return { stage: `Gerando legenda PT-BR${suffix}`, progress: captionProgress }
  }
  if (normalized.includes('carregando traducao')) {
    const language = normalized.includes('es') && !normalized.includes('mul-en') ? 'ES' : 'EN'
    return { stage: `Carregando tradução ${language}`, progress: 0 }
  }
  if (normalized.includes('ingles')) {
    return { stage: 'Traduzindo legenda EN', progress: rangedPercent(progress, 55, 72) }
  }
  if (normalized.includes('espanhol')) {
    return { stage: 'Traduzindo legenda ES', progress: rangedPercent(progress, 74, 92) }
  }
  if (normalized.includes('legendas prontas')) {
    return { stage: 'Legendas prontas', progress: 100 }
  }

  return { stage: stage || 'Gerando legendas', progress: boundedPercent(progress) }
}

function resolveCaptionPython() {
  return (process.env.VIDEO_CAPTIONS_PYTHON || process.env.PYTHON || 'python').trim()
}

function resolveCaptionScript() {
  const configured = process.env.VIDEO_CAPTIONS_SCRIPT?.trim()
  return configured || path.join(process.cwd(), 'scripts', 'generate-video-captions.py')
}

function runCaptionGenerator(args: {
  sourcePath: string
  outputDir: string
  resultJson: string
  onProgress?: (stage: string, progress: number) => void
}): Promise<{ tracks: GeneratedCaptionTrack[] }> {
  return new Promise((resolve, reject) => {
    const childArgs = [
      resolveCaptionScript(),
      '--source', args.sourcePath,
      '--output-dir', args.outputDir,
      '--result-json', args.resultJson,
      '--model', process.env.VIDEO_CAPTIONS_MODEL || 'large-v3-turbo',
      '--device', process.env.VIDEO_CAPTIONS_DEVICE || 'cuda',
      '--compute-type', process.env.VIDEO_CAPTIONS_COMPUTE_TYPE || 'float16',
      '--language', process.env.VIDEO_CAPTIONS_SOURCE_LANGUAGE || 'pt',
      process.env.VIDEO_CAPTIONS_TRANSLATE === '0' ? '--no-translate' : '--translate',
      '--translation-device', process.env.VIDEO_CAPTIONS_TRANSLATION_DEVICE || 'cpu',
      '--pt-en-model', process.env.VIDEO_CAPTIONS_PT_EN_MODEL || 'Helsinki-NLP/opus-mt-mul-en',
      '--pt-es-model', process.env.VIDEO_CAPTIONS_PT_ES_MODEL || '',
      '--en-es-model', process.env.VIDEO_CAPTIONS_EN_ES_MODEL || 'Helsinki-NLP/opus-mt-en-es',
    ]

    const child = spawn(resolveCaptionPython(), childArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let progressBuffer = ''

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      progressBuffer += text
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'progress') {
            const rawProgress = Number(event.progress || 0)
            const mapped = mapCaptionProgress(String(event.stage || 'gerando legendas'), rawProgress, event)
            args.onProgress?.(mapped.stage, mapped.progress)
          }
        } catch {
          /* stdout pode conter avisos das libs Python */
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`gerador de legendas saiu com código ${code}: ${stderr || stdout}`))
        return
      }

      try {
        const raw = await readFile(args.resultJson, 'utf8')
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`gerador de legendas nao retornou JSON valido: ${error instanceof Error ? error.message : error}`))
      }
    })
  })
}

async function generateAndUploadCaptionTracks(args: {
  sourcePath: string
  tempDir: string
  outputPrefix: string
  bucket: string | null
  resultDirName?: string
  onProgress?: (stage: string, progress: number) => void | Promise<void>
}) {
  const captionsDir = path.join(args.tempDir, args.resultDirName || 'captions')
  const captionsResultJson = path.join(captionsDir, 'captions-result.json')
  await mkdir(captionsDir, { recursive: true })

  const captionsResult = await runCaptionGenerator({
    sourcePath: args.sourcePath,
    outputDir: captionsDir,
    resultJson: captionsResultJson,
    onProgress: (stage, progress) => {
      Promise.resolve(args.onProgress?.(stage, progress)).catch(() => undefined)
    },
  })

  const generatedAt = new Date().toISOString()
  const captionTracks: StoredCaptionTrack[] = []
  for (const track of captionsResult.tracks || []) {
    if (!track.path || !track.language) continue
    const fileName = path.basename(track.path)
    const key = `${args.outputPrefix}/captions/${fileName}`
    await uploadFileToR2(track.path, key, 'text/vtt; charset=utf-8', args.bucket)
    captionTracks.push({
      language: track.language,
      label: track.label || track.language,
      key,
      default: Boolean(track.default),
      source: track.source || null,
      generated_at: generatedAt,
    })
  }

  const primaryCaptionsKey = captionTracks.find((track) => track.language === 'pt-BR')?.key || captionTracks[0]?.key || null
  return { captionTracks, primaryCaptionsKey }
}

async function enqueueCaptionJob(args: {
  assetId: string
  sourceKey: string | null
  outputPrefix: string
  createdBy: string | null
}) {
  const db = createSupabaseAdmin()
  if (!db) throw new Error('Supabase não configurado.')

  const captionQueueName = envText('VIDEO_CAPTIONS_QUEUE_NAME', 'legacy')
  const captionQueueStatus = envText(
    'VIDEO_CAPTIONS_QUEUE_STATUS',
    captionQueueName === 'legacy' ? 'queued_legacy' : 'queued',
  )

  const { data: existing, error: existingError } = await db
    .from('video_processing_jobs')
    .select('id')
    .eq('video_asset_id', args.assetId)
    .eq('job_type', 'captions')
    .in('status', ['queued', 'queued_legacy', 'processing'])
    .limit(1)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing?.id) return existing

  const { data, error } = await db
    .from('video_processing_jobs')
    .insert({
      video_asset_id: args.assetId,
      job_type: 'captions',
      status: captionQueueStatus,
      queue_name: captionQueueName,
      progress: 0,
      source_key: args.sourceKey,
      output_prefix: args.outputPrefix,
      current_stage: 'Aguardando legenda',
      created_by: args.createdBy,
    })
    .select('id')
    .single()

  if (error) throw error
  return data
}

function secondsFromFfmpegProgress(line: string) {
  const [key, value] = line.trim().split('=')
  if (!key || !value) return null

  if (key === 'out_time_ms' || key === 'out_time_us') {
    const raw = Number(value)
    return Number.isFinite(raw) && raw > 0 ? raw / 1_000_000 : null
  }

  if (key === 'out_time') {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
    if (!match) return null
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  }

  return null
}

function runFfmpegHls(args: {
  sourcePath: string
  hlsDir: string
  durationSeconds: number | null
  jobId: string
  onProgress?: (progress: number) => void
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const encoder = (process.env.VIDEO_HLS_ENCODER || 'libx264').trim().toLowerCase()
    const videoEncodingArgs = encoder === 'nvenc' || encoder === 'h264_nvenc'
      ? [
          '-c:v', 'h264_nvenc',
          '-preset', process.env.VIDEO_HLS_NVENC_PRESET || 'p4',
          '-cq', process.env.VIDEO_HLS_NVENC_CQ || '23',
          '-b:v', '0',
        ]
      : [
          '-c:v', 'libx264',
          '-preset', process.env.VIDEO_HLS_X264_PRESET || 'veryfast',
          '-crf', process.env.VIDEO_HLS_X264_CRF || '23',
        ]

    const child = spawn('ffmpeg', [
      '-y',
      '-i', args.sourcePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      ...videoEncodingArgs,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '8',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(args.hlsDir, 'segment-%05d.ts'),
      '-progress', 'pipe:1',
      '-nostats',
      path.join(args.hlsDir, 'index.m3u8'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let progressBuffer = ''
    let lastPersistedProgress = -1
    let lastPersistedAt = 0

    const persistProgress = (progress: number) => {
      const now = Date.now()
      const bounded = boundedPercent(progress)
      if (bounded <= lastPersistedProgress) return
      if (bounded - lastPersistedProgress < 2 && now - lastPersistedAt < 1800) return

      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded, current_stage: 'Convertendo vídeo HLS' }).catch(() => undefined)
      args.onProgress?.(bounded)
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      progressBuffer += text
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() || ''

      for (const line of lines) {
        const elapsed = secondsFromFfmpegProgress(line)
        if (elapsed == null || !args.durationSeconds) continue
        persistProgress((elapsed / args.durationSeconds) * 100)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr || stdout}`))
    })
  })
}

async function updateJob(jobId: string, patch: Record<string, unknown>) {
  const db = createSupabaseAdmin()
  if (!db) return
  await db.from('video_processing_jobs').update(patch).eq('id', jobId)
}

async function updateAsset(assetId: string, patch: Record<string, unknown>, options?: { ignoreError?: boolean }) {
  const db = createSupabaseAdmin()
  if (!db) return
  const { error } = await db.from('video_assets').update(patch).eq('id', assetId)
  if (error && !options?.ignoreError) throw error
}

function createDownloadProgressReporter(
  jobId: string,
  stage: string,
  notifyProgress: (stage: string, progress: number) => Promise<void>,
) {
  let lastProgress = -1
  let lastPersistedAt = 0

  return (event: R2DownloadProgress) => {
    const progress = boundedPercent(event.percent ?? 0)
    const now = Date.now()
    if (progress <= lastProgress && now - lastPersistedAt < 5000) return
    if (progress < 100 && progress - lastProgress < 2 && now - lastPersistedAt < 2500) return

    lastProgress = progress
    lastPersistedAt = now
    updateJob(jobId, { progress, current_stage: stage }).catch(() => undefined)
    notifyProgress(stage, progress).catch(() => undefined)
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listFilesRecursive(full)
    return [full]
  }))
  return files.flat()
}

async function readMediaMetadata(sourcePath: string) {
  try {
    const result = await runCommand('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      sourcePath,
    ])
    const parsed = JSON.parse(result.stdout)
    const videoStream = (parsed.streams || []).find((stream: any) => stream.codec_type === 'video')
    const duration = Number(parsed.format?.duration || videoStream?.duration || 0)
    return {
      duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: Number(videoStream?.width || 0) || null,
      height: Number(videoStream?.height || 0) || null,
    }
  } catch (error) {
    console.warn('[videos] ffprobe falhou:', error instanceof Error ? error.message : error)
    return { duration_seconds: null, width: null, height: null }
  }
}

async function r2ObjectExists(key: string, bucket: string | null) {
  try {
    await headR2Object(key, bucket)
    return true
  } catch {
    return false
  }
}

async function extractCaptionAudio(sourcePath: string, audioPath: string) {
  await mkdir(path.dirname(audioPath), { recursive: true })
  await runCommand('ffmpeg', [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    audioPath,
  ])
}

async function generateAndUploadCaptionAudio(args: {
  sourcePath: string
  tempDir: string
  outputPrefix: string
  bucket: string | null
}) {
  const key = captionAudioKeyFromPrefix(args.outputPrefix)
  const audioPath = path.join(args.tempDir, CAPTION_AUDIO_FILE_NAME)
  await extractCaptionAudio(args.sourcePath, audioPath)
  await uploadFileToR2(audioPath, key, 'audio/wav', args.bucket)
  return key
}

async function generatePoster(sourcePath: string, posterPath: string) {
  try {
    await runCommand('ffmpeg', [
      '-y',
      '-ss', '00:00:01',
      '-i', sourcePath,
      '-frames:v', '1',
      '-vf', 'scale=1280:-2',
      posterPath,
    ])
    return existsSync(posterPath)
  } catch (error) {
    console.warn('[videos] geração de poster falhou:', error instanceof Error ? error.message : error)
    return false
  }
}

async function generateStoryboard(sourcePath: string, storyboardPath: string, plan: StoryboardPlan) {
  try {
    const filter = [
      `fps=1/${plan.intervalSeconds}`,
      `scale=${plan.frameWidth}:${plan.frameHeight}:force_original_aspect_ratio=decrease`,
      `pad=${plan.frameWidth}:${plan.frameHeight}:(ow-iw)/2:(oh-ih)/2`,
      `tile=${plan.columns}x${plan.rows}`,
    ].join(',')

    await runCommand('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-an',
      '-vf', filter,
      '-frames:v', '1',
      '-q:v', '70',
      storyboardPath,
    ])
    return existsSync(storyboardPath)
  } catch (error) {
    console.warn('[videos] geração de storyboard falhou:', error instanceof Error ? error.message : error)
    return false
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  }))
}

function localSourceExtension(sourceKey: string) {
  const extension = path.extname(path.basename(sourceKey)).toLowerCase()
  return /^\.[a-z0-9]{2,8}$/.test(extension) ? extension : '.mp4'
}

function shouldGenerateStoryboard(video: VideoAsset) {
  if (!envFlag('VIDEO_STORYBOARD_ENABLED', true)) return false

  const maxSourceMb = Number(process.env.VIDEO_STORYBOARD_MAX_SOURCE_MB || 2048)
  const sourceSizeBytes = Number(video.source_size_bytes || 0)
  if (Number.isFinite(maxSourceMb) && maxSourceMb > 0 && sourceSizeBytes > maxSourceMb * 1024 * 1024) {
    return false
  }

  return true
}

function dirnameFromR2Key(key: string | null | undefined) {
  if (!key) return null
  const normalized = key.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : normalized
}

export async function processVideoCaptionsOnly(args: {
  assetId: string
  jobId: string
  userId: string | null
  onProgress?: (event: { stage: string; progress: number }) => void | Promise<void>
}) {
  const db = createSupabaseAdmin()
  if (!db) throw new Error('Supabase não configurado.')

  const { data: asset, error } = await db
    .from('video_assets')
    .select('*')
    .eq('id', args.assetId)
    .single()

  if (error || !asset) throw new Error(error?.message || 'Vídeo não encontrado.')
  const video = asset as VideoAsset
  if (!video.hls_manifest_key) throw new Error('Vídeo ainda não tem HLS pronto.')

  const outputPrefix = video.hls_prefix || dirnameFromR2Key(video.hls_manifest_key) || `videos/${video.id}/hls`
  const bucket = video.source_bucket || null
  const preparedAudioKey = captionAudioKeyFromPrefix(outputPrefix)
  let tempDir: string | null = null
  let lastPersistedStage = ''
  let lastPersistedProgress = -1
  let lastPersistedAt = 0

  const notifyProgress = async (stage: string, progress: number) => {
    const bounded = boundedPercent(progress)
    const now = Date.now()
    if (stage !== lastPersistedStage || bounded !== lastPersistedProgress || now - lastPersistedAt > 5000) {
      lastPersistedStage = stage
      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded, current_stage: stage }).catch(() => undefined)
    }
    try {
      await args.onProgress?.({ stage, progress: bounded })
    } catch {
      /* progresso externo nao deve quebrar processamento */
    }
  }

  await updateJob(args.jobId, {
    status: 'processing',
    progress: 0,
    source_key: video.source_key,
    output_prefix: outputPrefix,
    started_at: new Date().toISOString(),
    current_stage: 'Preparando legendas',
    error_message: null,
  })
  await notifyProgress('Preparando legendas', 0)

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hub-video-captions-'))
    const hasPreparedAudio = await r2ObjectExists(preparedAudioKey, bucket)
    const sourcePath = hasPreparedAudio
      ? path.join(tempDir, CAPTION_AUDIO_FILE_NAME)
      : path.join(tempDir, `source${localSourceExtension(video.source_key || '')}`)

    if (hasPreparedAudio) {
      await updateJob(args.jobId, { progress: 0, current_stage: 'Baixando áudio leve do R2' })
      await notifyProgress('Baixando áudio leve do R2', 0)
      await downloadObjectToFileWithProgress(
        preparedAudioKey,
        sourcePath,
        bucket,
        createDownloadProgressReporter(args.jobId, 'Baixando áudio leve do R2', notifyProgress),
      )
    } else {
      if (!video.source_key) throw new Error('Vídeo sem arquivo original ou áudio leve no R2.')
      await updateJob(args.jobId, { progress: 0, current_stage: 'Baixando original do R2' })
      await notifyProgress('Baixando original do R2', 0)
      await downloadObjectToFileWithProgress(
        video.source_key,
        sourcePath,
        bucket,
        createDownloadProgressReporter(args.jobId, 'Baixando original do R2', notifyProgress),
      )
    }

    await updateJob(args.jobId, { progress: 0, current_stage: 'Extraindo áudio da legenda' })
    await notifyProgress('Extraindo áudio da legenda', 0)
    const { captionTracks, primaryCaptionsKey } = await generateAndUploadCaptionTracks({
      sourcePath,
      tempDir,
      outputPrefix,
      bucket,
      resultDirName: 'captions-only',
      onProgress: (stage, progress) => {
        notifyProgress(stage, progress).catch(() => undefined)
      },
    })

    if (captionTracks.length === 0 || !primaryCaptionsKey) {
      throw new Error('Nenhuma legenda foi gerada.')
    }

    await notifyProgress('Legendas enviadas para R2', 100)
    await updateAsset(video.id, {
      captions_key: primaryCaptionsKey,
      caption_tracks: captionTracks,
      last_error: null,
      updated_by: args.userId,
    })

    await updateJob(args.jobId, {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
      current_stage: 'Legendas concluídas',
    })
    await notifyProgress('Legendas concluídas', 100)

    return { captionTracks }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateJob(args.jobId, {
      status: 'failed',
      progress: 100,
      error_message: message,
      completed_at: new Date().toISOString(),
      current_stage: 'erro nas legendas',
    })
    await updateAsset(video.id, {
      last_error: message,
      updated_by: args.userId,
    }, { ignoreError: true })
    throw error
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function processVideoToHls(args: {
  assetId: string
  jobId: string
  userId: string | null
  localSourcePath?: string | null
  onProgress?: (event: { stage: string; progress: number }) => void | Promise<void>
}) {
  const db = createSupabaseAdmin()
  if (!db) throw new Error('Supabase não configurado.')

  const { data: asset, error } = await db
    .from('video_assets')
    .select('*')
    .eq('id', args.assetId)
    .single()

  if (error || !asset) throw new Error(error?.message || 'Vídeo não encontrado.')
  const video = asset as VideoAsset
  if (!video.source_key) throw new Error('Vídeo sem arquivo original no R2.')

  const outputPrefix = video.hls_prefix || `videos/${video.id}/hls`
  const manifestKey = `${outputPrefix}/index.m3u8`
  const posterKey = `${outputPrefix}/poster.jpg`
  const storyboardKey = `${outputPrefix}/storyboard.webp`
  const metadataKey = `${outputPrefix}/metadata.json`
  const bucket = video.source_bucket || null
  let tempDir: string | null = null
  let hlsPersisted = Boolean(video.hls_manifest_key)
  let lastPersistedStage = ''
  let lastPersistedProgress = -1
  let lastPersistedAt = 0

  const notifyProgress = async (stage: string, progress: number) => {
    const bounded = boundedPercent(progress)
    const now = Date.now()
    if (stage !== lastPersistedStage || bounded !== lastPersistedProgress || now - lastPersistedAt > 5000) {
      lastPersistedStage = stage
      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded, current_stage: stage }).catch(() => undefined)
    }
    try {
      await args.onProgress?.({ stage, progress: bounded })
    } catch {
      /* progresso externo nao deve quebrar processamento */
    }
  }

  await updateAsset(video.id, { status: 'processing', last_error: null, updated_by: args.userId })
  await updateJob(args.jobId, {
    status: 'processing',
    progress: 0,
    source_key: video.source_key,
    output_prefix: outputPrefix,
    started_at: new Date().toISOString(),
    current_stage: 'Preparando vídeo',
    error_message: null,
  })
  await notifyProgress('Preparando vídeo', 0)

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hub-video-'))
    const sourcePath = args.localSourcePath || path.join(tempDir, `source${localSourceExtension(video.source_key)}`)
    const hlsDir = path.join(tempDir, 'hls')
    const posterPath = path.join(tempDir, 'poster.jpg')
    const storyboardPath = path.join(tempDir, 'storyboard.webp')

    if (args.localSourcePath) {
      await updateJob(args.jobId, { progress: 100, current_stage: 'Usando original temporário' })
      await notifyProgress('Usando original temporário', 100)
    } else {
      await updateJob(args.jobId, { progress: 0, current_stage: 'Baixando original do R2' })
      await notifyProgress('Baixando original do R2', 0)
      await downloadObjectToFileWithProgress(
        video.source_key,
        sourcePath,
        bucket,
        createDownloadProgressReporter(args.jobId, 'Baixando original do R2', notifyProgress),
      )
    }

    await updateJob(args.jobId, { progress: 0, current_stage: 'Gerando preview rápido' })
    await notifyProgress('Gerando preview rápido', 0)
    const metadata = await readMediaMetadata(sourcePath)
    const posterCreated = await generatePoster(sourcePath, posterPath)
    const storyboardPlan = shouldGenerateStoryboard(video)
      ? buildStoryboardPlan({
          durationSeconds: metadata.duration_seconds,
          width: metadata.width,
          height: metadata.height,
          maxFrames: Number(process.env.VIDEO_STORYBOARD_MAX_FRAMES || 120),
          frameWidth: Number(process.env.VIDEO_STORYBOARD_FRAME_WIDTH || 240),
          columns: Number(process.env.VIDEO_STORYBOARD_COLUMNS || 5),
        })
      : null
    const storyboardCreated = storyboardPlan
      ? await generateStoryboard(sourcePath, storyboardPath, storyboardPlan)
      : false

    await updateJob(args.jobId, { progress: 0, current_stage: 'Convertendo vídeo HLS' })
    await notifyProgress('Convertendo vídeo HLS', 0)
    await mkdir(hlsDir, { recursive: true })
    await runFfmpegHls({
      sourcePath,
      hlsDir,
      durationSeconds: metadata.duration_seconds,
      jobId: args.jobId,
      onProgress: (progress) => {
        notifyProgress('Convertendo vídeo HLS', progress).catch(() => undefined)
      },
    })

    await updateJob(args.jobId, { progress: 0, current_stage: 'Enviando HLS para R2' })
    await notifyProgress('Enviando HLS para R2', 0)
    const hlsFiles = await listFilesRecursive(hlsDir)
    let uploadedHlsFiles = 0
    const hlsUploadConcurrency = Math.max(1, Number(process.env.VIDEO_HLS_UPLOAD_CONCURRENCY || 4))
    await mapWithConcurrency(hlsFiles, hlsUploadConcurrency, async (file) => {
      const relative = path.relative(hlsDir, file).split(path.sep).join('/')
      await uploadFileToR2(file, `${outputPrefix}/${relative}`, guessContentType(relative), bucket)
      uploadedHlsFiles += 1
      await notifyProgress('Enviando HLS para R2', Math.round((uploadedHlsFiles / Math.max(hlsFiles.length, 1)) * 100))
    })

    let finalPosterKey: string | null = null
    if (posterCreated) {
      await uploadFileToR2(posterPath, posterKey, 'image/jpeg', bucket)
      finalPosterKey = posterKey
    }
    let finalStoryboardKey: string | null = null
    if (storyboardCreated && storyboardPlan) {
      await uploadFileToR2(storyboardPath, storyboardKey, 'image/webp', bucket)
      finalStoryboardKey = storyboardKey
    }

    await writeJsonMetadata(metadataKey, {
      assetId: video.id,
      title: video.title,
      sourceKey: video.source_key,
      manifestKey,
      posterKey: finalPosterKey,
      storyboardKey: finalStoryboardKey,
      storyboard: finalStoryboardKey && storyboardPlan ? storyboardPlan : null,
      captionTracks: [],
      processedAt: new Date().toISOString(),
      ...metadata,
    }, bucket)

    await updateAsset(video.id, {
      status: 'ready',
      hls_prefix: outputPrefix,
      hls_manifest_key: manifestKey,
      poster_key: finalPosterKey,
      duration_seconds: metadata.duration_seconds,
      width: metadata.width,
      height: metadata.height,
      processed_at: new Date().toISOString(),
      last_error: null,
      updated_by: args.userId,
    })
    await updateAsset(video.id, {
      storyboard_key: finalStoryboardKey,
      storyboard_interval_seconds: storyboardPlan?.intervalSeconds || null,
      storyboard_columns: storyboardPlan?.columns || null,
      storyboard_rows: storyboardPlan?.rows || null,
      storyboard_frame_width: storyboardPlan?.frameWidth || null,
      storyboard_frame_height: storyboardPlan?.frameHeight || null,
      storyboard_frame_count: storyboardPlan?.frameCount || null,
    }, { ignoreError: true })
    hlsPersisted = true

    let primaryCaptionsKey: string | null = null
    let captionTracks: StoredCaptionTrack[] = []
    const captionsEnabled = envFlag('VIDEO_CAPTIONS_ENABLED', false)
    const captionsInline = envFlag('VIDEO_CAPTIONS_INLINE', false)
    let captionAudioKey: string | null = null
    let captionAudioError: string | null = null
    if (captionsEnabled) {
      try {
        await updateJob(args.jobId, { progress: 100, current_stage: 'Extraindo áudio leve para legenda' })
        await notifyProgress('Extraindo áudio leve para legenda', 100)
        captionAudioKey = await generateAndUploadCaptionAudio({
          sourcePath,
          tempDir,
          outputPrefix,
          bucket,
        })
      } catch (error) {
        captionAudioError = error instanceof Error ? error.message : String(error)
        console.warn('[videos] extração do áudio leve da legenda falhou:', captionAudioError)
      }
    }
    let captionsQueued = false
    if (captionsEnabled && captionsInline) {
      await updateJob(args.jobId, { progress: 0, current_stage: 'HLS pronto; extraindo áudio da legenda' })
      await notifyProgress('Extraindo áudio da legenda', 0)

      const captionsResult = await generateAndUploadCaptionTracks({
        sourcePath,
        tempDir,
        outputPrefix,
        bucket,
        onProgress: (stage, progress) => {
          notifyProgress(stage, progress).catch(() => undefined)
        },
      })

      captionTracks = captionsResult.captionTracks
      primaryCaptionsKey = captionsResult.primaryCaptionsKey
      await notifyProgress('Legendas enviadas para R2', 100)
    } else if (captionsEnabled) {
      await enqueueCaptionJob({
        assetId: video.id,
        sourceKey: video.source_key,
        outputPrefix,
        createdBy: args.userId,
      })
      captionsQueued = true
      await notifyProgress('Vídeo pronto; legenda entrou na fila', 100)
    }

    await notifyProgress(
      captionsInline && captionTracks.length > 0
        ? 'Legendas concluídas'
        : captionsQueued
          ? 'Vídeo pronto; legenda entrou na fila'
          : 'Vídeo pronto; legendas ficam para depois',
      100,
    )

    await writeJsonMetadata(metadataKey, {
      assetId: video.id,
      title: video.title,
      sourceKey: video.source_key,
      manifestKey,
      posterKey: finalPosterKey,
      storyboardKey: finalStoryboardKey,
      storyboard: finalStoryboardKey && storyboardPlan ? storyboardPlan : null,
      captionAudioKey,
      captionAudioError,
      captionTracks,
      processedAt: new Date().toISOString(),
      ...metadata,
    }, bucket)

    await updateJob(args.jobId, {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
      current_stage: captionsQueued ? 'HLS concluído; legenda na fila' : 'Concluído',
    })
    await notifyProgress('Concluído', 100)

    await updateAsset(video.id, {
      status: 'ready',
      hls_prefix: outputPrefix,
      hls_manifest_key: manifestKey,
      poster_key: finalPosterKey,
      ...(captionTracks.length > 0 ? {
        captions_key: primaryCaptionsKey,
        caption_tracks: captionTracks,
      } : {}),
      duration_seconds: metadata.duration_seconds,
      width: metadata.width,
      height: metadata.height,
      processed_at: new Date().toISOString(),
      last_error: null,
      updated_by: args.userId,
    })
    await updateAsset(video.id, {
      storyboard_key: finalStoryboardKey,
      storyboard_interval_seconds: storyboardPlan?.intervalSeconds || null,
      storyboard_columns: storyboardPlan?.columns || null,
      storyboard_rows: storyboardPlan?.rows || null,
      storyboard_frame_width: storyboardPlan?.frameWidth || null,
      storyboard_frame_height: storyboardPlan?.frameHeight || null,
      storyboard_frame_count: storyboardPlan?.frameCount || null,
    }, { ignoreError: true })

    return { manifestKey, posterKey: finalPosterKey, metadata }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateJob(args.jobId, {
      status: 'failed',
      progress: 100,
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    await updateAsset(video.id, {
      status: hlsPersisted ? 'ready' : 'failed',
      last_error: message,
      updated_by: args.userId,
    })
    throw error
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
