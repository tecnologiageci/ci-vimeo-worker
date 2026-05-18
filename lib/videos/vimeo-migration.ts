import path from 'node:path'
import { sanitizeFileSegment } from './r2'

export interface VimeoDownloadFile {
  link?: string | null
  download_link?: string | null
  link_secure?: string | null
  public_name?: string | null
  quality?: string | null
  rendition?: string | null
  type?: string | null
  width?: number | string | null
  height?: number | string | null
  size?: number | string | null
}

export interface VimeoVideoLike {
  uri?: string | null
  link?: string | null
  name?: string | null
  description?: string | null
  duration?: number | string | null
  width?: number | string | null
  height?: number | string | null
  download?: VimeoDownloadFile[] | null
  files?: VimeoDownloadFile[] | null
}

export interface VimeoFolderLike {
  uri?: string | null
  name?: string | null
  parent_folder?: {
    uri?: string | null
    name?: string | null
  } | null
  metadata?: {
    connections?: {
      ancestor_path?: Array<{
        uri?: string | null
        name?: string | null
      }> | null
    } | null
  } | null
}

export function parseVimeoId(value: string | null | undefined) {
  if (!value) return null
  const match = value.match(/(?:videos?|clip)\/(\d+)/i) || value.match(/vimeo\.com\/(?:.*\/)?(\d+)(?:$|[/?#])/i)
  if (match?.[1]) return match[1]

  const numericSegments = value.match(/\d+/g)
  return numericSegments?.at(-1) || null
}

export function parseVimeoFolderId(value: string | null | undefined) {
  if (!value) return null
  const match = value.match(/(?:projects|folders)\/([^/?#]+)/i)
  return match?.[1] || null
}

export function getVimeoDownloadUrl(file: VimeoDownloadFile | null | undefined) {
  return file?.download_link || file?.link_secure || file?.link || null
}

function toNumber(value: number | string | null | undefined) {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function labelFor(file: VimeoDownloadFile) {
  return [
    file.quality,
    file.rendition,
    file.public_name,
    file.type,
    getVimeoDownloadUrl(file),
  ].filter(Boolean).join(' ').toLowerCase()
}

function scoreDownload(file: VimeoDownloadFile) {
  const label = labelFor(file)
  let score = 0

  if (label.includes('mp4') || label.includes('video/mp4')) score += 1_000_000_000
  if (label.includes('source') || label.includes('original')) score += 100_000_000
  if (label.includes('4k') || label.includes('2160')) score += 40_000_000
  if (label.includes('2k') || label.includes('1440')) score += 30_000_000
  if (label.includes('1080')) score += 20_000_000
  if (label.includes('720')) score += 10_000_000
  if (label.includes('hls') || label.includes('dash') || label.includes('m3u8') || label.includes('mpd')) {
    score -= 500_000_000
  }

  score += toNumber(file.width) * 10_000
  score += toNumber(file.height) * 100
  score += Math.min(toNumber(file.size), 10_000_000_000) / 10_000

  return score
}

export function selectBestVimeoDownload(files: VimeoDownloadFile[] | null | undefined) {
  const candidates = (files || [])
    .filter((file) => Boolean(getVimeoDownloadUrl(file)))
    .filter((file) => {
      const label = labelFor(file)
      return !label.includes('m3u8') && !label.includes('mpd') && !label.includes('dash')
    })

  return candidates.sort((a, b) => scoreDownload(b) - scoreDownload(a))[0] || null
}

export function selectBestVideoDownload(video: VimeoVideoLike) {
  return selectBestVimeoDownload([
    ...(video.download || []),
    ...(video.files || []),
  ])
}

export function normalizeFolderName(value: string | null | undefined) {
  const name = (value || '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim()
  return name || 'Sem nome'
}

export function normalizeFolderPath(parts: Array<string | null | undefined>) {
  return parts.map(normalizeFolderName).filter(Boolean)
}

export function resolveVimeoFolderPath(
  folder: VimeoFolderLike,
  foldersByUri: Map<string, VimeoFolderLike>,
) {
  const ancestorPath = folder.metadata?.connections?.ancestor_path
  if (Array.isArray(ancestorPath) && ancestorPath.length > 0) {
    return normalizeFolderPath([
      ...ancestorPath.slice().reverse().map((ancestor) => ancestor.name),
      folder.name,
    ])
  }

  const segments: string[] = []
  const visited = new Set<string>()
  let current: VimeoFolderLike | undefined = folder

  while (current) {
    const uri = current.uri || ''
    if (uri) {
      if (visited.has(uri)) break
      visited.add(uri)
    }

    segments.unshift(normalizeFolderName(current.name))
    const parentUri: string | null = current.parent_folder?.uri || null
    current = parentUri ? foldersByUri.get(parentUri) : undefined
  }

  return segments
}

function extensionFromContentType(contentType: string | null | undefined) {
  const type = (contentType || '').toLowerCase()
  if (type.includes('webm')) return '.webm'
  if (type.includes('quicktime') || type.includes('mov')) return '.mov'
  return '.mp4'
}

function extensionFromUrl(url: string | null) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const ext = path.extname(parsed.pathname)
    return ext ? ext.toLowerCase() : null
  } catch {
    const ext = path.extname(url.split('?')[0] || '')
    return ext ? ext.toLowerCase() : null
  }
}

export function buildVimeoFileName(video: VimeoVideoLike, file: VimeoDownloadFile, fallbackVideoId: string) {
  const rawName = video.name || `vimeo-${fallbackVideoId}`
  const sanitized = sanitizeFileSegment(rawName)
  const ext = path.extname(sanitized) || extensionFromUrl(getVimeoDownloadUrl(file)) || extensionFromContentType(file.type)
  const base = path.extname(sanitized) ? sanitized.slice(0, -path.extname(sanitized).length) : sanitized
  return `${base}${ext.toLowerCase()}`
}

export function buildVimeoFingerprint(videoId: string) {
  return `vimeo:${videoId}`
}

export function normalizeVimeoApiPath(value: string) {
  if (/^https?:\/\//i.test(value)) return value
  return value.startsWith('/') ? value : `/${value}`
}

export function vimeoFileSize(file: VimeoDownloadFile | null | undefined) {
  return toNumber(file?.size)
}
