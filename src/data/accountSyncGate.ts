const pausedPrefix = 'sticky-notes-sync-paused:'
const clearedPrefix = 'sticky-notes-account-cleared:'
const queues = new Map<string, Promise<void>>()

export function isAccountSyncPaused(ownerId: string): boolean {
  return localStorage.getItem(`${pausedPrefix}${ownerId}`) === '1'
}

export function pauseAccountSync(ownerId: string): void {
  localStorage.setItem(`${pausedPrefix}${ownerId}`, '1')
}

export function resumeAccountSync(ownerId: string): void {
  localStorage.removeItem(`${pausedPrefix}${ownerId}`)
}

export function accountClearedEventKey(ownerId: string): string {
  return `${clearedPrefix}${ownerId}`
}

export function notifyAccountCleared(ownerId: string): void {
  try { localStorage.setItem(accountClearedEventKey(ownerId), crypto.randomUUID()) }
  catch { /* Sync remains paused even if another tab cannot be notified. */ }
}

export async function withAccountSyncLock<T>(ownerId: string, run: () => Promise<T>): Promise<T> {
  const name = `sticky-notes-sync:${ownerId}`
  if (navigator.locks) return navigator.locks.request(name, run)
  const previous = queues.get(name) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  queues.set(name, current)
  await previous
  try { return await run() }
  finally {
    release()
    if (queues.get(name) === current) queues.delete(name)
  }
}

