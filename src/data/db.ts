import Dexie, { type EntityTable } from 'dexie'
import { notesDbStoresV1, notesDbStoresV2 } from './dbSchema'
import type { Conflict, Folder, Mutation, Note, Revision, SyncMeta } from './types'
import { recordStorageDiagnostic } from './storageDiagnostics'

export class NotesDatabase extends Dexie {
  notes!: EntityTable<Note, 'id'>
  folders!: EntityTable<Folder, 'id'>
  outbox!: EntityTable<Mutation, 'id'>
  conflicts!: EntityTable<Conflict, 'id'>
  syncMeta!: EntityTable<SyncMeta, 'ownerId'>
  history!: EntityTable<Revision, 'id'>

  constructor(name = 'sticky-notes-v1') {
    super(name)
    this.version(1).stores(notesDbStoresV1)
    this.version(2).stores(notesDbStoresV2)
  }
}

export const db = new NotesDatabase()

export const LOCAL_DATABASE_TIMEOUT_MS = 2000

class LocalDatabaseTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LocalDatabaseTimeoutError(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function restartDatabaseConnection(timeoutMs = LOCAL_DATABASE_TIMEOUT_MS, source: 'startup' | 'save' | 'manual' = 'manual'): Promise<void> {
  const startedAt = performance.now()
  recordStorageDiagnostic('open-start', source)
  db.close()
  try {
    await withTimeout(db.open(), timeoutMs, '重新读取本机便签超时')
    recordStorageDiagnostic('open-ok', source, performance.now() - startedAt)
  } catch (error) {
    db.close()
    recordStorageDiagnostic('open-timeout', source, performance.now() - startedAt)
    throw error
  }
}

/** Recover one local write from a stalled IndexedDB connection. */
export async function runWithDatabaseRecovery<T>(operation: () => Promise<T>, timeoutMs = LOCAL_DATABASE_TIMEOUT_MS): Promise<T> {
  const startedAt = performance.now()
  try {
    return await withTimeout(operation(), timeoutMs, '本机保存超时')
  } catch (error) {
    if (!(error instanceof LocalDatabaseTimeoutError)) throw error
    recordStorageDiagnostic('save-timeout', 'save', performance.now() - startedAt)
  }

  await restartDatabaseConnection(timeoutMs, 'save')
  try {
    const result = await withTimeout(operation(), timeoutMs, '本机保存重试超时')
    recordStorageDiagnostic('save-retry-ok', 'save', performance.now() - startedAt)
    return result
  } catch (error) {
    recordStorageDiagnostic('save-retry-failed', 'save', performance.now() - startedAt)
    if (error instanceof LocalDatabaseTimeoutError) {
      db.close()
      throw new Error('本机保存暂时无响应，内容已放入恢复草稿，请点“重新保存”')
    }
    throw error
  }
}
