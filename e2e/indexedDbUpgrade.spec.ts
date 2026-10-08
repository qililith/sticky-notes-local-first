import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { notesDbStoresV1 } from '../src/data/dbSchema'

test('a real IndexedDB version upgrade preserves notes, queue, conflicts, cursor and history', async ({ page }) => {
  // Use a localhost origin: browsers deny IndexedDB on the opaque about:blank origin.
  await page.route('http://127.0.0.1:4179/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated IndexedDB fixture</title>' }))
  await page.goto('http://127.0.0.1:4179/')
  await page.addScriptTag({ path: resolve('node_modules/dexie/dist/dexie.js') })

  const databaseName = `migration-fixture-${crypto.randomUUID()}`
  const result = await page.evaluate(async ({ databaseName, storesV1 }) => {
    const Dexie = (window as unknown as { Dexie: new (name: string) => any }).Dexie
    const note = (id: string, title: string, folderId: string | null, serverVersion: number) => ({
      id, ownerId: 'account-a', title, doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      docVersion: 1, plainText: title, folderId, isPinned: false,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', deletedAt: null,
      localRev: 3, serverVersion, confirmedRev: 1
    })
    const folder = {
      id: 'folder-a', ownerId: 'account-a', name: '本机分类', sortOrder: 0,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', deletedAt: null,
      localRev: 2, serverVersion: 1, confirmedRev: 1
    }
    const notes = [note('note-a', '有未同步编辑', folder.id, 1), note('note-b', '保留中的草稿', null, 0)]
    const folders = [folder]
    const outbox = [
      { id: 'mutation-pending', ownerId: 'account-a', entity: 'note', entityId: 'note-a', baseVersion: 1, localRev: 3, payload: { title: notes[0].title, folderId: folder.id }, createdAt: '2026-10-02T00:00:00.000Z', state: 'pending' },
      { id: 'mutation-inflight', ownerId: 'account-a', entity: 'note', entityId: 'note-b', baseVersion: 0, localRev: 1, payload: { title: notes[1].title, folderId: null }, createdAt: '2026-10-02T00:00:01.000Z', state: 'inflight' },
      { id: 'mutation-conflict', ownerId: 'account-a', entity: 'note', entityId: 'note-a', baseVersion: 1, localRev: 3, payload: { title: notes[0].title, folderId: folder.id }, createdAt: '2026-10-02T00:00:01.500Z', state: 'conflict' },
      { id: 'mutation-rejected', ownerId: 'account-a', entity: 'folder', entityId: folder.id, baseVersion: 1, localRev: 2, payload: { name: folder.name, sortOrder: 0 }, createdAt: '2026-10-02T00:00:02.000Z', state: 'rejected', error: '需处理' }
    ]
    const conflicts = [{
      id: 'conflict-a', ownerId: 'account-a', entity: 'note', entityId: 'note-a',
      local: notes[0], remote: { ...notes[0], title: '云端版本', plainText: '云端版本', serverVersion: 2 },
      createdAt: '2026-10-02T00:00:03.000Z'
    }]
    const syncMeta = [{ ownerId: 'account-a', cursor: '42', lastSyncedAt: '2026-10-02T00:00:04.000Z', lastError: null,
      deferred: [{ seq: '41', entity: 'note', record: { id: 'note-remote', owner_id: 'account-a', version: 1 } }] }]
    const history = [{ id: 'account-a:note-a:1', ownerId: 'account-a', noteId: 'note-a', serverVersion: 1,
      snapshot: notes[0], createdAt: '2026-10-02T00:00:05.000Z' }]
    const tableNames = ['notes', 'folders', 'outbox', 'conflicts', 'syncMeta', 'history']
    const readAll = async (db: any) => Object.fromEntries(await Promise.all(tableNames.map(async name => [name, await db.table(name).toArray()])))

    const oldDb = new Dexie(databaseName)
    oldDb.version(1).stores(storesV1)
    await oldDb.open()
    await Promise.all([
      oldDb.table('notes').bulkPut(notes), oldDb.table('folders').bulkPut(folders),
      oldDb.table('outbox').bulkPut(outbox), oldDb.table('conflicts').bulkPut(conflicts),
      oldDb.table('syncMeta').bulkPut(syncMeta), oldDb.table('history').bulkPut(history)
    ])
    const before = await readAll(oldDb)
    oldDb.close()

    // Isolated, test-only v2 candidate: add an index without changing records.
    // The production app remains at v1 until a separately approved migration.
    const storesV2 = { ...storesV1, outbox: `${storesV1.outbox}, [ownerId+state]` }
    const upgradedDb = new Dexie(databaseName)
    upgradedDb.version(1).stores(storesV1)
    upgradedDb.version(2).stores(storesV2)
    await upgradedDb.open()
    const after = await readAll(upgradedDb)
    const outboxIndexes = upgradedDb.table('outbox').schema.indexes.map((index: { name: string }) => index.name)
    upgradedDb.close()
    await Dexie.delete(databaseName)
    return { before, after, outboxIndexes }
  }, { databaseName, storesV1: { ...notesDbStoresV1 } })

  expect(result.after).toEqual(result.before)
  expect(result.outboxIndexes).toContain('[ownerId+state]')
  expect(result.after.outbox.map(item => item.state).sort()).toEqual(['conflict', 'inflight', 'pending', 'rejected'])
  expect(result.after.conflicts).toHaveLength(1)
  expect(result.after.syncMeta[0].cursor).toBe('42')
  expect(result.after.history).toHaveLength(1)
})
