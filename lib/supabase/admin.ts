import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseUrl, getSupabaseServiceRoleKey } from './env'

/** Cliente com service role (API routes / server only). */
export function createSupabaseAdmin(): SupabaseClient | null {
  const url = getSupabaseUrl()?.trim()
  const key = getSupabaseServiceRoleKey()?.trim()
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
