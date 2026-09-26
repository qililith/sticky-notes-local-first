import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const demoMode = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true'
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null

export const accountKey = 'sticky-notes-last-account'

export function rememberAccount(user: User) {
  localStorage.setItem(accountKey, JSON.stringify({ id: user.id, email: user.email ?? '' }))
}

export function getRememberedAccount(): { id: string; email: string } | null {
  try {
    const raw = localStorage.getItem(accountKey)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      return { id: value.id, email: 'email' in value && typeof value.email === 'string' ? value.email : '' }
    }
  } catch { /* Ignore malformed local account hint. */ }
  return null
}

export function forgetAccount() {
  localStorage.removeItem(accountKey)
}
