import { afterEach, expect, it } from 'vitest'
import { db } from '../src/data/db'
import { createNote } from '../src/data/repository'
import { estimateAccountStorage, formatStorageBytes } from '../src/data/storageUsage'

afterEach(async () => {
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.history.clear(), db.syncMeta.clear()])
})

it('counts notes, queue and history separately and labels the estimate', async () => {
  const note = await createNote('account-a', null)
  await db.history.add({
    id: `account-a:${note.id}:1`, ownerId: 'account-a', noteId: note.id, serverVersion: 1,
    snapshot: note, createdAt: note.createdAt
  })
  const usage = await estimateAccountStorage('account-a')
  expect(usage.notes).toBe(1)
  expect(usage.outbox).toBe(1)
  expect(usage.history).toBe(1)
  expect(usage.historyBytes).toBeGreaterThan(0)
  expect(usage.totalEstimatedBytes).toBe(usage.noteBytes + usage.historyBytes + usage.queueBytes + usage.conflictBytes)
  expect(formatStorageBytes(1048576)).toBe('1.0 MiB')
})
