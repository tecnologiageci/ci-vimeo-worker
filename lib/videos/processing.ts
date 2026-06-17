import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import {
  downloadObjectToFile,
  getObjectText,
  guessContentType,
  uploadBufferToR2,
  sanitizeFileSegment,
  uploadFileToR2,
  writeJsonMetadata,
} from './r2'
import { buildStoryboardPlan, type StoryboardPlan } from './storyboard'
import type { VideoAsset } from './types'

interface RunResult {
  stdout: string
  stderr: string
}

type AbortSignalCheck = () => boolean | Promise<boolean>

type MediaMetadata = {
  duration_seconds: number | null
  width: number | null
  height: number | null
}

type HlsOutputVariant = {
  label: string
  directory: string
  playlist: string
  width: number | null
  height: number | null
  bandwidth: number
}

export class VideoProcessingCancelledError extends Error {
  constructor(message = 'Processamento pausado pela interface.') {
    super(message)
    this.name = 'VideoProcessingCancelledError'
  }
}

function isVideoProcessingCancelled(error: unknown) {
  return error instanceof VideoProcessingCancelledError
    || (error instanceof Error && error.name === 'VideoProcessingCancelledError')
}

async function throwIfAbortRequested(shouldAbort?: AbortSignalCheck) {
  if (!shouldAbort) return
  if (await shouldAbort()) throw new VideoProcessingCancelledError()
}

function resolveBinary(command: 'ffmpeg' | 'ffprobe') {
  const envKey = command === 'ffmpeg' ? 'VIDEO_FFMPEG_PATH' : 'VIDEO_FFPROBE_PATH'
  const configured = process.env[envKey]?.trim()
  if (configured) return configured

  const commonPaths = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `/usr/bin/${command}`,
    `C:\\ffmpeg\\bin\\${command}.exe`,
  ]
  return commonPaths.find((candidate) => existsSync(candidate)) || command
}

function runCommand(command: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const binary = command === 'ffmpeg' || command === 'ffprobe' ? resolveBinary(command) : command
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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

function hlsVideoEncodingArgs() {
  const encoder = (process.env.VIDEO_HLS_ENCODER || 'libx264').trim().toLowerCase()
  if (encoder === 'nvenc' || encoder === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', process.env.VIDEO_HLS_NVENC_PRESET || 'p4',
      '-cq', process.env.VIDEO_HLS_NVENC_CQ || '23',
      '-b:v', '0',
    ]
  }

  return [
    '-c:v', 'libx264',
    '-preset', process.env.VIDEO_HLS_X264_PRESET || 'veryfast',
    '-crf', process.env.VIDEO_HLS_X264_CRF || '23',
  ]
}

function hlsMaxHeight() {
  const configured = Number(process.env.VIDEO_HLS_MAX_HEIGHT || 720)
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 720
}

function evenDimension(value: number) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

function estimateVariantBandwidth(height: number | null, width: number | null) {
  if (!height || !width) return 2_800_000
  if (height >= 1000 || width >= 1900) return 5_500_000
  if (height >= 700 || width >= 1200) return 2_800_000
  if (height >= 530 || width >= 900) return 1_800_000
  if (height >= 470 || width >= 800) return 1_250_000
  if (height >= 350 || width >= 600) return 850_000
  return 500_000
}

function buildHlsOutputVariant(metadata: MediaMetadata): HlsOutputVariant {
  const maxHeight = hlsMaxHeight()
  const sourceWidth = Number(metadata.width || 0) || null
  const sourceHeight = Number(metadata.height || 0) || null

  if (!sourceWidth || !sourceHeight) {
    return {
      label: `${maxHeight}p`,
      directory: `${maxHeight}p`,
      playlist: `${maxHeight}p/index.m3u8`,
      width: null,
      height: maxHeight,
      bandwidth: estimateVariantBandwidth(maxHeight, null),
    }
  }

  const outputHeight = evenDimension(Math.min(sourceHeight, maxHeight))
  const outputWidth = evenDimension((sourceWidth * outputHeight) / sourceHeight)
  const label = `${outputHeight}p`

  return {
    label,
    directory: label,
    playlist: `${label}/index.m3u8`,
    width: outputWidth,
    height: outputHeight,
    bandwidth: estimateVariantBandwidth(outputHeight, outputWidth),
  }
}

