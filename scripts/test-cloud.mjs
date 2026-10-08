import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { loadEnv } from 'vite'

// Explicit, opt-in integration test: creates two temporary accounts and test data.
// Admin credentials stay in this Node process, never in files, logs or the frontend.
// Cleanup is restricted to IDs returned by createUser during this invocation.
const env = loadEnv('development', process.cwd(), 'VITE_')
const projectRef = process.argv[process.argv.indexOf('--project-ref') + 1]
if (!process.argv.includes('--project-ref') || !/^[a-z]{20}$/.test(projectRef ?? '')
  || env.VITE_SUPABASE_URL !== `https://${projectRef}.supabase.co`
  || !env.VITE_SUPABASE_PUBLISHABLE_KEY) {
  console.error('Supply --project-ref for a TEST project matching .env.local. This test creates and removes temporary accounts/data.')
  process.exit(1)
}

const runId = randomUUID()
const accounts = []
const sessions = []
let admin
let step = 'Load project credentials through the authenticated CLI'
let failed = false
const tables = ['note_history', 'sync_changes', 'processed_mutations', 'notes', 'folders', 'sync_counters']
const options = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(25_000) }) },
}
const client = key => createClient(env.VITE_SUPABASE_URL, key, options)
class CheckFailure extends Error {}
function check(condition, label) {
  if (!condition) throw new CheckFailure(label)
}
function ok(result, label) {
  // Do not throw SDK errors: they can carry request details or user data.
  if (result.error) {
    const code = /^[a-zA-Z0-9_]+$/.test(result.error.code ?? '') ? result.error.code : 'unknown'
    throw new CheckFailure(`${label} (code=${code})`)
  }
  return result.data
}
function pass(label) { console.log(`PASS ${label}`) }
const payload = text => ({ title: 'Temporary cloud verification', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  docVersion: 1, plainText: text, folderId: null, isPinned: false, deletedAt: null })
const mutation = (entity, entityId, baseVersion, body, mutationId = randomUUID()) => ({
  p_mutation_id: mutationId, p_entity: entity, p_entity_id: entityId, p_base_version: baseVersion, p_payload: body,
})
const apply = async (device, request) => ok(await device.rpc('apply_mutation', request), 'Mutation rejected unexpectedly')

