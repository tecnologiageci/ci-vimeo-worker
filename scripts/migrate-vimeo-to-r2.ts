import { config as loadEnv } from 'dotenv'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import axios, { AxiosError } from 'axios'
import { createSupabaseAdmin } from '@/lib/supabase/admin'
import { processVideoToHls } from '@/lib/videos/processing'
import { isVideoMigrationNotificationPaused } from '@/lib/videos/migration-control'
import {
  assertR2Config,
  generateSourceKey,
  guessContentType,
  headR2Object,
  getObjectText,
  uploadFileToR2,
  uploadStreamToR2,
  writeJsonMetadata,
} from '@/lib/videos/r2'
import {
  buildVimeoFileName,
  buildVimeoFingerprint,
  getVimeoDownloadUrl,
  normalizeFolderPath,
  normalizeVimeoApiPath,
  parseVimeoId,
  resolveVimeoFolderPath,
  selectBestVideoDownload,
  VimeoDownloadFile,
  VimeoFolderLike,
  VimeoVideoLike,
  vimeoFileSize,
} from '@/lib/videos/vimeo-migration'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

const VIMEO_API_BASE = 'https://api.vimeo.com'
const ipv4HttpAgent = new http.Agent({ family: 4, keepAlive: true })
const ipv4HttpsAgent = new https.Agent({ family: 4, keepAlive: true })

interface VimeoConnection {
  uri?: string | null
}

interface VimeoFolder extends VimeoFolderLike {
  metadata?: {
    connections?: Record<string, VimeoConnection | VimeoConnection[] | undefined>
  } | null
}

interface VimeoVideo extends VimeoVideoLike {
  metadata?: {
    connections?: Record<string, VimeoConnection | VimeoConnection[] | undefined>
  } | null
}

type MigrationVideoItem = {
  video: VimeoVideo
  folderPath: string[]
}

interface VimeoListResponse<T> {
  data?: T[]
  total?: number | null
  paging?: {
    next?: string | null
  } | null
}

class VimeoRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function envFlag(name: string, defaultValue = false) {
  const value = process.env[name]
  if (value == null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'sim'].includes(value.toLowerCase())
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name] || '')
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function envText(name: string, fallback = '') {
  const value = process.env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

function csvList(value: string | null | undefined) {
  return (value || '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueList(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function humanSize(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return 'tamanho desconhecido'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function compactText(value: string, max = 900) {
  const text = value.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}...`
}

function percentText(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
}

function createPercentProgressReporter(args: {
  stepPercent?: number
  minIntervalMs?: number
  onReport: (percent: number) => void | Promise<void>
}) {
  const stepPercent = Math.max(1, args.stepPercent || envNumber('VIMEO_MIGRATION_NOTIFY_PERCENT_STEP', 10))
  const minIntervalMs = Math.max(0, args.minIntervalMs || envNumber('VIMEO_MIGRATION_NOTIFY_PERCENT_INTERVAL_MS', 30_000))
  let lastPercent = -1
  let lastAt = 0

  return (rawPercent: number, force = false) => {
    const percent = Math.max(0, Math.min(100, Math.round(rawPercent)))
    const now = Date.now()
    const advancedEnough = lastPercent < 0 || percent >= lastPercent + stepPercent
    const waitedEnough = now - lastAt >= minIntervalMs
    const isEdge = percent === 0 || percent >= 100
    if (percent === lastPercent) return
    if (!force && !isEdge && (!advancedEnough || !waitedEnough)) return
    if (!force && percent <= lastPercent && percent < 100) return

    lastPercent = percent
    lastAt = now
    Promise.resolve(args.onReport(percent)).catch(() => undefined)
  }
}

type MigrationNotifier = {
  enabled: boolean
  send: (message: string) => Promise<void>
  video: (index: number, message: string) => Promise<void>
}

type MigrationHeartbeatState = {
  startedAt: number
  limit: number
  scanned: number
  copied: number
  processed: number
  failed: number
  duplicates: number
  skippedWithoutDownload: number
  stage: string
  currentTitle: string
  currentFolder: string
  percent: number | null
}

async function createMigrationNotifier(execute: boolean): Promise<MigrationNotifier> {
  const enabled = envFlag('VIMEO_MIGRATION_NOTIFY', execute)
  const every = envNumber('VIMEO_MIGRATION_NOTIFY_EVERY', 1)
  const notifyName = envText('VIMEO_MIGRATION_NOTIFY_NAME', process.env.JULIANA_MASTER_NAME || 'Rai')

  if (!enabled) {
    return {
      enabled: false,
      send: async () => {},
      video: async () => {},
    }
  }

  const targets: string[] = uniqueList([
    ...csvList(process.env.VIMEO_MIGRATION_NOTIFY_NUMBERS),
    ...csvList(process.env.JULIANA_MASTER_NOTIFY_NUMBERS),
    ...csvList(process.env.JULIANA_MASTER_REMOTE_JIDS)
      .filter((jid) => jid.endsWith('@s.whatsapp.net'))
      .map((jid) => jid.split('@')[0] || ''),
  ])

  if (targets.length === 0) {
    console.warn('[juliana] notificacoes ligadas, mas nenhum numero foi configurado.')
  }

  async function send(message: string) {
    if (targets.length === 0) return
    if (isVideoMigrationNotificationPaused()) return

    try {
      const text = compactText(`Rai, ${message}`)
      const apiUrl = envText('EVOLUTION_API_URL', '').replace(/\/$/, '')
      const apiKey = envText('EVOLUTION_API_KEY', '')
      const instanceName = envText(
        'HUB_NOTIFICATIONS_EVOLUTION_INSTANCE',
        envText('EVOLUTION_INSTANCE_NAME', ''),
      )

      if (!apiUrl || !apiKey || !instanceName) {
        console.warn('[juliana] Evolution nao configurada: EVOLUTION_API_URL, EVOLUTION_API_KEY ou instancia ausente.')
        return
      }

      const url = `${apiUrl}/message/sendText/${encodeURIComponent(instanceName)}`
      await Promise.allSettled(targets.map((target) => {
        const number = target.includes('@') ? target : target.replace(/\D/g, '')
        return axios.post(url, { number, text }, {
          headers: {
            apikey: apiKey,
            'Content-Type': 'application/json',
          },
        })
      }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[juliana] falha ao enviar atualizacao para ${notifyName}: ${detail}`)
    }
  }

  return {
    enabled: true,
    send,
    video: async (index: number, message: string) => {
      if (index <= 1 || every <= 1 || index % every === 0) await send(message)
    },
  }
}

