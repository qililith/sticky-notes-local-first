import { db } from './db'

export type PersistenceState = 'unknown' | 'granted' | 'denied' | 'unsupported'

export type AccountStorageEstimate = {
  notes: number
  folders: number
  outbox: number
  conflicts: number
  history: number
  noteBytes: number
  historyBytes: number
  queueBytes: number
  conflictBytes: number
  totalEstimatedBytes: number
  siteUsageBytes: number | null
  siteQuotaBytes: number | null
  persistence: PersistenceState
}

let persistence: PersistenceState = 'unknown'

export function persistenceState(): PersistenceState {
  return persistence
}

export function formatStorageBytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`
}

function estimatedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export async function recordPersistence(): Promise<PersistenceState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    persistence = 'unsupported'
    return persistence
  }
  try {
    persistence = await navigator.storage.persist() ? 'granted' : 'denied'
  } catch {
    persistence = 'unknown'
  }
  return persistence
}

export async function estimateAccountStorage(ownerId: string): Promise<AccountStorageEstimate> {
  const [notes, folders, outbox, conflicts, history] = await Promise.all([
    db.notes.where('ownerId').equals(ownerId).toArray(),
    db.folders.where('ownerId').equals(ownerId).toArray(),
    db.outbox.where('ownerId').equals(ownerId).toArray(),
    db.conflicts.where('ownerId').equals(ownerId).toArray(),
    db.history.where('ownerId').equals(ownerId).toArray()
  ])
  const noteBytes = estimatedBytes(notes) + estimatedBytes(folders)
  const historyBytes = estimatedBytes(history)
  const queueBytes = estimatedBytes(outbox)
  const conflictBytes = estimatedBytes(conflicts)
  let siteUsageBytes: number | null = null
  let siteQuotaBytes: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.usage !== undefined) siteUsageBytes = estimate.usage
    if (estimate?.quota !== undefined) siteQuotaBytes = estimate.quota
  } catch { /* Browser storage estimate is optional. */ }
  return {
    notes: notes.length,
    folders: folders.length,
    outbox: outbox.length,
    conflicts: conflicts.length,
    history: history.length,
    noteBytes,
    historyBytes,
    queueBytes,
    conflictBytes,
    totalEstimatedBytes: noteBytes + historyBytes + queueBytes + conflictBytes,
    siteUsageBytes,
    siteQuotaBytes,
    persistence
  }
}

export function persistenceLabel(state: PersistenceState): string {
  if (state === 'granted') return '浏览器已批准持久保存'
  if (state === 'denied') return '浏览器未批准持久保存，清理站点数据可能删掉本机副本'
  if (state === 'unsupported') return '当前环境不支持申请持久保存'
  return '尚未确认是否已批准持久保存'
}
