import crypto from 'node:crypto'
import { createSupabaseAdmin } from '@/lib/supabaseAdmin'

const ALGORITHM = 'aes-256-gcm'

function keyFromRaw(raw?: string) {
  if (!raw) return null
  return crypto.createHash('sha256').update(raw).digest()
}

function getWriteKey() {
  return keyFromRaw(process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function getReadKeys() {
  const keys: Buffer[] = []
  const primary = keyFromRaw(process.env.SUPABASE_SERVICE_ROLE_KEY)
  const legacy = keyFromRaw(process.env.INTEGRATION_SECRETS_KEY)
  if (primary) keys.push(primary)
  if (legacy && !primary?.equals(legacy)) keys.push(legacy)
  return keys
}

export function getIntegrationVaultSource(): 'service_role' | 'legacy_dedicated_key' | null {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return 'service_role'
  if (process.env.INTEGRATION_SECRETS_KEY) return 'legacy_dedicated_key'
  return null
}

export function canUseIntegrationVault() {
  return !!getWriteKey()
}

export function encryptIntegrationSecret(value: string) {
  const key = getWriteKey()
  if (!key) {
    throw new Error('Cofre indisponível: configure SUPABASE_SERVICE_ROLE_KEY')
  }

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':')
}

export function decryptIntegrationSecret(payload: string) {
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(':')
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error('Formato de segredo inválido')
  }

  const keys = getReadKeys()
  if (keys.length === 0) {
    throw new Error('Cofre indisponível: configure SUPABASE_SERVICE_ROLE_KEY')
  }

  let lastError: unknown
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivRaw, 'base64'))
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64'))

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha ao descriptografar segredo')
}

export async function getIntegrationSecret(provider: string, secretKey: string) {
  const supabase = createSupabaseAdmin()
  if (!supabase || !canUseIntegrationVault()) return null

  const { data, error } = await supabase
    .from('integration_secrets')
    .select('encrypted_value')
    .eq('provider', provider)
    .eq('secret_key', secretKey)
    .maybeSingle()

  if (error || !data?.encrypted_value) return null
  try {
    return decryptIntegrationSecret(data.encrypted_value)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[integration-secrets] Falha ao descriptografar ${provider}/${secretKey}: ${message}`)
    return null
  }
}

export async function getIntegrationSecretOrEnv(provider: string, secretKey: string, envKey: string) {
  const fromVault = await getIntegrationSecret(provider, secretKey)
  return fromVault || process.env[envKey] || ''
}