try {
  step = 'Verify test project has closed registration and working email login'
  const settingsResponse = await options.global.fetch(`${env.VITE_SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY },
  })
  const settings = await settingsResponse.json()
  check(settingsResponse.ok && settings.disable_signup === true && settings.external?.email === true, 'Auth configuration is not ready')
  step = 'Load project credentials through the authenticated CLI'
  const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath,
    [cli, 'projects', 'api-keys', '--project-ref', projectRef, '--output', 'json'],
    { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
  const keys = JSON.parse(stdout)
  const adminKey = Array.isArray(keys) && keys.find(key => key.name === 'service_role' && typeof key.api_key === 'string')?.api_key
  check(adminKey, 'No service-role credential available through CLI')
  admin = client(adminKey)

  step = 'Create temporary test accounts and sign in on three isolated clients'
  for (const label of ['a', 'b']) {
    const email = `codex-${runId}-${label}@example.com`
    const password = `${randomBytes(32).toString('base64url')}aA1!`
    const data = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true,
      app_metadata: { cloud_test_run: runId } }), 'Could not create temporary account')
    check(data.user?.id, 'Missing new account ID')
    accounts.push({ id: data.user.id, email, password })
  }
  async function login(account) {
    const device = client(env.VITE_SUPABASE_PUBLISHABLE_KEY)
    const data = ok(await device.auth.signInWithPassword({ email: account.email, password: account.password }), 'Test login failed')
    check(data.user?.id === account.id && data.session, 'Unexpected login identity')
    sessions.push(device)
    return device
  }
  const [a1, a2, b] = await Promise.all([login(accounts[0]), login(accounts[0]), login(accounts[1])])
  pass('Admin-created accounts can sign in with public registration disabled')

  step = 'Create notes and folder through authenticated RPC'
  const folderId = randomUUID()
  const noteId = randomUUID()
  const otherNoteId = randomUUID()
  const folder = await apply(a1, mutation('folder', folderId, 0, { name: 'Temporary folder', sortOrder: 0, deletedAt: null }))
  check(folder.status === 'ok', 'Folder creation failed')
  const body = { ...payload('first'), folderId }
  const request = mutation('note', noteId, 0, body)
  const first = await apply(a1, request)
  check(first.status === 'ok' && first.record?.owner_id === accounts[0].id && first.record.version === 1, 'Unexpected first note')
  check((await apply(b, mutation('note', otherNoteId, 0, payload('other account')))).status === 'ok', 'Other account creation failed')
  pass('Authenticated RPC creates account-owned notes and folders')

  step = 'Verify idempotent retries and immutable mutation IDs'
  const retry = await apply(a2, request)
  check(JSON.stringify(retry) === JSON.stringify(first), 'Retry created a different result')
  check(Boolean((await a1.rpc('apply_mutation', { ...request, p_payload: payload('changed request') })).error), 'Mutation ID reuse was accepted')
  pass('Retry returns the original result; changed content cannot reuse a mutation ID')

  step = 'Verify cross-account reads and protected internal tables'
  for (const table of ['notes', 'folders', 'sync_changes', 'note_history']) {
    const rows = ok(await b.from(table).select('owner_id').eq('owner_id', accounts[0].id), 'Cross-account query failed')
    check(rows.length === 0, 'Cross-account data exposed')
  }
  const aRows = ok(await a1.from('notes').select('id,owner_id'), 'Own note read failed')
  check(aRows.length === 1 && aRows[0].id === noteId && aRows[0].owner_id === accounts[0].id, 'Own note visibility mismatch')
  for (const table of ['processed_mutations', 'sync_counters']) {
    check((await a1.from(table).select('*').limit(0)).error?.code === '42501', 'Internal table was accessible')
  }
  pass('RLS isolates notes, folders, change streams and history; internal tables are denied')

  step = 'Verify direct writes and cross-account mutation attempts are denied'
  for (const device of [a1, b]) {
    check((await device.from('notes').update({ title: 'should not write' }).eq('id', noteId)).error?.code === '42501', 'Direct UPDATE allowed')
    check((await device.from('notes').delete().eq('id', noteId)).error?.code === '42501', 'Direct DELETE allowed')
    check((await device.from('notes').insert({ id: randomUUID(), owner_id: accounts[0].id, doc: body.doc, version: 1 })).error?.code === '42501', 'Direct INSERT allowed')
  }
  for (const deletedAt of [null, new Date().toISOString()]) {
    const denied = await apply(b, mutation('note', noteId, 1, { ...body, folderId: null, deletedAt }))
    check(denied.status === 'conflict' && denied.record === null, 'Cross-account RPC exposed or changed a note')
  }
  check(Boolean((await b.rpc('apply_mutation', mutation('note', noteId, 0, { ...body, folderId: null }))).error), 'Cross-account ID collision was accepted')
  check(Boolean((await b.rpc('apply_mutation', mutation('note', otherNoteId, 1, body))).error), 'Cross-account folder reference was accepted')
  const otherFolder = await apply(b, mutation('folder', folderId, 1, { name: 'unauthorized rename', sortOrder: 0, deletedAt: null }))
  check(otherFolder.status === 'conflict' && otherFolder.record === null, 'Cross-account folder update was accepted')
  check(ok(await a1.from('notes').select('version,title').eq('id', noteId).single(), 'Cannot verify original').version === 1, 'Unauthorized attempt changed version')
  pass('Direct INSERT/UPDATE/DELETE and cross-account RPC cannot modify existing notes')

  step = 'Verify stale-device conflict and explicit resolution'
  const second = await apply(a1, mutation('note', noteId, 1, { ...body, ...payload('device one'), folderId }))
  const stale = await apply(a2, mutation('note', noteId, 1, { ...body, ...payload('device two'), folderId }))
  check(second.status === 'ok' && second.record.version === 2, 'Second version not saved')
  check(stale.status === 'conflict' && stale.record?.version === 2 && stale.record.plain_text === 'device one', 'Stale device overwrote server')
  const resolved = await apply(a2, mutation('note', noteId, 2, { ...body, ...payload('explicit resolution'), folderId }))
  check(resolved.status === 'ok' && resolved.record.version === 3, 'Conflict resolution failed')
  const history = ok(await a1.from('note_history').select('version,snapshot').eq('note_id', noteId).order('version'), 'History query failed')
  check(history.length === 3 && history[0].snapshot.plain_text === 'first' && history[1].snapshot.plain_text === 'device one', 'Previous contents missing from history')
  pass('Stale-device updates preserve the server version; explicit resolution retains history')

  step = 'Verify tombstone, stale resurrection rejection and restore'
  const deleted = await apply(a1, mutation('note', noteId, 3, { ...payload('explicit resolution'), folderId, deletedAt: new Date().toISOString() }))
  check(deleted.status === 'ok' && deleted.record.version === 4 && deleted.record.deleted_at, 'Tombstone missing')
  const staleRestore = await apply(a2, mutation('note', noteId, 3, payload('stale resurrection')))
  check(staleRestore.status === 'conflict' && staleRestore.record?.deleted_at, 'Old device resurrected a deleted note silently')
  const restored = await apply(a2, mutation('note', noteId, 4, { ...payload('restored'), folderId }))
  check(restored.status === 'ok' && restored.record.version === 5 && restored.record.deleted_at === null, 'Restore failed')
  pass('Deletion is a tombstone; stale devices conflict; explicit restore succeeds')

  step = 'Verify concurrent updates have exactly one winner'
  const concurrent = await Promise.all([a1, a2].map((device, index) => apply(device, mutation('note', noteId, 5, { ...payload(`concurrent-${index}`), folderId }))))
  check(concurrent.filter(result => result.status === 'ok').length === 1 && concurrent.filter(result => result.status === 'conflict').length === 1, 'Concurrent writes did not serialize')
  check(concurrent.every(result => result.record?.version === 6), 'Concurrent results disagree on current version')
  pass('Concurrent same-version writes produce one commit and one conflict')

  step = 'Verify change-stream pagination and account isolation'
  let cursor = '0'
  const changes = []
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = ok(await a2.rpc('pull_changes', { p_after: cursor, p_limit: 2 }), 'Pull failed')
    check(Array.isArray(page.items) && typeof page.next === 'string', 'Malformed pull response')
    for (const item of page.items) {
      check(item.record.owner_id === accounts[0].id && BigInt(item.seq) > BigInt(cursor), 'Wrong owner or non-increasing cursor')
      cursor = item.seq
      changes.push(item)
    }
    check(page.next === cursor, 'Cursor does not match last change')
    if (page.items.length < 2) break
  }
  check(changes.length === 7 && new Set(changes.map(change => change.seq)).size === 7, 'Missing or duplicate changes')
  check(changes.some(change => change.record.deleted_at), 'Deletion absent from change stream')
  pass('Paginated changes include every committed version and tombstone without cross-account rows')

  step = 'Verify rejected oversized content and deleted folder do not lose data'
  const oversizedId = randomUUID()
  check(Boolean((await a1.rpc('apply_mutation', mutation('note', noteId, 6, payload('字'.repeat(100_000)), oversizedId))).error), 'Oversized mutation accepted')
  const shortened = await apply(a1, mutation('note', noteId, 6, payload('shortened'), oversizedId))
  check(shortened.status === 'ok' && shortened.record.version === 7, 'Rejected ID could not be retried with corrected data')
  check((await apply(a1, mutation('folder', folderId, 1, { name: 'Temporary folder', sortOrder: 0, deletedAt: new Date().toISOString() }))).status === 'ok', 'Folder delete failed')
  check(Boolean((await a1.rpc('apply_mutation', mutation('note', noteId, 7, { ...payload('bad folder'), folderId }))).error), 'Deleted folder reference accepted')
  const retained = ok(await a2.from('notes').select('version,plain_text').eq('id', noteId).single(), 'Cannot read retained note')
  check(retained.version === 7 && retained.plain_text === 'shortened', 'Rejected request changed saved content')
  pass('Rejected oversized payload and deleted-folder reference leave confirmed data intact')

  step = 'Verify local-scope sign-out and refresh-token revocation'
  const beforeLogout = ok(await a1.auth.getSession(), 'Cannot read test session').session
  ok(await a1.auth.signOut({ scope: 'local' }), 'Sign-out failed')
  check(ok(await a1.auth.getSession(), 'Cannot inspect signed-out client').session === null, 'Local session remains after logout')
  const refreshCheck = client(env.VITE_SUPABASE_PUBLISHABLE_KEY)
  check(Boolean((await refreshCheck.auth.refreshSession({ refresh_token: beforeLogout.refresh_token })).error), 'Logged-out session can still refresh')
  check(ok(await a2.auth.getUser(), 'Second device was signed out unexpectedly').user?.id === accounts[0].id, 'Second device identity changed')
  pass('Local sign-out removes that session and revokes refresh; the second device stays signed in')
  if (process.argv.includes('--browser')) {
    step = 'Production browser UI checks'
    const { runCloudBrowserChecks } = await import('./test-cloud-browser.mjs')
    await runCloudBrowserChecks({ accounts, readClient: a2, runId, projectUrl: env.VITE_SUPABASE_URL,
      naturalExpiry: process.argv.includes('--natural-expiry'),
      expiryDiagnostic: process.argv.includes('--expiry-diagnostic'),
      setTestAccountBBan: async banned => {
        ok(await admin.auth.admin.updateUserById(accounts[1].id, { ban_duration: banned ? '1h' : 'none' }), 'Test-account ban update failed')
      },
      revokeTestSession: async token => {
        const identity = ok(await admin.auth.getUser(token), 'Cannot verify test-session owner').user
        check(identity?.id === accounts[1].id, 'Refusing to revoke a non-test session')
        ok(await admin.auth.admin.signOut(token, 'local'), 'Test-session revocation failed')
      }
    })
  }
} catch (error) {
  failed = true
  console.error(`FAIL ${step}. Credentials and response bodies are omitted.`)
  if (error instanceof CheckFailure) console.error(error.message)
} finally {
  for (const device of sessions) {
    try { await device.auth.signOut({ scope: 'local' }) } catch { /* Account cleanup below revokes remaining sessions. */ }
  }
  for (const account of accounts) {
    let clean = true
    // These IDs came only from this run's successful createUser responses, never from a user-list query.
    for (const table of tables) {
      try {
        const result = await admin.from(table).delete().eq('owner_id', account.id)
        if (result.error) clean = false
        const remaining = await admin.from(table).select('owner_id', { count: 'exact', head: true }).eq('owner_id', account.id)
        if (remaining.error || remaining.count !== 0) clean = false
      } catch { clean = false }
    }
    if (clean) {
      try {
        if ((await admin.auth.admin.deleteUser(account.id)).error) clean = false
        else if ((await admin.auth.admin.getUserById(account.id)).error?.status !== 404) clean = false
      }
      catch { clean = false }
    }
    if (clean) pass(`Removed temporary account/data ${account.id}`)
    else {
      failed = true
      console.error(`CLEANUP NEEDED for test account ${account.id}, run ${runId}. No unrelated accounts were touched.`)
    }
  }
}
console.log(process.argv.includes('--browser')
  ? 'Scope: real API contracts and production Chrome UI in isolated contexts, not physical devices or mainland-network acceptance.'
  : 'Scope: real Auth/API/database contracts via isolated clients, not browser UI, physical devices or mainland-network acceptance.')
process.exitCode = failed ? 1 : 0