function createMigrationHeartbeat(notifier: MigrationNotifier, state: MigrationHeartbeatState) {
  const minutes = envNumber('VIMEO_MIGRATION_HEARTBEAT_MINUTES', 0)
  if (!notifier.enabled || minutes <= 0) return () => {}

  const interval = setInterval(() => {
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - state.startedAt) / 60_000))
    const total = state.limit > 0 ? String(state.limit) : 'sem limite'
    const progress = state.percent == null ? 'calculando' : percentText(state.percent)
    const folder = state.currentFolder ? `\nPasta: ${state.currentFolder}` : ''

    notifier.send(
      `migração Vimeo -> R2 rodando.\n` +
      `Lote: ${state.scanned}/${total} videos\n` +
      `Atual: ${state.currentTitle || 'mapeando'}${folder}\n` +
      `Etapa: ${state.stage}\n` +
      `Progresso do video: ${progress}\n` +
      `Ok: ${state.processed} HLS, ${state.copied} copiados, ${state.duplicates} duplicados, ${state.failed} erros\n` +
      `Tempo rodando: ${elapsedMinutes} min.`,
    ).catch(() => undefined)
  }, minutes * 60_000)

  interval.unref?.()
  return () => clearInterval(interval)
}

function createConcurrencyLimiter(limit: number) {
  const max = Math.max(1, Math.floor(limit || 1))
  const queue: Array<() => void> = []
  let active = 0

  async function acquire() {
    if (active < max) {
      active += 1
      return
    }

    await new Promise<void>((resolve) => queue.push(resolve))
    active += 1
  }

  return async function runLimited<T>(task: () => Promise<T>) {
    await acquire()
    try {
      return await task()
    } finally {
      active -= 1
      const next = queue.shift()
      if (next) next()
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  const max = Math.max(1, Math.floor(concurrency || 1))
  const workerCount = Math.min(max, items.length)
  let nextIndex = 0

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index], index)
    }
  }))
}

function cacheSegment(value: string) {
  return (value || 'default')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'default'
}

function migrationQueueCacheKey(args: {
  limit: number
  rootOnly: boolean
  includeRootVideos: boolean
  rootFolderName: string
  folderFilters?: string[]
  folderUriFilters?: string[]
}) {
  const scope = args.rootOnly ? 'root-only' : 'folders'
  const includeRoot = args.includeRootVideos ? 'with-root' : 'no-root'
  const limit = args.limit > 0 ? String(args.limit) : 'all'
  const root = cacheSegment(args.rootFolderName || 'root')
  const filterSource = [
    ...(args.folderFilters || []),
    ...(args.folderUriFilters || []),
  ].join('-')
  const filter = filterSource ? `-${cacheSegment(filterSource)}` : ''
  return `_migration/vimeo-queue/${scope}-${includeRoot}-${root}-${limit}${filter}.json`
}

function normalizeSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function folderMatchesFilters(folder: VimeoFolder, folderPath: string[], filters: string[], uriFilters: string[]) {
  if (filters.length === 0 && uriFilters.length === 0) return true

  if (uriFilters.length > 0) {
    const ancestorPath = folder.metadata?.connections?.ancestor_path
    const ancestorUris = (Array.isArray(ancestorPath) ? ancestorPath : [])
      .map((ancestor: VimeoConnection) => ancestor.uri)
      .filter(Boolean) || []
    const candidates = [folder.uri, ...ancestorUris].filter(Boolean)
    const matchesUri = uriFilters.some((filter) => candidates.some((candidate) => candidate === filter))
    if (matchesUri) return true
    if (filters.length === 0) return false
  }

  const candidates = [
    folder.name || '',
    folder.uri || '',
    folderPath.join('/'),
    folderPath.at(-1) || '',
  ].map(normalizeSearchText)

  return filters.some((filter) => {
    const normalizedFilter = normalizeSearchText(filter)
    return candidates.some((candidate) => candidate === normalizedFilter || candidate.includes(normalizedFilter))
  })
}

function normalizeCachedMigrationQueue(value: unknown): MigrationVideoItem[] | null {
  const items = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.items)
      ? (value as any).items
      : null
  if (!items) return null

  const normalized: MigrationVideoItem[] = items
    .map((item: any) => ({
      video: item?.video,
      folderPath: Array.isArray(item?.folderPath)
        ? item.folderPath.filter((part: unknown) => typeof part === 'string')
        : [],
    }))
    .filter((item: MigrationVideoItem) => item.video && (item.video.uri || item.video.link || item.video.name))

  return normalized.length > 0 ? normalized : null
}

async function loadInlineMigrationQueue() {
  const inline = (process.env.VIMEO_MIGRATION_QUEUE_INLINE || '').trim()
  if (inline) return normalizeCachedMigrationQueue(JSON.parse(inline))

  const filePath = (process.env.VIMEO_MIGRATION_QUEUE_FILE || '').trim()
  if (!filePath) return null
  const text = await readFile(filePath, 'utf8')
  return normalizeCachedMigrationQueue(JSON.parse(text))
}

function migrationQueueTaskIds() {
  const raw = (process.env.VIMEO_MIGRATION_QUEUE_TASK_IDS || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {
    /* aceita CSV simples abaixo */
  }
  return raw.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean)
}

async function loadMigrationQueueCache(bucket: string, key: string) {
  try {
    const text = await getObjectText(key, bucket)
    return normalizeCachedMigrationQueue(JSON.parse(text))
  } catch {
    return null
  }
}

async function saveMigrationQueueCache(bucket: string, key: string, items: MigrationVideoItem[]) {
  await writeJsonMetadata(key, {
    version: 1,
    createdAt: new Date().toISOString(),
    items,
  }, bucket)
}

function normalizeBucketName(value: string | null | undefined) {
  const raw = (value || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return raw

  try {
    const url = new URL(raw)
    return url.pathname.split('/').filter(Boolean)[0] || ''
  } catch {
    return raw
  }
}

function vimeoUserBasePath() {
  const userId = (process.env.VIMEO_USER_ID || '').trim()
  return userId ? `/users/${encodeURIComponent(userId)}` : '/me'
}

function withPerPage(pathOrUrl: string) {
  const url = new URL(normalizeVimeoApiPath(pathOrUrl), VIMEO_API_BASE)
  if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', '100')
  return url.toString()
}

function getConnectionUri(item: { metadata?: { connections?: Record<string, VimeoConnection | VimeoConnection[] | undefined> } | null }, key: string) {
  const connection = item.metadata?.connections?.[key]
  return Array.isArray(connection) ? connection[0]?.uri || null : connection?.uri || null
}

function vimeoApiTimeoutMs() {
  return envNumber('VIMEO_MIGRATION_REQUEST_TIMEOUT_MS', 30_000)
}

async function vimeoGet<T>(pathOrUrl: string, token: string): Promise<T> {
  const url = new URL(normalizeVimeoApiPath(pathOrUrl), VIMEO_API_BASE)
  const timeoutMs = vimeoApiTimeoutMs()
  let response

  try {
    response = await axios.get(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    })
  } catch (error) {
    if (error instanceof AxiosError && error.code === 'ECONNABORTED') {
      throw new VimeoRequestError(408, `Vimeo nao respondeu em ${timeoutMs}ms: ${url.pathname}`)
    }
    throw error
  }

  if (response.status < 200 || response.status >= 300) {
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    throw new VimeoRequestError(response.status, `Vimeo ${response.status} em ${url.pathname}: ${text || response.statusText}`)
  }

  return response.data as T
}

