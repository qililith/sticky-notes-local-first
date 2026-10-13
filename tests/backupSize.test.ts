import { afterEach, expect, it } from 'vitest'
import { assertBackupSize, makeBackup, OVERSIZE_BACKUP_MESSAGE, parseBackup } from '../src/data/backup'
import { db } from '../src/data/db'
import { createNote } from '../src/data/repository'
import { emptyDocument } from '../src/data/types'

afterEach(async () => {
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.history.clear(), db.syncMeta.clear()])
})

it('uses the same oversize message for export and import checks', () => {
  expect(() => assertBackupSize('x'.repeat(21), 20)).toThrow(OVERSIZE_BACKUP_MESSAGE)
  expect(() => assertBackupSize('ok', 20)).not.toThrow()
})

it('lets a current-data backup without history pass validation', async () => {
  const note = await createNote('account-a', null)
  await db.history.add({
    id: `account-a:${note.id}:1`, ownerId: 'account-a', noteId: note.id, serverVersion: 1,
    snapshot: { ...note, doc: emptyDocument }, createdAt: note.createdAt
  })
  const full = await makeBackup('account-a')
  const current = await makeBackup('account-a', { includeHistory: false })
  expect(full.history).toHaveLength(1)
  expect(current.history).toHaveLength(0)
  expect(parseBackup(JSON.stringify(current)).notes[0].id).toBe(note.id)
})
