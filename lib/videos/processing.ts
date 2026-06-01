import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import {
  downloadObjectToFile,
  guessContentType,
  uploadFileToR2,
  writeJsonMetadata,
} from './r2'
import { buildStoryboardPlan, type StoryboardPlan } from './storyboard'
import type { VideoAsset } from './types'

interface RunResult {
  stdout: string
  stderr: string
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
    let lastPersistedProgress = 36
    let lastPersistedAt = 0

    const persistProgress = (progress: number) => {
      const now = Date.now()
      const bounded = Math.max(37, Math.min(74, Math.round(progress)))
      if (bounded <= lastPersistedProgress) return
      if (bounded - lastPersistedProgress < 2 && now - lastPersistedAt < 1800) return

      lastPersistedProgress = bounded
      lastPersistedAt = now
      updateJob(args.jobId, { progress: bounded }).catch(() => undefined)
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
        persistProgress(36 + (elapsed / args.durationSeconds) * 38)
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

  const notifyProgress = async (stage: string, progress: number) => {
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
    const sourcePath = args.localSourcePath || path.join(tempDir, `source${localSourceExtension(video.source_key)}`)
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

    await updateJob(args.jobId, { progress: 36 })
    await notifyProgress('convertendo para HLS', 36)
    await mkdir(hlsDir, { recursive: true })
    await runFfmpegHls({
      sourcePath,
      hlsDir,
      durationSeconds: metadata.duration_seconds,
      jobId: args.jobId,
      onProgress: (progress) => {
        notifyProgress('convertendo para HLS', progress).catch(() => undefined)
      },
    })

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

    await writeJsonMetadata(metadataKey, {
      assetId: video.id,
      title: video.title,
      sourceKey: video.source_key,
      manifestKey,
      posterKey: finalPosterKey,
      storyboardKey: finalStoryboardKey,
      storyboard: finalStoryboardKey && storyboardPlan ? storyboardPlan : null,
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