async function paginateVimeo<T>(
  pathOrUrl: string,
  token: string,
  progress?: {
    label: string
    notifier?: MigrationNotifier
    notify?: boolean
    notifyEveryPages?: number
  },
) {
  const items: T[] = []
  let next: string | null = withPerPage(pathOrUrl)
  let page = 0
  const notifyEveryPages = progress?.notifyEveryPages || envNumber('VIMEO_MIGRATION_NOTIFY_PAGE_EVERY', 10)
  const maxPages = envNumber('VIMEO_MIGRATION_MAX_PAGES', 0)

  while (next) {
    const payload: VimeoListResponse<T> = await vimeoGet<VimeoListResponse<T>>(next, token)
    page += 1
    items.push(...(payload.data || []))
    if (progress?.label) {
      const total = payload.total ? ` de ${payload.total}` : ''
      console.log(`[vimeo] ${progress.label}: pagina ${page}; ${items.length}${total} itens`)
      if (progress.notify && progress.notifier && (page === 1 || page % notifyEveryPages === 0)) {
        await progress.notifier.send(`listando ${progress.label}: pagina ${page}, ${items.length}${total} itens encontrados ate agora.`)
      }
    }
    if (maxPages > 0 && page >= maxPages) {
      console.log(`[vimeo] ${progress?.label || 'paginacao'}: limite de ${maxPages} pagina(s) atingido por VIMEO_MIGRATION_MAX_PAGES`)
      break
    }
    next = payload.paging?.next ? withPerPage(payload.paging.next) : null
  }

  return items
}

function mergeFolders(folders: VimeoFolder[]) {
  const byUri = new Map<string, VimeoFolder>()
  for (const folder of folders) {
    const key = folder.uri || folder.name || String(byUri.size)
    if (!byUri.has(key)) byUri.set(key, folder)
  }
  return byUri
}

