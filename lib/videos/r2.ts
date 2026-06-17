import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getIntegrationSecretOrEnv } from '@/lib/integrationSecrets'
import type { R2ObjectSummary } from './types'

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  publicBaseUrl: string
}

const PROVIDER = 'cloudflare_r2'

async function getSecret(key: string, envKey: string) {
  return (await getIntegrationSecretOrEnv(PROVIDER, key, envKey)).trim()
}

export async function getR2Config(bucketOverride?: string | null): Promise<R2Config> {
  const accountId = await getSecret('account_id', 'R2_ACCOUNT_ID')
  const accessKeyId = await getSecret('access_key_id', 'R2_ACCESS_KEY_ID')
  const secretAccessKey = await getSecret('secret_access_key', 'R2_SECRET_ACCESS_KEY')
  const bucket = (bucketOverride || '').trim() || await getSecret('bucket', 'R2_BUCKET')
  const publicBaseUrl =
    (await getSecret('public_base_url', 'R2_PUBLIC_BASE_URL')) ||
    (process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL || '').trim()

  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl }
}

export async function assertR2Config(bucketOverride?: string | null) {
  const config = await getR2Config(bucketOverride)
  const missing = [
    ['R2_ACCOUNT_ID', config.accountId],
    ['R2_ACCESS_KEY_ID', config.accessKeyId],
    ['R2_SECRET_ACCESS_KEY', config.secretAccessKey],
    ['R2_BUCKET', config.bucket],
  ].filter(([, value]) => !value)

  if (missing.length > 0) {
    throw new Error(`Cloudflare R2 não configurado: ${missing.map(([key]) => key).join(', ')}`)
  }

  return config
}

export function createR2Client(config: R2Config) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

export async function getR2ClientAndConfig() {
  const config = await assertR2Config()
  return { config, client: createR2Client(config) }
}

export async function getR2ClientAndConfigForBucket(bucketOverride?: string | null) {
  const config = await assertR2Config(bucketOverride)
  return { config, client: createR2Client(config) }
}

export function sanitizeFileSegment(value: string) {
  const fallback = 'video'
  const cleaned = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
  return cleaned || fallback
}

export function generateSourceKey(assetId: string, fileName: string) {
  const ext = path.extname(fileName) || '.mp4'
  const base = sanitizeFileSegment(path.basename(fileName, ext))
  return `videos/${assetId}/source/${base}${ext.toLowerCase()}`
}

export function generateFileFingerprint(fileName: string, size: number, contentType = '') {
  const normalizedName = sanitizeFileSegment(fileName).toLowerCase()
  const normalizedSize = Number.isFinite(size) && size > 0 ? Math.round(size) : 0
  return `${normalizedName}:${normalizedSize}:${contentType.trim().toLowerCase()}`
}

export function guessContentType(key: string) {
  const lower = key.toLowerCase()
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (lower.endsWith('.ts')) return 'video/mp2t'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.vtt')) return 'text/vtt; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

export function cacheControlForKey(key: string) {
  const lower = key.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.m4s') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) {
    return 'public, max-age=31536000, immutable'
  }
  if (lower.endsWith('.m3u8')) return 'public, max-age=300, stale-while-revalidate=86400'
  if (lower.endsWith('.vtt') || lower.endsWith('.json')) return 'public, max-age=300'
  return undefined
}

