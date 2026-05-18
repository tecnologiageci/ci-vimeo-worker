/**
 * Acesso único ao Supabase self-hosted da Conhecimento Integrado
 * (api.bancodedados.conhecimentointegrado.com.br).
 *
 * Variáveis aceitas:
 *   NEXT_PUBLIC_SUPABASE_URL        URL do Supabase
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   anon key (browser + server)
 *   SUPABASE_SERVICE_ROLE_KEY       service role (somente server)
 */
export function getSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || ''
}

export function getSupabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
}

/** Service role: server only — nunca expor ao cliente. */
export function getSupabaseServiceRoleKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

/** true se a API server-side pode ignorar RLS no Supabase (CRM, tracking, etc). */
export function hasSupabaseServiceRole(): boolean {
  return !!getSupabaseServiceRoleKey().trim()
}