async function listVimeoFolders(token: string, notifier?: MigrationNotifier) {
  const base = vimeoUserBasePath()
  const configured = (process.env.VIMEO_MIGRATION_FOLDER_ENDPOINT || '').trim()
  const candidates = configured ? [configured] : [`${base}/projects`, `${base}/folders`]
  let lastError: unknown = null
  let folders: VimeoFolder[] = []

  for (const candidate of candidates) {
    try {
      console.log(`[vimeo] listando pastas: ${candidate}`)
      if (notifier) await notifier.send(`estou listando as pastas do Vimeo em ${candidate}.`)
      folders = await paginateVimeo<VimeoFolder>(candidate, token, { label: 'pastas Vimeo', notifier, notify: true })
      break
    } catch (error) {
      lastError = error
      if (!(error instanceof VimeoRequestError) || ![404, 405].includes(error.status)) throw error
    }
  }

  if (folders.length === 0 && lastError && candidates.length > 0) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    console.warn(`[vimeo] Nenhuma pasta retornada pelo Vimeo. Ultima resposta ignorada: ${message}`)
  }

  const foldersByUri = mergeFolders(folders)
  if (envFlag('VIMEO_MIGRATION_SKIP_SUBFOLDER_DISCOVERY', false)) {
    console.log('[vimeo] pulando varredura extra de subpastas por VIMEO_MIGRATION_SKIP_SUBFOLDER_DISCOVERY=1')
    return foldersByUri
  }

  const queue = Array.from(foldersByUri.values())

  while (queue.length > 0) {
    const folder = queue.shift()!
    const childUris = [
      getConnectionUri(folder, 'folders'),
      getConnectionUri(folder, 'projects'),
    ].filter((uri): uri is string => Boolean(uri))

    for (const childUri of childUris) {
      try {
        const children = await paginateVimeo<VimeoFolder>(childUri, token, { label: `subpastas de ${folder.name || folder.uri || 'pasta'}` })
        for (const child of children) {
          const normalizedChild = child.parent_folder?.uri || !folder.uri
            ? child
            : { ...child, parent_folder: { uri: folder.uri, name: folder.name } }
          const key = normalizedChild.uri || normalizedChild.name || ''
          if (!key || foldersByUri.has(key)) continue
          foldersByUri.set(key, normalizedChild)
          queue.push(normalizedChild)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[vimeo] Nao consegui listar subpastas de ${folder.name || folder.uri}: ${message}`)
      }
    }
  }

  return foldersByUri
}

async function listVideosForFolder(folder: VimeoFolder, token: string, notifier?: MigrationNotifier) {
  const videosUri = getConnectionUri(folder, 'videos') || (folder.uri ? `${folder.uri}/videos` : null)
  if (!videosUri) return []

  try {
    return await paginateVimeo<VimeoVideo>(videosUri, token, { label: `videos de ${folder.name || folder.uri || 'pasta'}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vimeo] Nao consegui listar videos de ${folder.name || folder.uri}: ${message}`)
    return []
  }
}

async function listRootVideos(token: string, notifier?: MigrationNotifier) {
  const endpoint = (process.env.VIMEO_MIGRATION_ROOT_VIDEOS_ENDPOINT || '').trim() || `${vimeoUserBasePath()}/videos`
  return paginateVimeo<VimeoVideo>(endpoint, token, { label: 'videos sem pasta', notifier, notify: true })
}

async function findFolderByName(db: any, parentId: string | null, name: string) {
  const query = db.from('video_folders').select('*')
  const { data, error } = parentId
    ? await query.eq('parent_id', parentId)
    : await query.is('parent_id', null)

  if (error) throw error
  return (data || []).find((folder: any) => folder.name.trim().toLowerCase() === name.trim().toLowerCase()) || null
}

async function ensureFolderPath(db: any, path: string[]) {
  let parentId: string | null = null

  for (const name of path) {
    const existing = await findFolderByName(db, parentId, name)
    if (existing) {
      parentId = existing.id
      continue
    }

    const { data, error } = await db
      .from('video_folders')
      .insert({ name, parent_id: parentId })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        const retry = await findFolderByName(db, parentId, name)
        if (retry) {
          parentId = retry.id
          continue
        }
      }
      throw error
    }

    parentId = data.id
  }

  return parentId
}

function folderFilter(query: any, folderId: string | null) {
  return folderId ? query.eq('folder_id', folderId) : query.is('folder_id', null)
}

async function findExistingAsset(db: any, folderId: string | null, fingerprint: string) {
  const query = db
    .from('video_assets')
    .select('*')
    .eq('source_fingerprint', fingerprint)
    .limit(1)

  const { data, error } = await folderFilter(query, folderId).maybeSingle()
  if (error) throw error
  return data || null
}

async function createOrReuseAsset(args: {
  db: any
  bucket: string
  folderId: string | null
  video: VimeoVideo
  videoId: string
  download: VimeoDownloadFile
  fileName: string
  fingerprint: string
}) {
  const existing = await findExistingAsset(args.db, args.folderId, args.fingerprint)
  if (existing && existing.source_key) {
    let sourceExists = existing.status !== 'failed'
    if (!sourceExists) {
      sourceExists = await headR2Object(existing.source_key, args.bucket)
        .then(() => true)
        .catch(() => false)
    }

    if (sourceExists) {
      if (existing.status === 'failed') {
        const { data, error } = await args.db
          .from('video_assets')
          .update({
            status: 'uploaded',
            source_bucket: args.bucket,
            last_error: null,
          })
          .eq('id', existing.id)
          .select('*')
          .single()

        if (error || !data) throw error || new Error('Falha ao reativar video ja copiado.')
        return { asset: data, duplicate: true, reusedFailed: false }
      }

      return { asset: existing, duplicate: true, reusedFailed: false }
    }
  }

  if (existing) {
    const { data, error } = await args.db
      .from('video_assets')
      .update({
        title: args.video.name || args.fileName,
        description: args.video.description || null,
        status: 'uploading',
        source_bucket: args.bucket,
        source_size_bytes: vimeoFileSize(args.download) || null,
        source_content_type: args.download.type || guessContentType(args.fileName),
        source_file_name: args.fileName,
        last_error: null,
      })
      .eq('id', existing.id)
      .select('*')
      .single()

    if (error || !data) throw error || new Error('Falha ao reutilizar video existente.')
    return { asset: data, duplicate: false, reusedFailed: true }
  }

  const { data, error } = await args.db
    .from('video_assets')
    .insert({
      title: args.video.name || args.fileName,
      description: args.video.description || null,
      status: 'uploading',
      folder_id: args.folderId,
      source_bucket: args.bucket,
      source_size_bytes: vimeoFileSize(args.download) || null,
      source_content_type: args.download.type || guessContentType(args.fileName),
      source_file_name: args.fileName,
      source_fingerprint: args.fingerprint,
    })
    .select('*')
    .single()

  if (error || !data) throw error || new Error('Falha ao criar video no Hub.')
  return { asset: data, duplicate: false, reusedFailed: false }
}

function createProgressStream(args: {
  totalBytes: number | null
  onProgress?: (progress: { percent: number; transferredBytes: number; totalBytes: number | null }) => void
}) {
  let transferredBytes = 0

  return new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (args.totalBytes && args.totalBytes > 0) {
        args.onProgress?.({
          percent: (transferredBytes / args.totalBytes) * 100,
          transferredBytes,
          totalBytes: args.totalBytes,
        })
      }
      callback(null, chunk)
    },
    flush(callback) {
      args.onProgress?.({
        percent: 100,
        transferredBytes,
        totalBytes: args.totalBytes,
      })
      callback()
    },
  })
}

function retryDelayMs(attempt: number) {
  return Math.min(30_000, 2_000 * attempt)
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function uploadVimeoFileToR2(args: {
  downloadUrl: string
  sourceKey: string
  contentType: string
  contentLength: number | null
  bucket: string
  onProgress?: (progress: { percent: number; transferredBytes: number; totalBytes: number | null }) => void
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void | Promise<void>
}) {
  const maxAttempts = envNumber('VIMEO_MIGRATION_UPLOAD_RETRIES', 4)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await uploadVimeoFileToR2Once(args)
      return
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (attempt >= maxAttempts) throw err
      console.warn(`[vimeo] upload falhou; tentando novamente ${attempt + 1}/${maxAttempts}: ${err.message}`)
      await args.onRetry?.(attempt + 1, maxAttempts, err)
      await wait(retryDelayMs(attempt))
    }
  }
}

async function downloadVimeoFileToLocalOnce(args: {
  downloadUrl: string
  destinationPath: string
  contentLength: number | null
  onProgress?: (progress: { percent: number; transferredBytes: number; totalBytes: number | null }) => void
}) {
  const response = await axios.get(args.downloadUrl, {
    responseType: 'stream',
    timeout: 0,
    maxRedirects: 5,
    httpAgent: ipv4HttpAgent,
    httpsAgent: ipv4HttpsAgent,
    validateStatus: () => true,
  })

  if (response.status < 200 || response.status >= 300 || !response.data) {
    const detail = typeof response.data === 'string' ? response.data : response.statusText
    throw new Error(`Falha ao baixar arquivo do Vimeo: ${response.status} ${detail || response.statusText}`)
  }

  const responseLength = Number(response.headers['content-length'] || 0)
  const contentLength = args.contentLength || (Number.isFinite(responseLength) && responseLength > 0 ? responseLength : null)
  const progressStream = createProgressStream({ totalBytes: contentLength, onProgress: args.onProgress })
  await pipeline(response.data, progressStream, createWriteStream(args.destinationPath))
}

async function downloadVimeoFileToLocal(args: {
  downloadUrl: string
  destinationPath: string
  contentLength: number | null
  onProgress?: (progress: { percent: number; transferredBytes: number; totalBytes: number | null }) => void
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void | Promise<void>
}) {
  const maxAttempts = envNumber('VIMEO_MIGRATION_DOWNLOAD_RETRIES', envNumber('VIMEO_MIGRATION_UPLOAD_RETRIES', 8))

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(args.destinationPath, { force: true }).catch(() => undefined)
      await downloadVimeoFileToLocalOnce(args)
      return
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (attempt >= maxAttempts) throw err
      console.warn(`[vimeo] download falhou; tentando novamente ${attempt + 1}/${maxAttempts}: ${err.message}`)
      await args.onRetry?.(attempt + 1, maxAttempts, err)
      await wait(retryDelayMs(attempt))
    }
  }
}

async function uploadVimeoFileToR2Once(args: {
  downloadUrl: string
  sourceKey: string
  contentType: string
  contentLength: number | null
  bucket: string
  onProgress?: (progress: { percent: number; transferredBytes: number; totalBytes: number | null }) => void
}) {
  const response = await fetch(args.downloadUrl, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`Falha ao baixar arquivo do Vimeo: ${response.status} ${text || response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || args.contentType
  const responseLength = Number(response.headers.get('content-length') || 0)
  const contentLength = args.contentLength || (Number.isFinite(responseLength) && responseLength > 0 ? responseLength : null)
  const stream = Readable.fromWeb(response.body as any)
  const progressStream = createProgressStream({ totalBytes: contentLength, onProgress: args.onProgress })
  const uploadStream = new PassThrough()
  const pipePromise = pipeline(stream, progressStream, uploadStream)
  const uploadPromise = uploadStreamToR2(uploadStream, args.sourceKey, contentType, contentLength, args.bucket)

  try {
    await Promise.all([pipePromise, uploadPromise])
  } catch (error) {
    stream.destroy()
    progressStream.destroy()
    uploadStream.destroy()
    await Promise.allSettled([pipePromise, uploadPromise])
    throw error
  }
}

async function maybeProcessVideo(args: {
  db: any
  asset: any
  processAfterUpload: boolean
  localSourcePath?: string | null
  onProgress?: (event: { stage: string; progress: number }) => void | Promise<void>
}) {
  const { db, asset, processAfterUpload } = args
  if (!processAfterUpload) return false

  const { data: job, error } = await db
    .from('video_processing_jobs')
    .insert({
      video_asset_id: asset.id,
      job_type: 'hls',
      status: 'queued',
      progress: 0,
      source_key: asset.source_key,
    })
    .select('*')
    .single()

  if (error || !job) throw error || new Error('Falha ao criar job de processamento.')
  await processVideoToHls({
    assetId: asset.id,
    jobId: job.id,
    userId: null,
    localSourcePath: args.localSourcePath,
    onProgress: args.onProgress,
  })
  return true
}

async function markAssetFailed(db: any, assetId: string, message: string) {
  await db
    .from('video_assets')
    .update({ status: 'failed', last_error: message })
    .eq('id', assetId)
}

async function updateMigrationQueueTask(db: any, taskId: string | null | undefined, patch: Record<string, any>) {
  if (!db || !taskId) return
  const { error } = await db
    .from('video_migration_queue')
    .update(patch)
    .eq('id', taskId)
  if (error) console.warn(`[queue] nao consegui atualizar task ${taskId}: ${error.message}`)
}

async function markAssetUploaded(db: any, assetId: string, sourceKey: string) {
  const { data, error } = await db
    .from('video_assets')
    .update({
      status: 'uploaded',
      source_key: sourceKey,
      last_error: null,
    })
    .eq('id', assetId)
    .select('*')
    .single()

  if (error || !data) throw error || new Error('Falha ao atualizar video importado.')
  return data
}

async function main() {
  const token = (process.env.VIMEO_ACCESS_TOKEN || process.env.VIMEO_BEARER_TOKEN || '').trim()
  if (!token) {
    throw new Error('Defina VIMEO_ACCESS_TOKEN com escopos public, private e video_files antes de migrar.')
  }

  const execute = envFlag('VIMEO_MIGRATION_EXECUTE', false)
  const includeRootVideos = envFlag('VIMEO_MIGRATION_INCLUDE_ROOT', true)
  const processAfterUpload = envFlag('VIMEO_MIGRATION_PROCESS', true)
  const videoConcurrency = envNumber('VIMEO_MIGRATION_VIDEO_CONCURRENCY', 1)
  const hlsConcurrency = envNumber('VIMEO_MIGRATION_HLS_CONCURRENCY', processAfterUpload ? 1 : videoConcurrency)
  const pipelineHls = processAfterUpload && envFlag('VIMEO_MIGRATION_PIPELINE_HLS', false)
  const hlsBacklogLimit = envNumber(
    'VIMEO_MIGRATION_HLS_BACKLOG_LIMIT',
    Math.max(videoConcurrency * 2, hlsConcurrency),
  )
  const transferMode = envText('VIMEO_MIGRATION_TRANSFER_MODE', 'local-file').toLowerCase()
  const useLocalFileTransfer = transferMode !== 'stream'
  const queueCacheEnabled = envFlag('VIMEO_MIGRATION_QUEUE_CACHE', true)
  const refreshQueueCache = envFlag('VIMEO_MIGRATION_REFRESH_QUEUE', false)
  const rootOnly = envFlag('VIMEO_MIGRATION_ROOT_ONLY', false)
  const limit = envNumber('VIMEO_MIGRATION_LIMIT', 0)
  const rootFolderName = (process.env.VIMEO_MIGRATION_ROOT_FOLDER || 'Vimeo').trim()
  const folderFilters = uniqueList([
    ...csvList(process.env.VIMEO_MIGRATION_FOLDER_NAME),
    ...csvList(process.env.VIMEO_MIGRATION_FOLDER_FILTER),
  ])
  const folderUriFilters = uniqueList(csvList(process.env.VIMEO_MIGRATION_FOLDER_URI))
  const rootPrefix = rootFolderName ? [rootFolderName] : []
  const mcpUrl = (process.env.VIMEO_MCP_URL || 'https://mcp.vimeo.com/mcp').trim()
  const targetBucket = normalizeBucketName(
    process.env.VIMEO_MIGRATION_R2_BUCKET ||
    process.env.VIMEO_MIGRATION_R2_ENDPOINT ||
    'aulas-ead',
  )

  const db = execute ? createSupabaseAdmin() : null
  if (execute && !db) throw new Error('Supabase service role nao configurado.')

  const r2Config = execute ? await assertR2Config(targetBucket) : { bucket: targetBucket || 'dry-run' }
  const notifier = await createMigrationNotifier(execute)
  const heartbeatState: MigrationHeartbeatState = {
    startedAt: Date.now(),
    limit,
    scanned: 0,
    copied: 0,
    processed: 0,
    failed: 0,
    duplicates: 0,
    skippedWithoutDownload: 0,
    stage: rootOnly ? 'iniciando benchmark' : 'mapeando pastas Vimeo',
    currentTitle: 'Vimeo',
    currentFolder: '',
    percent: null,
  }
  const stopHeartbeat = createMigrationHeartbeat(notifier, heartbeatState)
  await notifier.send(
    `comecei a migracao Vimeo -> R2. Primeiro vou mapear as pastas e videos do Vimeo. Modo: ${execute ? 'execute' : 'dry-run'}. Bucket: ${r2Config.bucket}.`,
  )
  const queueCacheKey = envText('VIMEO_MIGRATION_QUEUE_CACHE_KEY', migrationQueueCacheKey({
    limit,
    rootOnly,
    includeRootVideos,
    rootFolderName,
    folderFilters,
    folderUriFilters,
  }))
  const migrationQueue: MigrationVideoItem[] = []
  let loadedQueueFromCache = false
  const inlineQueue = await loadInlineMigrationQueue()
  if (inlineQueue) {
    migrationQueue.push(...inlineQueue)
    loadedQueueFromCache = true
    heartbeatState.stage = 'fila recebida do controlador'
    heartbeatState.currentTitle = `${inlineQueue.length} videos na fila controlada`
    await notifier.send(`fila recebida do controlador: ${inlineQueue.length} videos. Vou pular o mapeamento do Vimeo.`)
  }
  if (!inlineQueue && queueCacheEnabled && !refreshQueueCache) {
    const cachedQueue = await loadMigrationQueueCache(r2Config.bucket, queueCacheKey)
    if (cachedQueue) {
      migrationQueue.push(...cachedQueue)
      loadedQueueFromCache = true
      heartbeatState.stage = 'fila carregada do cache'
      heartbeatState.currentTitle = `${cachedQueue.length} videos no cache`
      await notifier.send(`fila carregada do cache: ${cachedQueue.length} videos. Vou pular o mapeamento das pastas do Vimeo.`)
    }
  }

  const foldersByUri = loadedQueueFromCache || rootOnly ? new Map<string, VimeoFolder>() : await listVimeoFolders(token, notifier)
  const folders = Array.from(foldersByUri.values())
  const seenInFolders = new Set<string>()
  const report = {
    mode: execute ? 'execute' : 'dry-run',
    mcpUrl,
    folders: folders.length,
    bucket: r2Config.bucket,
    scanned: 0,
    copied: 0,
    duplicates: 0,
    failed: 0,
    skippedWithoutDownload: 0,
    processed: 0,
  }
  const withHlsSlot = createConcurrencyLimiter(hlsConcurrency)
  const hlsTasks = new Set<Promise<void>>()
  const folderIdCache = new Map<string, Promise<string | null>>()
  const canCollectMore = () => limit === 0 || migrationQueue.length < limit
  const taskIds = migrationQueueTaskIds()

  async function waitForHlsBacklog() {
    if (!pipelineHls || hlsBacklogLimit <= 0) return
    while (hlsTasks.size >= hlsBacklogLimit) {
      heartbeatState.stage = `aguardando HLS liberar fila (${hlsTasks.size}/${hlsBacklogLimit})`
      await Promise.race(Array.from(hlsTasks)).catch(() => undefined)
    }
  }

  function queueHlsTask(task: () => Promise<void>) {
    const promise = withHlsSlot(task).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[erro] fila HLS: ${message}`)
    })
    hlsTasks.add(promise)
    promise.finally(() => hlsTasks.delete(promise)).catch(() => undefined)
    return promise
  }

  function collectVideo(video: VimeoVideo, folderPath: string[]) {
    if (!canCollectMore()) return false
    migrationQueue.push({ video, folderPath })
    return true
  }

  async function resolveFolderId(path: string[]) {
    if (path.length === 0) return null

    const key = path.join('/')
    const existing = folderIdCache.get(key)
    if (existing) return existing

    const promise = ensureFolderPath(db, path)
    folderIdCache.set(key, promise)
    return promise
  }

  console.log(`[vimeo] modo=${report.mode}; mcp=${mcpUrl}; bucket=${r2Config.bucket}; pastas=${folders.length}; raiz="${rootFolderName || 'sem raiz'}"; rootOnly=${rootOnly ? 'sim' : 'nao'}; filtro="${[...folderFilters, ...folderUriFilters].join(', ') || 'nenhum'}"`)
  console.log(`[vimeo] concorrencia: videos=${videoConcurrency}; hls=${processAfterUpload ? hlsConcurrency : 0}; transferencia=${useLocalFileTransfer ? 'arquivo temporario' : 'stream direto'}; pipelineHls=${pipelineHls ? 'sim' : 'nao'}${pipelineHls ? `; backlogHls=${hlsBacklogLimit}` : ''}`)
  if (!execute) console.log('[vimeo] dry-run: nada sera criado no Hub, R2 ou Vimeo.')
  await notifier.send(
    rootOnly
      ? `modo benchmark ligado: vou testar direto pelos videos da raiz/lista geral sem varrer as pastas antes. Concorrencia: ${videoConcurrency} videos, ${processAfterUpload ? hlsConcurrency : 0} HLS. Transferencia: ${useLocalFileTransfer ? 'arquivo temporario' : 'stream direto'}.${pipelineHls ? ` Pipeline HLS ligado, backlog maximo ${hlsBacklogLimit}.` : ''}`
      : `mapa inicial pronto: ${folders.length} pastas encontradas. Concorrencia: ${videoConcurrency} videos, ${processAfterUpload ? hlsConcurrency : 0} HLS. Transferencia: ${useLocalFileTransfer ? 'arquivo temporario' : 'stream direto'}.${pipelineHls ? ` Pipeline HLS ligado, backlog maximo ${hlsBacklogLimit}.` : ''}`,
  )

  async function migrateVideo(video: VimeoVideo, folderPath: string[], taskId?: string | null) {
    await waitForHlsBacklog()
    if (limit > 0 && report.scanned >= limit) return
    report.scanned += 1
    const currentIndex = report.scanned
    heartbeatState.scanned = currentIndex
    heartbeatState.currentTitle = video.name || video.uri || 'video sem nome'
    heartbeatState.currentFolder = normalizeFolderPath([...rootPrefix, ...folderPath]).join('/') || 'Raiz'
    heartbeatState.stage = 'preparando video'
    heartbeatState.percent = null
    await updateMigrationQueueTask(db, taskId, {
      status: 'processing',
      current_stage: 'preparando video',
      progress_percent: 1,
      worker_name: process.env.CI_VIMEO_WORKER_NAME || null,
      lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })

    const videoId = parseVimeoId(video.uri || video.link || '')
    if (!videoId) {
      report.failed += 1
      heartbeatState.failed = report.failed
      await updateMigrationQueueTask(db, taskId, {
        status: 'failed',
        current_stage: 'erro',
        error_message: 'Video sem ID reconhecivel.',
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
      })
      console.warn(`[vimeo] video sem ID reconhecivel: ${video.name || video.uri || 'sem nome'}`)
      await notifier.video(currentIndex, `encontrei um video sem ID reconhecivel e pulei: ${video.name || video.uri || 'sem nome'}.`)
      return
    }

    let sourceVideo = video
    if (envFlag('VIMEO_MIGRATION_REFRESH_VIDEO_DETAILS', loadedQueueFromCache) && video.uri) {
      try {
        sourceVideo = await vimeoGet<VimeoVideo>(video.uri, token)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[vimeo] nao consegui atualizar detalhes de ${video.name || videoId}: ${message}`)
      }
    }

    const download = selectBestVideoDownload(sourceVideo)
    if (!download) {
      report.skippedWithoutDownload += 1
      heartbeatState.skippedWithoutDownload = report.skippedWithoutDownload
      await updateMigrationQueueTask(db, taskId, {
        status: 'skipped',
        current_stage: 'sem arquivo para baixar',
        error_message: 'Vimeo nao retornou arquivo para baixar.',
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
      })
      console.warn(`[vimeo] sem link de arquivo: ${sourceVideo.name || videoId}`)
      await notifier.video(currentIndex, `pulei "${sourceVideo.name || videoId}" porque o Vimeo nao retornou arquivo para baixar.`)
      return
    }

    const downloadUrl = getVimeoDownloadUrl(download)
    if (!downloadUrl) {
      report.skippedWithoutDownload += 1
      heartbeatState.skippedWithoutDownload = report.skippedWithoutDownload
      await updateMigrationQueueTask(db, taskId, {
        status: 'skipped',
        current_stage: 'sem URL de download',
        error_message: 'Vimeo nao retornou URL de download.',
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
      })
      console.warn(`[vimeo] sem URL de download: ${sourceVideo.name || videoId}`)
      await notifier.video(currentIndex, `pulei "${sourceVideo.name || videoId}" porque o Vimeo nao retornou URL de download.`)
      return
    }

    const finalFolderPath = normalizeFolderPath([...rootPrefix, ...folderPath])
    const fileName = buildVimeoFileName(sourceVideo, download, videoId)
    const fingerprint = buildVimeoFingerprint(videoId)
    const contentType = download.type || guessContentType(fileName)
    const size = vimeoFileSize(download) || null

    if (!execute || !db) {
      console.log(`[dry-run] ${finalFolderPath.join('/') || 'Raiz'} -> ${video.name || fileName} (${size || 'tamanho desconhecido'})`)
      return
    }

    const folderId = await resolveFolderId(finalFolderPath)

    let assetId: string | null = null
    let localTempDir: string | null = null
    let localSourcePath: string | null = null

    try {
      const { asset, duplicate, reusedFailed } = await createOrReuseAsset({
        db,
        bucket: r2Config.bucket,
        folderId,
        video: sourceVideo,
        videoId,
        download,
        fileName,
        fingerprint,
      })
      assetId = asset.id
      const displayTitle = sourceVideo.name || fileName
      let downloadBytes = 0
      let downloadTotalBytes: number | null = size
      let uploadBytes = 0
      let uploadTotalBytes: number | null = size
      let hlsStage = 'preparando'
      const downloadProgress = createPercentProgressReporter({
        onReport: (percent) => notifier.video(
          currentIndex,
          `download Vimeo "${displayTitle}": ${percentText(percent)} (${humanSize(downloadBytes)} / ${humanSize(downloadTotalBytes)}).`,
        ),
      })
      const uploadProgress = createPercentProgressReporter({
        onReport: (percent) => notifier.video(
          currentIndex,
          `upload para R2 "${displayTitle}": ${percentText(percent)} (${humanSize(uploadBytes)} / ${humanSize(uploadTotalBytes)}).`,
        ),
      })
      const hlsProgress = createPercentProgressReporter({
        onReport: (percent) => notifier.video(
          currentIndex,
          `processamento HLS "${displayTitle}": ${percentText(percent)} (${hlsStage}).`,
        ),
      })
      const onHlsProgress = (event: { stage: string; progress: number }) => {
        hlsStage = event.stage
        heartbeatState.stage = event.stage
        heartbeatState.percent = event.progress
        hlsProgress(event.progress, event.progress >= 100)
        updateMigrationQueueTask(db, taskId, {
          status: 'processing',
          current_stage: event.stage,
          progress_percent: Math.max(0, Math.min(100, event.progress)),
          lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        }).catch(() => undefined)
      }
      const processHls = async (assetToProcess: any, sourcePath: string | null, tempDir: string | null) => {
        try {
          console.log(`[hls] convertendo: ${video.name || fileName}`)
          heartbeatState.currentTitle = video.name || fileName
          heartbeatState.currentFolder = finalFolderPath.join('/') || 'Raiz'
          heartbeatState.stage = 'convertendo para HLS'
          heartbeatState.percent = 5
          const processed = await maybeProcessVideo({
            db,
            asset: assetToProcess,
            processAfterUpload,
            localSourcePath: sourcePath,
            onProgress: onHlsProgress,
          })
          if (processed) {
            report.processed += 1
            heartbeatState.processed = report.processed
            heartbeatState.percent = 100
            await updateMigrationQueueTask(db, taskId, {
              status: 'completed',
              current_stage: 'HLS pronto',
              progress_percent: 100,
              completed_at: new Date().toISOString(),
              lease_expires_at: null,
              result: { assetId: assetToProcess.id, videoId, hls: true },
            })
            await notifier.video(currentIndex, `HLS pronto para "${video.name || fileName}". Vou para o proximo.`)
          }
        } catch (error) {
          report.failed += 1
          heartbeatState.failed = report.failed
          heartbeatState.stage = 'erro'
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[erro] HLS ${video.name || videoId}: ${message}`)
          await markAssetFailed(db, assetToProcess.id, message)
          await updateMigrationQueueTask(db, taskId, {
            status: 'failed',
            current_stage: 'erro no HLS',
            error_message: message,
            completed_at: new Date().toISOString(),
            lease_expires_at: null,
            result: { assetId: assetToProcess.id, videoId, hls: false },
          })
          await notifier.send(`deu erro no HLS do video "${video.name || videoId}": ${message}`)
        } finally {
          if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }

      if (duplicate) {
        if (processAfterUpload && asset.status === 'uploaded' && asset.source_key) {
          console.log(`[hls] processando duplicado ja copiado: ${finalFolderPath.join('/') || 'Raiz'} -> ${video.name || fileName}`)
          await notifier.video(currentIndex, `ja achei "${video.name || fileName}" copiado em ${finalFolderPath.join('/') || 'Raiz'}; vou garantir o HLS antes de seguir.`)
          if (pipelineHls) {
            queueHlsTask(() => processHls(asset, null, null))
          } else {
            await withHlsSlot(() => processHls(asset, null, null))
          }
          return
        }

        report.duplicates += 1
        heartbeatState.duplicates = report.duplicates
        console.log(`[skip] duplicado na pasta: ${finalFolderPath.join('/') || 'Raiz'} -> ${video.name || fileName}`)
        await updateMigrationQueueTask(db, taskId, {
          status: 'completed',
          current_stage: 'duplicado ja existia',
          progress_percent: 100,
          completed_at: new Date().toISOString(),
          lease_expires_at: null,
          result: { assetId: asset.id, videoId, duplicate: true },
        })
        await notifier.video(currentIndex, `pulei duplicado: "${video.name || fileName}" ja existe em ${finalFolderPath.join('/') || 'Raiz'}.`)
        return
      }

      const sourceKey = asset.source_key || generateSourceKey(asset.id, fileName)
      if (!asset.source_key) {
        await db.from('video_assets').update({ source_key: sourceKey }).eq('id', asset.id)
      }

      console.log(`[copy] ${reusedFailed ? 'retomando ' : ''}${finalFolderPath.join('/') || 'Raiz'} -> ${video.name || fileName}`)
      heartbeatState.stage = 'upload para R2'
      heartbeatState.percent = 0
      await notifier.video(
        currentIndex,
        `${reusedFailed ? 'retomando' : 'copiando'} video ${limit > 0 ? `${currentIndex}/${limit}` : `#${currentIndex}`}: "${video.name || fileName}" (${humanSize(size)}) para ${finalFolderPath.join('/') || 'Raiz'}.`,
      )
      if (useLocalFileTransfer) {
        localTempDir = await mkdtemp(path.join(os.tmpdir(), 'vimeo-migration-'))
        localSourcePath = path.join(localTempDir, path.basename(sourceKey))
        heartbeatState.stage = 'download do Vimeo'
        heartbeatState.percent = 0
        await notifier.video(currentIndex, `baixando "${displayTitle}" para temporario da VPS antes de subir ao R2.`)
        downloadProgress(0, true)
        await downloadVimeoFileToLocal({
          downloadUrl,
          destinationPath: localSourcePath,
          contentLength: size,
          onProgress: (progress) => {
            downloadBytes = progress.transferredBytes
            downloadTotalBytes = progress.totalBytes || downloadTotalBytes
            heartbeatState.stage = 'download do Vimeo'
            heartbeatState.percent = progress.percent
            downloadProgress(progress.percent, progress.percent >= 100)
          },
          onRetry: (attempt, maxAttempts, error) => notifier.video(
            currentIndex,
            `download Vimeo "${displayTitle}" oscilou (${error.message}). Vou tentar novamente ${attempt}/${maxAttempts}.`,
          ),
        })

        heartbeatState.stage = 'upload arquivo para R2'
        heartbeatState.percent = null
        await notifier.video(currentIndex, `download ok para "${displayTitle}". Subindo arquivo temporario para R2.`)
        await uploadFileToR2(localSourcePath, sourceKey, contentType, r2Config.bucket)
      } else {
        uploadProgress(0, true)
        await uploadVimeoFileToR2({
          downloadUrl,
          sourceKey,
          contentType,
          contentLength: size,
          bucket: r2Config.bucket,
          onProgress: (progress) => {
            uploadBytes = progress.transferredBytes
            uploadTotalBytes = progress.totalBytes || uploadTotalBytes
            heartbeatState.stage = 'upload para R2'
            heartbeatState.percent = progress.percent
            uploadProgress(progress.percent, progress.percent >= 100)
          },
          onRetry: (attempt, maxAttempts, error) => notifier.video(
            currentIndex,
            `upload para R2 "${displayTitle}" oscilou (${error.message}). Vou tentar novamente ${attempt}/${maxAttempts}.`,
          ),
        })
      }
      const uploaded = await markAssetUploaded(db, asset.id, sourceKey)
      report.copied += 1
      heartbeatState.copied = report.copied

      heartbeatState.stage = processAfterUpload ? 'convertendo para HLS' : 'upload concluido'
      heartbeatState.percent = processAfterUpload ? 5 : 100
      await notifier.video(
        currentIndex,
        processAfterUpload
          ? `R2 ok para "${video.name || fileName}". Agora estou convertendo para HLS.`
          : `R2 ok para "${video.name || fileName}".`,
      )
      if (processAfterUpload && pipelineHls) {
        const tempDirForHls = localTempDir
        const sourcePathForHls = localSourcePath
        localTempDir = null
        localSourcePath = null
        queueHlsTask(() => processHls(uploaded, sourcePathForHls, tempDirForHls))
      } else if (processAfterUpload) {
        await withHlsSlot(() => processHls(uploaded, localSourcePath, null))
      } else {
        heartbeatState.percent = 100
        await updateMigrationQueueTask(db, taskId, {
          status: 'completed',
          current_stage: 'upload concluido',
          progress_percent: 100,
          completed_at: new Date().toISOString(),
          lease_expires_at: null,
          result: { assetId: uploaded.id, videoId, hls: false },
        })
      }
    } catch (error) {
      report.failed += 1
      heartbeatState.failed = report.failed
      heartbeatState.stage = 'erro'
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[erro] ${video.name || videoId}: ${message}`)
      if (assetId) await markAssetFailed(db, assetId, message)
      await updateMigrationQueueTask(db, taskId, {
        status: 'failed',
        current_stage: 'erro',
        error_message: message,
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
        result: { assetId, videoId },
      })
      await notifier.send(`deu erro no video "${video.name || videoId}": ${message}`)
    } finally {
      if (localTempDir) await rm(localTempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (!loadedQueueFromCache) {
    heartbeatState.stage = rootOnly ? 'montando fila pela raiz' : 'montando fila pelas pastas'

    for (const folder of folders) {
      if (!canCollectMore()) break
      const folderPath = resolveVimeoFolderPath(folder, foldersByUri)
      if (!folderMatchesFilters(folder, folderPath, folderFilters, folderUriFilters)) continue
      const videos = await listVideosForFolder(folder, token, notifier)
      console.log(`[vimeo] pasta ${folderPath.join('/') || folder.name || folder.uri}: ${videos.length} videos`)
      if (envFlag('VIMEO_MIGRATION_NOTIFY_FOLDER_SCAN', false)) {
        await notifier.send(`pasta "${folderPath.join('/') || folder.name || folder.uri}" encontrada com ${videos.length} videos.`)
      }

      for (const video of videos) {
        const videoId = parseVimeoId(video.uri || video.link || '')
        if (videoId) seenInFolders.add(videoId)
        collectVideo(video, folderPath)
        if (!canCollectMore()) break
      }
    }

    if (includeRootVideos && canCollectMore()) {
      const rootVideos = await listRootVideos(token, notifier)
      const orphanVideos = rootVideos.filter((video) => {
        const videoId = parseVimeoId(video.uri || video.link || '')
        return !videoId || !seenInFolders.has(videoId)
      })
      console.log(`[vimeo] videos sem pasta detectados para importar na raiz: ${orphanVideos.length}`)

      for (const video of orphanVideos) {
        collectVideo(video, [])
        if (!canCollectMore()) break
      }
    }

    if (queueCacheEnabled && migrationQueue.length > 0) {
      await saveMigrationQueueCache(r2Config.bucket, queueCacheKey, migrationQueue)
      console.log(`[vimeo] fila salva no cache R2: ${queueCacheKey}`)
    }
  }

  heartbeatState.stage = 'processando fila'
  heartbeatState.currentTitle = `${migrationQueue.length} videos na fila`
  heartbeatState.currentFolder = rootFolderName || 'Raiz'
  console.log(`[vimeo] fila pronta: ${migrationQueue.length} videos; concorrencia videos=${videoConcurrency}; hls=${processAfterUpload ? hlsConcurrency : 0}`)
  await notifier.send(`fila pronta: ${migrationQueue.length} videos para migrar. Vou rodar ${videoConcurrency} videos em paralelo e ${processAfterUpload ? hlsConcurrency : 0} HLS em paralelo.`)
  await runWithConcurrency(migrationQueue, videoConcurrency, async (item, index) => {
    await migrateVideo(item.video, item.folderPath, taskIds[index] || null)
  })
  if (hlsTasks.size > 0) {
    heartbeatState.stage = `aguardando ${hlsTasks.size} HLS terminar`
    console.log(`[hls] aguardando ${hlsTasks.size} processamento(s) HLS terminar(em)`)
    await Promise.all(Array.from(hlsTasks))
  }

  console.log('[vimeo] resumo:', JSON.stringify(report, null, 2))
  stopHeartbeat()
  await notifier.send(
    `finalizei a migracao. Escaneados: ${report.scanned}. Copiados: ${report.copied}. HLS processados: ${report.processed}. Duplicados: ${report.duplicates}. Sem download: ${report.skippedWithoutDownload}. Erros: ${report.failed}.`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
