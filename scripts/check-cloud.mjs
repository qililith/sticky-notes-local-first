import { loadEnv } from 'vite'

// Read-only preflight. Never print credentials or response bodies containing user data.
const env = loadEnv('development', process.cwd(), 'VITE_')
const projectUrl = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
if (!projectUrl || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local first.')
  process.exit(1)
}
const base = new URL(projectUrl)
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Use the HTTPS Project URL, without credentials, query parameters or an API path.')
}

let failed = 0
function report(ok, label, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'NOT READY'} ${label}${detail ? ` — ${detail}` : ''}`)
}
async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: { apikey: key, ...options.headers },
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}
function accessDenied(result) {
  return [401, 403].includes(result.status) && result.body?.code === '42501'
}

try {
  const health = await request('/auth/v1/health')
  report(health.status === 200, 'Auth endpoint', `HTTP ${health.status}`)
  const settings = await request('/auth/v1/settings')
  report(settings.status === 200 && settings.body?.disable_signup === true,
    'Public registration disabled', settings.status === 200 ? `disable_signup=${settings.body?.disable_signup}` : `HTTP ${settings.status}`)
  report(settings.status === 200 && settings.body?.external?.email === true,
    'Email/password login enabled', settings.status === 200 ? `email=${settings.body?.external?.email}` : `HTTP ${settings.status}`)

  for (const table of ['notes', 'folders', 'sync_changes', 'note_history', 'sync_counters', 'processed_mutations']) {
    const result = await request(`/rest/v1/${table}?select=*&limit=0`)
    report(accessDenied(result), `${table}: anonymous SELECT denied`,
      `HTTP ${result.status}${result.body?.code ? ` / ${result.body.code}` : ''}`)
  }
  const pull = await request('/rest/v1/rpc/pull_changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_after: '0', p_limit: 1 }),
  })
  report(accessDenied(pull), 'pull_changes: anonymous execution denied',
    `HTTP ${pull.status}${pull.body?.code ? ` / ${pull.body.code}` : ''}`)

  const privateSchema = await request('/rest/v1/notes?select=id&limit=0', { headers: { 'Accept-Profile': 'app_private' } })
  report(privateSchema.status === 406 && privateSchema.body?.code === 'PGRST106',
    'app_private excluded from Data API', `HTTP ${privateSchema.status}`)
} catch (error) {
  // Error names are enough for diagnostics; do not dump fetch objects or request headers.
  report(false, 'Connection check', error instanceof Error ? error.name : 'Unknown error')
}

console.log('Scope: service readiness and anonymous access only. Authenticated account isolation and device sync still need separate tests.')
process.exitCode = failed ? 1 : 0
