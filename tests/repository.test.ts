import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/data/db'
import { downloadBackup, makeBackup, importBackup, parseBackup } from '../src/data/backup'
import { clearAccountFromDevice, createFolder, createNote, createNoteWithContent, deleteFolder, setNoteContent, updateFolder, updateNote } from '../src/data/repository'
import { isAccountSyncPaused, resumeAccountSync } from '../src/data/accountSyncGate'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'
import { titleWithSuffix } from '../src/data/limits'
import { emptyDocument } from '../src/data/types'

afterEach(async () => {
  setUnresolvedEditorDraft(false)
  resumeAccountSync('account-a')
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.syncMeta.clear(), db.history.clear()])
})

describe('local data', () => {
  it('saves a note and outbox entry atomically and coalesces pending edits', async () => {
    const note = await createNote('account-a', null)
    const changed = await setNoteContent('account-a', note.id, emptyDocument, '内容', '标题', note.localRev)
    expect(changed.localRev).toBe(2)
    expect((await db.notes.get(note.id))?.title).toBe('标题')
    const queued = await db.outbox.where('ownerId').equals('account-a').toArray()
    expect(queued).toHaveLength(1)
    expect(queued[0].localRev).toBe(2)
    expect(queued[0].payload).toMatchObject({ title: '标题', plainText: '内容' })
  })

  it('rolls back a new note if the outbox write fails', async () => {
    const broken = vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'))
    try {
      await expect(createNote('account-a', null)).rejects.toThrow('Storage full')
      expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(0)
    } finally { broken.mockRestore() }
  })

  it('refreshes a folder conflict snapshot when the local name changes', async () => {
    const folder = await createFolder('account-a', '旧名称')
    await db.conflicts.put({ id: crypto.randomUUID(), ownerId: 'account-a', entity: 'folder', entityId: folder.id,
      local: folder, remote: { ...folder, name: '云端名称', serverVersion: 1 }, createdAt: new Date().toISOString() })
    await updateFolder('account-a', folder.id, { name: '本机新名称' })
    expect((await db.conflicts.where('entityId').equals(folder.id).first())?.local).toMatchObject({ name: '本机新名称' })
  })

  it('rejects a stale editor and another account', async () => {
    const note = await createNote('account-a', null)
    await updateNote('account-a', note.id, { title: '新值' })
    await expect(updateNote('account-a', note.id, { title: '旧值' }, note.localRev)).rejects.toThrow('其他窗口')
    await expect(updateNote('account-b', note.id, { title: '跨账号' })).rejects.toThrow('不存在')
    expect((await db.notes.get(note.id))?.title).toBe('新值')
  })

  it('rejects names beyond the database limit before changing local data', async () => {
    const note = await createNote('account-a', null)
    const folder = await createFolder('account-a', '有效名称')
    const tooLong = '字'.repeat(256)
    await expect(updateNote('account-a', note.id, { title: tooLong })).rejects.toThrow('最多 255')
    await expect(createNoteWithContent('account-a', null, tooLong, emptyDocument, '')).rejects.toThrow('最多 255')
    await expect(createFolder('account-a', tooLong)).rejects.toThrow('最多 255')
    await expect(updateFolder('account-a', folder.id, { name: tooLong })).rejects.toThrow('最多 255')
    expect((await db.notes.get(note.id))?.title).toBe('')
    expect((await db.folders.get(folder.id))?.name).toBe('有效名称')
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(2)
    expect(titleWithSuffix('字'.repeat(255), '（导入副本）')).toBe('字'.repeat(255))
  })

  it('imports the same archive only once without overwriting current work', async () => {
    const folder = await createFolder('account-a', '资料')
    const note = await createNote('account-a', folder.id)
    await updateNote('account-a', note.id, { title: '原文' })
    const archive = await makeBackup('account-a')
    await updateNote('account-a', note.id, { title: '后来修改' })
    const first = await importBackup('account-a', archive)
    const second = await importBackup('account-a', archive)
    expect(first.notes).toBe(1)
    expect(second.notes).toBe(0)
    expect((await db.notes.get(note.id))?.title).toBe('后来修改')
    expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(2)
  })

  it('preserves changed content from a later backup of the same note', async () => {
    const note = await createNote('account-a', null)
    await updateNote('account-a', note.id, { title: '旧备份内容' })
    const oldArchive = await makeBackup('account-a')
    await updateNote('account-a', note.id, { title: '中间内容' })
    await importBackup('account-a', oldArchive)
    const laterArchive = await makeBackup('account-a')
    laterArchive.notes = laterArchive.notes.filter(item => item.id === note.id)
    await updateNote('account-a', note.id, { title: '当前内容' })
    const result = await importBackup('account-a', laterArchive)
    expect(result.notes).toBe(1)
    expect((await db.notes.where('ownerId').equals('account-a').toArray()).map(item => item.title).sort())
      .toEqual(['中间内容（导入副本）', '当前内容', '旧备份内容（导入副本）'].sort())
  })

  it('keeps imported data inside the target account', async () => {
    const original = await createNote('account-a', null)
    await updateNote('account-a', original.id, { title: '私人便签' })
    const archive = await makeBackup('account-a')
    await importBackup('account-b', archive)
    expect((await db.notes.where('ownerId').equals('account-b').first())?.title).toContain('私人便签')
    expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(1)
  })

  it('deletes a folder without deleting its notes', async () => {
    const folder = await createFolder('account-a', '临时分类')
    const note = await createNote('account-a', folder.id)
    await deleteFolder('account-a', folder.id)
    expect((await db.folders.get(folder.id))?.deletedAt).not.toBeNull()
    expect((await db.notes.get(note.id))?.folderId).toBeNull()
    expect((await db.notes.get(note.id))?.deletedAt).toBeNull()
  })

  it('rejects a malformed backup before changing local data', async () => {
    expect(() => parseBackup('{broken')).toThrow('JSON')
    expect(() => parseBackup(JSON.stringify({ schema: 999, notes: [] }))).toThrow('不符合要求')
    expect(await db.notes.count()).toBe(0)
  })

  it('rejects an oversized backup title before importing anything', async () => {
    const note = await createNote('account-a', null)
    const archive = await makeBackup('account-a')
    archive.notes[0].title = '字'.repeat(256)
    expect(() => parseBackup(JSON.stringify(archive))).toThrow('最多 255')
    expect((await db.notes.get(note.id))?.title).toBe('')
  })

  it('does not export a backup while an editor write is still pending', async () => {
    const endWrite = beginEditorWrite()
    try {
      await expect(downloadBackup('account-a')).rejects.toThrow('本地仍在保存')
    } finally { endWrite() }
  })

  it('does not export or clear while a failed draft is still in the editor', async () => {
    await createNote('local-demo', null)
    setUnresolvedEditorDraft(true)
    await expect(downloadBackup('local-demo')).rejects.toThrow('备份无法包含')
    await expect(clearAccountFromDevice('local-demo')).rejects.toThrow('草稿尚未保存')
    expect(await db.notes.where('ownerId').equals('local-demo').count()).toBe(1)
  })

  it('blocks clearing unsynced real accounts but allows resetting local demo data', async () => {
    await createNote('account-a', null)
    await expect(clearAccountFromDevice('account-a')).rejects.toThrow('未同步')
    expect(isAccountSyncPaused('account-a')).toBe(false)
    await createNote('local-demo', null)
    await clearAccountFromDevice('local-demo')
    expect(await db.notes.where('ownerId').equals('local-demo').count()).toBe(0)
    expect(await db.outbox.where('ownerId').equals('local-demo').count()).toBe(0)
    expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(1)
  })

  it('does not clear demo data while an editor write is still pending', async () => {
    await createNote('local-demo', null)
    const endWrite = beginEditorWrite()
    try {
      await expect(clearAccountFromDevice('local-demo')).rejects.toThrow('本地仍在保存')
      expect(await db.notes.where('ownerId').equals('local-demo').count()).toBe(1)
    } finally { endWrite() }
  })

  it('restores original IDs and folder relations from a same-account archive on an empty device', async () => {
    const folder = await createFolder('local-demo', '原文件夹')
    const note = await createNote('local-demo', folder.id)
    await updateNote('local-demo', note.id, { title: '待恢复内容' })
    const archive = await makeBackup('local-demo')
    await clearAccountFromDevice('local-demo')
    const restored = await importBackup('local-demo', archive)
    expect(restored).toEqual({ notes: 1, folders: 1, copies: 0 })
    expect((await db.notes.get(note.id))).toMatchObject({ title: '待恢复内容', folderId: folder.id, serverVersion: 0 })
    expect((await db.folders.get(folder.id))?.name).toBe('原文件夹')
    expect((await db.outbox.where('ownerId').equals('local-demo').toArray()).every(item => item.baseVersion === 0)).toBe(true)
    expect(await importBackup('local-demo', archive)).toEqual({ notes: 0, folders: 0, copies: 0 })
  })
})