export function buildPublicR2ObjectUrl(publicBaseUrl: string, key: string) {
  const base = publicBaseUrl.trim().replace(/\/+$/, '')
  if (!base) return null
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${base}/${encodedKey}`
}

function bodyToReadable(body: any): Readable {
  if (!body) throw new Error('Objeto R2 sem corpo de resposta.')
  if (typeof body.pipe === 'function') return body as Readable
  if (typeof body.transformToWebStream === 'function') {
    return Readable.fromWeb(body.transformToWebStream())
  }
  if (Symbol.asyncIterator in body) return Readable.from(body)
  throw new Error('Formato de stream R2 não suportado.')
}

export async function getObjectText(key: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const body = bodyToReadable(result.Body)
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function getObjectBuffer(key: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const body = bodyToReadable(result.Body)
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: result.ContentType || guessContentType(key),
  }
}

export async function downloadObjectToFile(key: string, destination: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  await pipeline(bodyToReadable(result.Body), createWriteStream(destination))
}

export async function getObjectReadStream(key: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  return {
    stream: bodyToReadable(result.Body),
    contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : null,
    contentType: result.ContentType || guessContentType(key),
  }
}

export async function uploadFileToR2(
  localPath: string,
  key: string,
  contentType = guessContentType(key),
  bucket?: string | null,
) {
  const file = await stat(localPath)
  const maxAttempts = Math.max(1, Number(process.env.R2_FILE_UPLOAD_RETRIES || 4))
  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await uploadStreamToR2(createReadStream(localPath), key, contentType, file.size, bucket)
      return
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt))
    }
  }

  throw lastError
}

export async function uploadBufferToR2(
  buffer: Buffer | string,
  key: string,
  contentType = guessContentType(key),
  bucket?: string | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControlForKey(key),
  }))
}

export async function uploadStreamToR2(
  stream: Readable,
  key: string,
  contentType = guessContentType(key),
  contentLength?: number | null,
  bucket?: string | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const multipartThreshold = Math.max(5, Number(process.env.R2_MULTIPART_THRESHOLD_MB || 64)) * 1024 * 1024
  if ((contentLength || 0) >= multipartThreshold) {
    await uploadStreamMultipartToR2(client, config.bucket, stream, key, contentType)
    return
  }

  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: stream,
    ContentType: contentType,
    CacheControl: cacheControlForKey(key),
    ...(contentLength && contentLength > 0 ? { ContentLength: contentLength } : {}),
  }))
}

export function getBrowserMultipartPartSize(contentLength: number | null | undefined) {
  const preferred = Math.max(8, Number(process.env.R2_BROWSER_MULTIPART_PART_SIZE_MB || 128)) * 1024 * 1024
  const maxParts = 10_000
  const required = contentLength && contentLength > 0 ? Math.ceil(contentLength / maxParts) : 0
  return Math.max(5 * 1024 * 1024, preferred, required)
}

export async function createMultipartUploadForBrowser(
  key: string,
  contentType = guessContentType(key),
  bucket?: string | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType,
  }))
  if (!created.UploadId) throw new Error('R2 não retornou UploadId para multipart upload.')
  return { uploadId: created.UploadId, bucket: config.bucket }
}

export async function createPresignedUploadPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  bucket?: string | null,
  expiresInSeconds = 60 * 60 * 6,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const command = new UploadPartCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function completeMultipartUploadFromUploadedParts(
  key: string,
  uploadId: string,
  bucket?: string | null,
  expectedPartCount?: number | null,
  expectedSize?: number | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const parts: Array<{ ETag?: string; PartNumber?: number; Size?: number }> = []
  let marker: string | undefined

  do {
    const result = await client.send(new ListPartsCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: marker,
    }))
    parts.push(...(result.Parts || []).map((part) => ({
      ETag: part.ETag,
      PartNumber: part.PartNumber,
      Size: part.Size,
    })))
    marker = result.IsTruncated ? result.NextPartNumberMarker : undefined
  } while (marker)

  const validParts = parts
    .filter((part): part is { ETag: string; PartNumber: number } => Boolean(part.ETag && part.PartNumber))
    .sort((a, b) => a.PartNumber - b.PartNumber)

  if (validParts.length === 0) throw new Error('Nenhuma parte enviada foi encontrada no R2.')
  if (expectedPartCount && validParts.length !== expectedPartCount) {
    throw new Error(`Upload incompleto no R2: ${validParts.length}/${expectedPartCount} partes enviadas.`)
  }

  const uploadedSize = parts.reduce((sum, part) => sum + Number(part.Size || 0), 0)
  if (expectedSize && uploadedSize > 0 && uploadedSize !== expectedSize) {
    throw new Error(`Upload incompleto no R2: ${uploadedSize}/${expectedSize} bytes enviados.`)
  }

  await client.send(new CompleteMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: validParts },
  }))
}

export async function abortMultipartUploadInR2(
  key: string,
  uploadId: string,
  bucket?: string | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  await client.send(new AbortMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
  }))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt: number) {
  return Math.min(30_000, 1_500 * attempt)
}

async function uploadStreamMultipartToR2(
  client: S3Client,
  bucket: string,
  stream: Readable,
  key: string,
  contentType: string,
) {
  const partSize = Math.max(5, Number(process.env.R2_MULTIPART_PART_SIZE_MB || 16)) * 1024 * 1024
  const maxAttempts = Math.max(1, Number(process.env.R2_MULTIPART_PART_RETRIES || 3))
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    CacheControl: cacheControlForKey(key),
  }))
  const uploadId = created.UploadId
  if (!uploadId) throw new Error('R2 não retornou UploadId para multipart upload.')

  const parts: Array<{ ETag?: string; PartNumber: number }> = []
  let partNumber = 1
  let pending = Buffer.alloc(0)

  async function uploadPart(body: Buffer) {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
        }))
        parts.push({ ETag: result.ETag, PartNumber: partNumber })
        partNumber += 1
        return
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts) await sleep(1000 * attempt)
      }
    }
    throw lastError
  }

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      pending = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer
      while (pending.length >= partSize) {
        await uploadPart(pending.subarray(0, partSize))
        pending = pending.subarray(partSize)
      }
    }

    if (pending.length > 0 || parts.length === 0) await uploadPart(pending)

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }))
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    })).catch(() => undefined)
    throw error
  }
}

export async function createPresignedPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 60 * 60 * 2,
  bucket?: string | null,
) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

function encodeDispositionFilename(filename: string) {
  const fallback = sanitizeFileSegment(filename).replace(/[^\x20-\x7E]/g, '') || 'download'
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export async function createPresignedDownloadUrl(args: {
  key: string
  bucket?: string | null
  filename: string
  contentType?: string | null
  expiresInSeconds?: number
}) {
  const { client, config } = await getR2ClientAndConfigForBucket(args.bucket)
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: args.key,
    ResponseContentDisposition: encodeDispositionFilename(args.filename),
    ResponseContentType: args.contentType || guessContentType(args.key),
  })
  return getSignedUrl(client, command, { expiresIn: args.expiresInSeconds || 60 * 60 * 2 })
}

export async function headR2Object(key: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  return client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
}

export async function listR2Objects(prefix = '', maxKeys = 100, bucket?: string | null): Promise<R2ObjectSummary[]> {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const result = await client.send(new ListObjectsV2Command({
    Bucket: config.bucket,
    Prefix: prefix || undefined,
    MaxKeys: Math.max(1, Math.min(maxKeys, 1000)),
  }))

  return (result.Contents || [])
    .filter((item) => item.Key)
    .map((item) => ({
      key: item.Key!,
      size: Number(item.Size || 0),
      lastModified: item.LastModified ? item.LastModified.toISOString() : null,
    }))
}

export async function deleteR2Objects(keys: Array<string | null | undefined>, bucket?: string | null) {
  const uniqueKeys = Array.from(new Set(keys.filter((key): key is string => Boolean(key))))
  if (uniqueKeys.length === 0) return

  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    const batch = uniqueKeys.slice(index, index + 1000)
    await client.send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    }))
  }
}

export async function listR2KeysByPrefix(prefix: string, bucket?: string | null) {
  const { client, config } = await getR2ClientAndConfigForBucket(bucket)
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }))
    ;(result.Contents || []).forEach((item) => {
      if (item.Key) keys.push(item.Key)
    })
    continuationToken = result.NextContinuationToken
  } while (continuationToken)

  return keys
}

export async function deleteR2Prefix(prefix: string | null | undefined, bucket?: string | null) {
  if (!prefix) return
  const keys = await listR2KeysByPrefix(prefix.endsWith('/') ? prefix : `${prefix}/`, bucket)
  await deleteR2Objects(keys, bucket)
}

export async function writeJsonMetadata(key: string, value: unknown, bucket?: string | null) {
  await uploadBufferToR2(JSON.stringify(value, null, 2), key, 'application/json; charset=utf-8', bucket)
}

export async function writeLocalJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}