function build720OutputVariant(metadata: MediaMetadata): HlsOutputVariant {
  const sourceWidth = Number(metadata.width || 0) || null
  const sourceHeight = Number(metadata.height || 0) || null

  if (!sourceWidth || !sourceHeight) {
    return {
      label: '720p',
      directory: '720p',
      playlist: '720p/index.m3u8',
      width: null,
      height: 720,
      bandwidth: estimateVariantBandwidth(720, null),
    }
  }

  const outputHeight = evenDimension(Math.min(sourceHeight, 720))
  const outputWidth = evenDimension((sourceWidth * outputHeight) / sourceHeight)
  const label = `${outputHeight}p`

  return {
    label,
    directory: label,
    playlist: `${label}/index.m3u8`,
    width: outputWidth,
    height: outputHeight,
    bandwidth: estimateVariantBandwidth(outputHeight, outputWidth),
  }
}

function hlsScaleFilter() {
  const maxHeight = hlsMaxHeight()
  return `scale=-2:'trunc(min(${maxHeight},ih)/2)*2'`
}

function buildMasterPlaylist(variants: HlsOutputVariant[]) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ]

  for (const variant of variants) {
    const attrs = [
      `BANDWIDTH=${variant.bandwidth}`,
      `AVERAGE-BANDWIDTH=${Math.round(variant.bandwidth * 0.82)}`,
      `NAME="${variant.label}"`,
    ]
    if (variant.width && variant.height) attrs.push(`RESOLUTION=${variant.width}x${variant.height}`)
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`)
    lines.push(variant.playlist)
  }

  return `${lines.join('\n')}\n`
}

function buildVariantStreamInfo(variant: HlsOutputVariant) {
  const attrs = [
    `BANDWIDTH=${variant.bandwidth}`,
    `AVERAGE-BANDWIDTH=${Math.round(variant.bandwidth * 0.82)}`,
    `NAME="${variant.label}"`,
  ]
  if (variant.width && variant.height) attrs.push(`RESOLUTION=${variant.width}x${variant.height}`)
  return [`#EXT-X-STREAM-INF:${attrs.join(',')}`, variant.playlist]
}

function appendVariantToMasterPlaylist(master: string, variant: HlsOutputVariant) {
  const trimmed = master.trimEnd()
  if (trimmed.includes(variant.playlist)) return `${trimmed}\n`
  return `${trimmed}\n${buildVariantStreamInfo(variant).join('\n')}\n`
}

function buildLegacyMasterPlaylist(args: {
  originalLabel: string
  originalPlaylist: string
  originalWidth: number | null
  originalHeight: number | null
  variant: HlsOutputVariant
}) {
  return `${[
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    ...buildVariantStreamInfo({
      label: args.originalLabel,
      directory: '',
      playlist: args.originalPlaylist,
      width: args.originalWidth,
      height: args.originalHeight,
      bandwidth: estimateVariantBandwidth(args.originalHeight, args.originalWidth),
    }),
    ...buildVariantStreamInfo(args.variant),
  ].join('\n')}\n`
}

