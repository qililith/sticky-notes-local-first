import { afterEach, expect, it, vi } from 'vitest'
import { db } from '../src/data/db'
import { importBackup, makeBackup, parseBackup, type BackupArchive } from '../src/data/backup'
import { createFolder, createNote, updateFolder, updateNote } from '../src/data/repository'

afterEach(async () => {
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.history.clear(), db.syncMeta.clear()])
})

const corruptions: [string, (archive: BackupArchive) => void][] = [
  ['invalid date', archive => { archive.notes[0].updatedAt = 'not-a-date' }],
  ['invalid pin type', archive => { Object.assign(archive.notes[0], { isPinned: 'false' }) }],
  ['negative revision', archive => { archive.notes[0].localRev = -1 }],
  ['unknown document node', archive => { archive.notes[0].doc.content = [{ type: 'unknown', text: '不可丢弃的正文' }] }],
  ['invalid document children', archive => { archive.notes[0].doc.content = [{ type: 'text', text: '不能直接放在根节点' }] }],
  ['unknown document mark', archive => { archive.notes[0].doc.content = [{ type: 'paragraph', content: [{ type: 'text', text: '正文', marks: [{ type: 'unknown' }] }] }] }],
  ['duplicate note IDs', archive => { archive.notes.push({ ...archive.notes[0], title: '另一份正文' }) }],
  ['missing folder', archive => { archive.notes[0].folderId = crypto.randomUUID() }],
  ['orphan pending record', archive => { archive.pending[0].entityId = crypto.randomUUID() }],
  ['broken pending payload', archive => { Object.assign(archive.pending[0], { payload: null }) }],
  ['invalid pending state type', archive => { Object.assign(archive.pending[0], { state: ['pending'] }) }],
  ['foreign pending owner', archive => { archive.pending[0].ownerId = 'account-other' }],
  ['duplicate pending ID', archive => { archive.pending.push({ ...archive.pending[0] }) }],
  ['malformed conflict', archive => { archive.conflicts.push({} as BackupArchive['conflicts'][number]) }],
  ['malformed history', archive => { archive.history.push({} as BackupArchive['history'][number]) }]
]

it.each(corruptions)('rejects %s before preview or any import writes', async (_label, corrupt) => {
  const note = await createNote('account-a', null)
  const archive = await makeBackup('account-a')
  corrupt(archive)
  expect(() => parseBackup(JSON.stringify(archive))).toThrow()
  await expect(importBackup('account-b', archive)).rejects.toThrow()
  expect(await db.notes.toArray()).toEqual([note])
  expect(await db.outbox.where('ownerId').equals('account-b').count()).toBe(0)
  expect(await db.history.count()).toBe(0)
})

it('keeps different folder-conflict versions as visible copies and deduplicates reimport', async () => {
  const folder = await createFolder('account-a', '本机分类')
  const conflictId = crypto.randomUUID()
  await db.conflicts.add({ id: conflictId, ownerId: 'account-a', entity: 'folder', entityId: folder.id,
    local: folder, remote: { ...folder, name: '云端旧分类', serverVersion: 1 }, createdAt: new Date().toISOString() })
  const oldArchive = await makeBackup('account-a')
  await db.conflicts.update(conflictId, { remote: { ...folder, name: '云端新分类', serverVersion: 2 } })
  const newArchive = await makeBackup('account-a')
  expect(await importBackup('account-b', oldArchive)).toEqual({ notes: 0, folders: 2, copies: 1 })
  expect(await importBackup('account-b', newArchive)).toEqual({ notes: 0, folders: 1, copies: 1 })
  expect(await importBackup('account-b', oldArchive)).toEqual({ notes: 0, folders: 0, copies: 0 })
  expect((await db.folders.where('ownerId').equals('account-b').toArray()).map(row => row.name).sort())
    .toEqual(['本机分类', '云端旧分类（冲突副本）', '云端新分类（冲突副本）'].sort())
  expect(await db.outbox.where('ownerId').equals('account-b').count()).toBe(3)
})

it('rolls back all imported folders, notes and queue entries after a later write fails', async () => {
  const folder = await createFolder('account-a', '分类')
  await createNote('account-a', folder.id)
  const archive = parseBackup(JSON.stringify(await makeBackup('account-a')))
  const before = { notes: await db.notes.toArray(), folders: await db.folders.toArray(), pending: await db.outbox.toArray() }
  const broken = vi.spyOn(db.notes, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'))
  try { await expect(importBackup('account-b', archive)).rejects.toThrow('Storage full') }
  finally { broken.mockRestore() }
  expect(await db.notes.toArray()).toEqual(before.notes)
  expect(await db.folders.toArray()).toEqual(before.folders)
  expect(await db.outbox.toArray()).toEqual(before.pending)
})

it.each(['account-a', 'account-b'])('preserves changed folder snapshots and their note relations for %s', async target => {
  const folder = await createFolder('account-a', '旧分类')
  const note = await createNote('account-a', folder.id)
  const oldArchive = await makeBackup('account-a')
  await updateFolder('account-a', folder.id, { name: '新分类' })
  await updateNote('account-a', note.id, { title: '新便签' })
  const newArchive = await makeBackup('account-a')
  await importBackup(target, oldArchive)
  await importBackup(target, newArchive)
  const folders = await db.folders.where('ownerId').equals(target).toArray()
  const notes = await db.notes.where('ownerId').equals(target).toArray()
  expect(folders).toHaveLength(2)
  expect(notes).toHaveLength(2)
  const oldNote = notes.find(row => !row.title.startsWith('新便签'))!
  const newNote = notes.find(row => row.title.startsWith('新便签'))!
  expect(folders.find(row => row.id === oldNote.folderId)?.name).toMatch(/^旧分类/)
  expect(folders.find(row => row.id === newNote.folderId)?.name).toMatch(/^新分类/)
  expect(await importBackup(target, oldArchive)).toEqual({ notes: 0, folders: 0, copies: 0 })
  expect(await importBackup(target, newArchive)).toEqual({ notes: 0, folders: 0, copies: 0 })
  expect(await db.folders.get(folder.id)).toMatchObject({ name: '新分类' })
})

it('reuses an unchanged folder from the earlier ID-only import rule', async () => {
  const folder = await createFolder('account-a', '旧分类')
  await createNote('account-a', folder.id)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`account-b\0account-a\0folder\0${folder.id}`)))
  hash[6] = (hash[6] & 0x0f) | 0x40
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = [...hash.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const legacyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  const legacy = { ...folder, id: legacyId, ownerId: 'account-b' }
  await db.folders.add(legacy)
  const archive = await makeBackup('account-a')
  expect(await importBackup('account-b', archive)).toEqual({ notes: 1, folders: 0, copies: 1 })
  expect((await db.notes.where('ownerId').equals('account-b').first())?.folderId).toBe(legacyId)
  expect(await importBackup('account-b', archive)).toEqual({ notes: 0, folders: 0, copies: 0 })
  await updateFolder('account-a', folder.id, { name: '新分类' })
  expect((await importBackup('account-b', await makeBackup('account-a'))).folders).toBe(1)
  expect(await db.folders.get(legacyId)).toEqual(legacy)
})