async function runFfmpegHls(args: {
  sourcePath: string
  hlsDir: string
  metadata: MediaMetadata
  durationSeconds: number | null
  jobId: string
  onProgress?: (progress: number) => void
  shouldAbort?: AbortSignalCheck
}): Promise<RunResult> {
  const variant = buildHlsOutputVariant(args.metadata)
  const variantDir = path.join(args.hlsDir, variant.directory)
  await mkdir(variantDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const videoEncodingArgs = hlsVideoEncodingArgs()
    const child = spawn(resolveBinary('ffmpeg'), [
      '-y',
      '-i', args.sourcePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-vf', hlsScaleFilter(),
      ...videoEncodingArgs,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '8',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(variantDir, 'segment-%05d.ts'),
      '-progress', 'pipe:1',
      '-nostats',
      path.join(variantDir, 'index.m3u8'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let progressBuffer = ''
    let lastPersistedProgress = 36
    let lastPersistedAt = 0
    let aborting = false
    let abortKillTimer: NodeJS.Timeout | null = null

    const requestAbortIfNeeded = async () => {
      if (!args.shouldAbort || aborting) return
      try {
        if (!(await args.shouldAbort())) return
        aborting = true
        child.kill('SIGTERM')
        abortKillTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
      } catch {
        /* falha ao consultar pausa nao deve derrubar o ffmpeg */
      }
    }

    const abortTimer = args.shouldAbort
      ? setInterval(() => {
        void requestAbortIfNeeded()
      }, 2000)
      : null
    void requestAbortIfNeeded()

    const clearAbortTimers = () => {
      if (abortTimer) clearInterval(abortTimer)
      if (abortKillTimer) clearTimeout(abortKillTimer)
    }

    const persistProgress = (progress: number) => {
      const now = Date.now()
      const bounded = Math.max(37, Math.min(74, Math.round(progress)))
      if (bounded <= lastPersistedProgress) return
      if (bounded - lastPersistedProgress < 2 && now - lastPersistedAt < 1800) return

      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded }).catch(() => undefined)
      args.onProgress?.(bounded)
      void requestAbortIfNeeded()
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
        persistProgress(36 + (elapsed / args.durationSeconds) * 38)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearAbortTimers()
      reject(aborting ? new VideoProcessingCancelledError() : error)
    })
    child.on('close', (code) => {
      clearAbortTimers()
      if (aborting) return reject(new VideoProcessingCancelledError())
      if (code === 0) {
        writeFile(path.join(args.hlsDir, 'index.m3u8'), buildMasterPlaylist([variant]), 'utf8')
          .then(() => resolve({ stdout, stderr }))
          .catch(reject)
        return
      }
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr || stdout}`))
    })
  })
}

async function runFfmpegHls720Variant(args: {
  sourcePath: string
  variantDir: string
  durationSeconds: number | null
  jobId: string
  onProgress?: (progress: number) => void
  shouldAbort?: AbortSignalCheck
}): Promise<RunResult> {
  await mkdir(args.variantDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const videoEncodingArgs = hlsVideoEncodingArgs()
    const child = spawn(resolveBinary('ffmpeg'), [
      '-y',
      '-i', args.sourcePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-vf', "scale=-2:'trunc(min(720,ih)/2)*2'",
      ...videoEncodingArgs,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '8',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(args.variantDir, 'segment-%05d.ts'),
      '-progress', 'pipe:1',
      '-nostats',
      path.join(args.variantDir, 'index.m3u8'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let progressBuffer = ''
    let lastPersistedProgress = 30
    let lastPersistedAt = 0
    let aborting = false
    let abortKillTimer: NodeJS.Timeout | null = null

    const requestAbortIfNeeded = async () => {
      if (!args.shouldAbort || aborting) return
      try {
        if (!(await args.shouldAbort())) return
        aborting = true
        child.kill('SIGTERM')
        abortKillTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
      } catch {
        /* falha ao consultar pausa nao deve derrubar o ffmpeg */
      }
    }

    const abortTimer = args.shouldAbort
      ? setInterval(() => {
        void requestAbortIfNeeded()
      }, 2000)
      : null
    void requestAbortIfNeeded()

    const clearAbortTimers = () => {
      if (abortTimer) clearInterval(abortTimer)
      if (abortKillTimer) clearTimeout(abortKillTimer)
    }

    const persistProgress = (progress: number) => {
      const now = Date.now()
      const bounded = Math.max(31, Math.min(82, Math.round(progress)))
      if (bounded <= lastPersistedProgress) return
      if (bounded - lastPersistedProgress < 2 && now - lastPersistedAt < 1800) return

      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded }).catch(() => undefined)
      args.onProgress?.(bounded)
      void requestAbortIfNeeded()
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
        persistProgress(30 + (elapsed / args.durationSeconds) * 52)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearAbortTimers()
      reject(aborting ? new VideoProcessingCancelledError() : error)
    })
    child.on('close', (code) => {
      clearAbortTimers()
      if (aborting) return reject(new VideoProcessingCancelledError())
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`ffmpeg saiu com código ${code}: ${stderr || stdout}`))
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

function extensionForContentType(contentType: string | null | undefined) {
  const lower = (contentType || '').toLowerCase()
  if (lower.includes('webm')) return '.webm'
  if (lower.includes('quicktime') || lower.includes('mov')) return '.mov'
  return '.mp4'
}

function dirnameFromR2Key(key: string | null | undefined) {
  if (!key) return null
  const normalized = key.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : normalized
}

function buildLocalSourceFileName(video: VideoAsset) {
  const sourceName = video.source_file_name || path.basename(video.source_key || '') || `video-${video.id}`
  const rawExt = path.extname(sourceName)
  const hasUsableExtension = Boolean(rawExt && rawExt !== '.')
  const baseName = hasUsableExtension ? path.basename(sourceName, rawExt) : sourceName
  const base = sanitizeFileSegment(baseName)
  const ext = hasUsableExtension ? rawExt.toLowerCase() : extensionForContentType(video.source_content_type)
  return `${base}${ext}`
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

async function generateStoryboardStrict(sourcePath: string, storyboardPath: string, plan: StoryboardPlan) {
  const created = await generateStoryboard(sourcePath, storyboardPath, plan)
  if (!created) throw new Error('ffmpeg terminou sem criar storyboard.')
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

export async function processVideoStoryboardOnly(args: {
  assetId: string
  jobId: string
  userId: string | null
  shouldAbort?: AbortSignalCheck
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
  if (!video.hls_manifest_key) throw new Error('Vídeo ainda não tem HLS pronto.')

  const outputPrefix = video.hls_prefix || dirnameFromR2Key(video.hls_manifest_key) || `videos/${video.id}/hls`
  const storyboardKey = `${outputPrefix}/storyboard.webp`
  const bucket = video.source_bucket || null
  let tempDir: string | null = null

  const notifyProgress = async (stage: string, progress: number) => {
    await throwIfAbortRequested(args.shouldAbort)
    const bounded = Math.max(0, Math.min(100, Math.round(progress)))
    await updateJob(args.jobId, { progress: bounded, current_stage: stage })
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
    current_stage: 'Preparando preview rapido',
    error_message: null,
  })

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hub-video-storyboard-'))
    const sourcePath = path.join(tempDir, buildLocalSourceFileName(video))
    const storyboardPath = path.join(tempDir, 'storyboard.webp')

    await notifyProgress('Baixando original para preview rapido', 10)
    await downloadObjectToFile(video.source_key, sourcePath, bucket)
    await throwIfAbortRequested(args.shouldAbort)

    await notifyProgress('Lendo metadados do preview rapido', 30)
    const metadata = await readMediaMetadata(sourcePath)
    const storyboardPlan = buildStoryboardPlan({
      durationSeconds: metadata.duration_seconds || video.duration_seconds,
      width: metadata.width || video.width,
      height: metadata.height || video.height,
      maxFrames: Number(process.env.VIDEO_STORYBOARD_MAX_FRAMES || 120),
      frameWidth: Number(process.env.VIDEO_STORYBOARD_FRAME_WIDTH || 240),
      columns: Number(process.env.VIDEO_STORYBOARD_COLUMNS || 5),
    })
    if (!storyboardPlan) throw new Error('Metadata insuficiente para gerar preview rapido.')

    await notifyProgress('Gerando preview rapido', 55)
    await generateStoryboardStrict(sourcePath, storyboardPath, storyboardPlan)
    await throwIfAbortRequested(args.shouldAbort)

    await notifyProgress('Enviando preview rapido para R2', 90)
    await uploadFileToR2(storyboardPath, storyboardKey, 'image/webp', bucket)
    await throwIfAbortRequested(args.shouldAbort)

    await updateAsset(video.id, {
      storyboard_key: storyboardKey,
      storyboard_interval_seconds: storyboardPlan.intervalSeconds,
      storyboard_columns: storyboardPlan.columns,
      storyboard_rows: storyboardPlan.rows,
      storyboard_frame_width: storyboardPlan.frameWidth,
      storyboard_frame_height: storyboardPlan.frameHeight,
      storyboard_frame_count: storyboardPlan.frameCount,
      last_error: null,
      updated_by: args.userId,
    }, { ignoreError: true })

    await updateJob(args.jobId, {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
      current_stage: 'Preview rapido concluido',
    })
    await notifyProgress('Preview rapido concluido', 100)

    return { storyboardKey, storyboard: storyboardPlan, metadata }
  } catch (error) {
    if (isVideoProcessingCancelled(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    await updateJob(args.jobId, {
      status: 'failed',
      progress: 100,
      error_message: message,
      completed_at: new Date().toISOString(),
      current_stage: 'erro no preview rapido',
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

export async function processVideoHls720Variant(args: {
  assetId: string
  jobId: string
  userId: string | null
  shouldAbort?: AbortSignalCheck
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
  if (!video.hls_manifest_key) throw new Error('Vídeo ainda não tem HLS pronto.')

  const sourceHeight = Number(video.height || 0) || null
  const sourceWidth = Number(video.width || 0) || null
  const outputPrefix = video.hls_prefix || dirnameFromR2Key(video.hls_manifest_key) || `videos/${video.id}/hls`
  const bucket = video.source_bucket || null
  let tempDir: string | null = null

  const notifyProgress = async (stage: string, progress: number) => {
    await throwIfAbortRequested(args.shouldAbort)
    const bounded = Math.max(0, Math.min(100, Math.round(progress)))
    await updateJob(args.jobId, { progress: bounded, current_stage: stage })
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
    current_stage: 'Preparando variante 720p',
    error_message: null,
  })

  try {
    await notifyProgress('Lendo playlist HLS atual', 5)
    const currentManifest = await getObjectText(video.hls_manifest_key, bucket)
    if (currentManifest.includes('#EXT-X-STREAM-INF') && currentManifest.includes('720p/index.m3u8')) {
      await updateJob(args.jobId, {
        status: 'completed',
        progress: 100,
        completed_at: new Date().toISOString(),
        current_stage: '720p ja estava disponivel',
      })
      await notifyProgress('720p ja estava disponivel', 100)
      return { skipped: true, reason: 'ja_tem_720' }
    }

    if (sourceHeight && sourceHeight <= 720) {
      await updateJob(args.jobId, {
        status: 'completed',
        progress: 100,
        completed_at: new Date().toISOString(),
        current_stage: 'Video ja esta em 720p ou menor',
      })
      await notifyProgress('Video ja esta em 720p ou menor', 100)
      return { skipped: true, reason: 'ja_720_ou_menor' }
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hub-hls-720-'))
    const sourcePath = path.join(tempDir, buildLocalSourceFileName(video))
    const variant = build720OutputVariant({
      duration_seconds: video.duration_seconds,
      width: sourceWidth,
      height: sourceHeight,
    })
    const variantDir = path.join(tempDir, variant.directory)

    await notifyProgress('Baixando original para gerar 720p', 12)
    await downloadObjectToFile(video.source_key, sourcePath, bucket)
    await throwIfAbortRequested(args.shouldAbort)

    await notifyProgress('Convertendo variante 720p', 30)
    await runFfmpegHls720Variant({
      sourcePath,
      variantDir,
      durationSeconds: video.duration_seconds,
      jobId: args.jobId,
      shouldAbort: args.shouldAbort,
      onProgress: (progress) => {
        notifyProgress('Convertendo variante 720p', progress).catch(() => undefined)
      },
    })
    await throwIfAbortRequested(args.shouldAbort)

    await notifyProgress('Enviando 720p para R2', 84)
    const variantFiles = await listFilesRecursive(variantDir)
    let uploadedFiles = 0
    const uploadConcurrency = Math.max(1, Number(process.env.VIDEO_HLS_UPLOAD_CONCURRENCY || 4))
    await mapWithConcurrency(variantFiles, uploadConcurrency, async (file) => {
      const relative = path.relative(tempDir!, file).split(path.sep).join('/')
      await uploadFileToR2(file, `${outputPrefix}/${relative}`, guessContentType(relative), bucket)
      uploadedFiles += 1
      await notifyProgress('Enviando 720p para R2', Math.round(84 + (uploadedFiles / Math.max(variantFiles.length, 1)) * 10))
    })
    await throwIfAbortRequested(args.shouldAbort)

    await notifyProgress('Atualizando seletor de qualidade', 96)
    let nextManifest = ''
    if (currentManifest.includes('#EXT-X-STREAM-INF')) {
      nextManifest = appendVariantToMasterPlaylist(currentManifest, variant)
    } else {
      const originalHeight = sourceHeight || 1080
      const originalPlaylist = `${originalHeight}p.m3u8`
      await uploadBufferToR2(
        currentManifest,
        `${outputPrefix}/${originalPlaylist}`,
        'application/vnd.apple.mpegurl; charset=utf-8',
        bucket,
      )
      nextManifest = buildLegacyMasterPlaylist({
        originalLabel: `${originalHeight}p`,
        originalPlaylist,
        originalWidth: sourceWidth,
        originalHeight: sourceHeight,
        variant,
      })
    }

    await uploadBufferToR2(nextManifest, video.hls_manifest_key, 'application/vnd.apple.mpegurl; charset=utf-8', bucket)

    await updateAsset(video.id, {
      last_error: null,
      updated_by: args.userId,
    }, { ignoreError: true })
    await updateJob(args.jobId, {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
      current_stage: '720p concluido',
    })
    await notifyProgress('720p concluido', 100)

    return { skipped: false, reason: 'ok', variant }
  } catch (error) {
    if (isVideoProcessingCancelled(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    await updateJob(args.jobId, {
      status: 'failed',
      progress: 100,
      error_message: message,
      completed_at: new Date().toISOString(),
      current_stage: 'erro na variante 720p',
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
  shouldAbort?: AbortSignalCheck
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

  const notifyProgress = async (stage: string, progress: number) => {
    await throwIfAbortRequested(args.shouldAbort)
    try {
      await args.onProgress?.({ stage, progress })
    } catch {
      /* progresso externo nao deve quebrar processamento */
    }
  }

  await updateAsset(video.id, { status: 'processing', last_error: null, updated_by: args.userId })
  await updateJob(args.jobId, {
    status: 'processing',
    progress: 5,
    source_key: video.source_key,
    output_prefix: outputPrefix,
    started_at: new Date().toISOString(),
    error_message: null,
  })
  await notifyProgress('preparando', 5)

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hub-video-'))
    const sourcePath = args.localSourcePath || path.join(tempDir, buildLocalSourceFileName(video))
    const hlsDir = path.join(tempDir, 'hls')
    const posterPath = path.join(tempDir, 'poster.jpg')
    const storyboardPath = path.join(tempDir, 'storyboard.webp')

    if (args.localSourcePath) {
      await updateJob(args.jobId, { progress: 18 })
      await notifyProgress('usando original temporario', 18)
    } else {
      await updateJob(args.jobId, { progress: 12 })
      await notifyProgress('baixando original do R2', 12)
      await downloadObjectToFile(video.source_key, sourcePath, bucket)
      await throwIfAbortRequested(args.shouldAbort)
    }

    await updateJob(args.jobId, { progress: 22 })
    await notifyProgress('lendo metadados', 22)
    const metadata = await readMediaMetadata(sourcePath)
    const posterCreated = await generatePoster(sourcePath, posterPath)
    const storyboardPlan = buildStoryboardPlan({
      durationSeconds: metadata.duration_seconds,
      width: metadata.width,
      height: metadata.height,
      maxFrames: Number(process.env.VIDEO_STORYBOARD_MAX_FRAMES || 120),
      frameWidth: Number(process.env.VIDEO_STORYBOARD_FRAME_WIDTH || 240),
      columns: Number(process.env.VIDEO_STORYBOARD_COLUMNS || 5),
    })
    const storyboardCreated = storyboardPlan
      ? await generateStoryboard(sourcePath, storyboardPath, storyboardPlan)
      : false
    await throwIfAbortRequested(args.shouldAbort)

    await updateJob(args.jobId, { progress: 36 })
    await notifyProgress('convertendo para HLS', 36)
    await mkdir(hlsDir, { recursive: true })
    await runFfmpegHls({
      sourcePath,
      hlsDir,
      metadata,
      durationSeconds: metadata.duration_seconds,
      jobId: args.jobId,
      shouldAbort: args.shouldAbort,
      onProgress: (progress) => {
        notifyProgress('convertendo para HLS', progress).catch(() => undefined)
      },
    })
    await throwIfAbortRequested(args.shouldAbort)

    await updateJob(args.jobId, { progress: 76 })
    await notifyProgress('enviando HLS para R2', 76)
    const hlsFiles = await listFilesRecursive(hlsDir)
    let uploadedHlsFiles = 0
    const hlsUploadConcurrency = Math.max(1, Number(process.env.VIDEO_HLS_UPLOAD_CONCURRENCY || 4))
    await mapWithConcurrency(hlsFiles, hlsUploadConcurrency, async (file) => {
      const relative = path.relative(hlsDir, file).split(path.sep).join('/')
      await uploadFileToR2(file, `${outputPrefix}/${relative}`, guessContentType(relative), bucket)
      uploadedHlsFiles += 1
      await notifyProgress('enviando HLS para R2', Math.round(76 + (uploadedHlsFiles / Math.max(hlsFiles.length, 1)) * 18))
    })
    await throwIfAbortRequested(args.shouldAbort)

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
    await notifyProgress('finalizando HLS', 96)
    await throwIfAbortRequested(args.shouldAbort)

    await writeJsonMetadata(metadataKey, {
      assetId: video.id,
      title: video.title,
      sourceKey: video.source_key,
      manifestKey,
      posterKey: finalPosterKey,
      storyboardKey: finalStoryboardKey,
      storyboard: finalStoryboardKey && storyboardPlan ? storyboardPlan : null,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      hlsVariants: [buildHlsOutputVariant(metadata)].map((variant) => ({
        label: variant.label,
        width: variant.width,
        height: variant.height,
        playlist: variant.playlist,
      })),
      processedAt: new Date().toISOString(),
      ...metadata,
    }, bucket)

    await updateJob(args.jobId, {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
    })
    await notifyProgress('concluido', 100)

    await updateAsset(video.id, {
      status: 'ready',
      hls_prefix: outputPrefix,
      hls_manifest_key: manifestKey,
      poster_key: finalPosterKey,
      duration_seconds: metadata.duration_seconds,
      width: buildHlsOutputVariant(metadata).width || metadata.width,
      height: buildHlsOutputVariant(metadata).height || metadata.height,
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
    if (isVideoProcessingCancelled(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    await updateJob(args.jobId, {
      status: 'failed',
      progress: 100,
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    await updateAsset(video.id, {
      status: 'failed',
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
