import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
const session = vi.hoisted(() => vi.fn())
const headers = vi.hoisted(() => vi.fn())
vi.mock('../src/auth', () => ({ supabase: {
  auth: { getSession: session },
  rpc: (name: string, args: Record<string, unknown>) => ({
    setHeader: (key: string, value: string) => { headers(key, value); return rpc(name, args) }
  })
} }))

import { db } from '../src/data/db'
import { isAccountSyncPaused, resumeAccountSync } from '../src/data/accountSyncGate'
import { clearAccountFromDevice, createFolder, createNote, setNoteContent, updateNote } from '../src/data/repository'
import { emptyDocument } from '../src/data/types'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'
import { resolveConflict, syncOnce } from '../src/sync/engine'

beforeEach(() => {
  session.mockResolvedValue({ data: { session: { user: { id: 'account-a' }, access_token: 'token-a' } }, error: null })
})

afterEach(async () => {
  setUnresolvedEditorDraft(false)
  resumeAccountSync('account-a'); resumeAccountSync('account-b')
  rpc.mockReset(); session.mockReset(); headers.mockReset()
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.syncMeta.clear(), db.history.clear()])
})

describe('sync sequencing', () => {
  it('does not recreate cleared device data from an in-flight pull', async () => {
    const note = await createNote('account-a', null)
    await db.outbox.clear()
    await db.notes.put({ ...note, serverVersion: 1, confirmedRev: note.localRev })
    let releasePull: (() => void) | undefined
    let signalPull: (() => void) | undefined
    const pullStarted = new Promise<void>(resolve => { signalPull = resolve })
    rpc.mockImplementation((name: string) => {
      if (name !== 'pull_changes') throw new Error('不应上行')
      signalPull?.()
      return new Promise(resolve => { releasePull = () => resolve({ data: { items: [{ seq: '1', entity: 'note', record: {
        id: note.id, owner_id: 'account-a', title: '云端便签', doc: emptyDocument, doc_version: 1,
        plain_text: '', folder_id: null, is_pinned: false, created_at: note.createdAt,
        updated_at: note.updatedAt, deleted_at: null, version: 2
      } }], next: '1' }, error: null }) })
    })
    const syncing = syncOnce('account-a')
    await pullStarted
    const clearing = clearAccountFromDevice('account-a')
    await Promise.race([clearing.then(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 200))])
    releasePull?.()
    await Promise.all([syncing, clearing])
    expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(0)
    expect(isAccountSyncPaused('account-a')).toBe(true)
    expect(await syncOnce('account-a')).toBe(false)
    await expect(createNote('account-a', null)).rejects.toThrow('重新登录')
    expect(await db.notes.where('ownerId').equals('account-a').count()).toBe(0)
  })
  it('refuses conflict resolution while a local editor draft is not durable', async () => {
    const note = await createNote('account-a', null)
    const conflictId = crypto.randomUUID()
    await db.conflicts.add({ id: conflictId, ownerId: 'account-a', entity: 'note', entityId: note.id,
      local: note, remote: { ...note, serverVersion: 1, title: '云端版' }, createdAt: new Date().toISOString() })
    const endWrite = beginEditorWrite()
    try {
      await expect(resolveConflict('account-a', conflictId, 'remote')).rejects.toThrow('本地仍在保存')
    } finally { endWrite() }
    setUnresolvedEditorDraft(true)
    await expect(resolveConflict('account-a', conflictId, 'remote')).rejects.toThrow('草稿尚未保存')
    expect((await db.notes.get(note.id))?.title).toBe('')
    expect(await db.conflicts.get(conflictId)).toBeDefined()
  })
  it('uses the updated base version for an edit queued during an inflight upload', async () => {
    const note = await createNote('account-a', null)
    const first = (await db.outbox.where('ownerId').equals('account-a').first())!
    await db.outbox.update(first.id, { state: 'inflight' })
    await setNoteContent('account-a', note.id, emptyDocument, '新内容', '新标题', note.localRev)
    const sentBases: number[] = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      sentBases.push(args.p_base_version as number)
      const version = sentBases.length
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: version === 1 ? '' : '新标题',
        doc: emptyDocument, doc_version: 1, plain_text: version === 1 ? '' : '新内容', folder_id: null,
        is_pinned: false, created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version
      } }, error: null }
    })
    await syncOnce('account-a')
    expect(sentBases).toEqual([0, 1])
    expect((await db.notes.get(note.id))?.serverVersion).toBe(2)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull()
  })

  it('invalidates a stale editor after a remote change instead of silently overwriting it', async () => {
    const note = await createNote('account-a', null)
    await db.outbox.clear()
    await db.notes.put({ ...note, serverVersion: 1, confirmedRev: note.localRev })
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [{ seq: '1', entity: 'note', record: {
        id: note.id, owner_id: 'account-a', title: '云端新标题', doc: emptyDocument,
        doc_version: 1, plain_text: '云端内容', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 2
      } }], next: '1' }, error: null }
      : { data: null, error: new Error('不应上行') })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.notes.get(note.id))?.localRev).toBe(2)
    await expect(setNoteContent('account-a', note.id, emptyDocument, '旧内容', '旧标题', note.localRev)).rejects.toThrow('其他窗口')
    expect((await db.notes.get(note.id))?.title).toBe('云端新标题')
  })

  it('retries the same frozen mutation after a lost response', async () => {
    const note = await createNote('account-a', null)
    const sent: Record<string, unknown>[] = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      sent.push(args)
      if (sent.length === 1) return { data: null, error: new Error('network response lost') }
      const secondVersion = sent.length === 3
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: secondVersion ? '新标题' : '', doc: emptyDocument, doc_version: 1,
        plain_text: secondVersion ? '后续编辑' : '', folder_id: null, is_pinned: false, created_at: note.createdAt,
        updated_at: note.updatedAt, deleted_at: null, version: secondVersion ? 2 : 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(false)
    await setNoteContent('account-a', note.id, emptyDocument, '后续编辑', '新标题', note.localRev)
    expect(await syncOnce('account-a')).toBe(true)
    expect(sent).toHaveLength(3)
    expect(sent[1]).toEqual(sent[0])
    expect(sent[2].p_base_version).toBe(1)
    expect(sent[2].p_payload).toMatchObject({ title: '新标题', plainText: '后续编辑' })
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
  })

  it('allows an oversized rejected snapshot to be shortened and retried', async () => {
    const note = await createNote('account-a', null)
    const oversized = await setNoteContent('account-a', note.id, emptyDocument, '过长内容', '长便签', note.localRev)
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Mutation too large') })
    expect(await syncOnce('account-a')).toBe(false)
    const rejected = (await db.outbox.where('ownerId').equals('account-a').first())!
    expect(rejected.state).toBe('pending')
    expect((await db.notes.get(note.id))?.plainText).toBe('过长内容')
    expect((await db.syncMeta.get('account-a'))?.lastError).toContain('请先导出备份')

    await setNoteContent('account-a', note.id, emptyDocument, '已缩短', '短便签', oversized.localRev)
    expect(await db.outbox.get(rejected.id)).toMatchObject({ state: 'pending', payload: { plainText: '已缩短' } })
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(1)
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [], next: '0' }, error: null }
      : { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '短便签', doc: emptyDocument,
        doc_version: 1, plain_text: '已缩短', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull()
  })

  it('drops only a rejected oversized snapshot when a newer edit is queued', async () => {
    const note = await createNote('account-a', null)
    let calls = 0
    rpc.mockImplementation(async (name: string) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      calls++
      if (calls === 1) {
        await setNoteContent('account-a', note.id, emptyDocument, '更新后的正文', '新版', note.localRev)
        return { data: null, error: new Error('Mutation too large') }
      }
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '新版', doc: emptyDocument,
        doc_version: 1, plain_text: '更新后的正文', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(false)
    const queued = await db.outbox.where('ownerId').equals('account-a').toArray()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ state: 'pending', payload: { plainText: '更新后的正文' } })
    expect(await syncOnce('account-a')).toBe(true)
    expect(calls).toBe(2)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
  })

  it('lets a note leave a remotely deleted folder after the server rejects its old snapshot', async () => {
    const folder = await createFolder('account-a', '旧分类')
    const note = await createNote('account-a', folder.id)
    await db.outbox.where('entityId').equals(folder.id).delete()
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Folder does not belong to account') })
    expect(await syncOnce('account-a')).toBe(false)
    const rejected = (await db.outbox.where('entityId').equals(note.id).first())!
    expect(rejected.state).toBe('pending')
    expect((await db.notes.get(note.id))?.folderId).toBe(folder.id)
    expect((await db.syncMeta.get('account-a'))?.lastError).toContain('移到“未分类”')

    await updateNote('account-a', note.id, { folderId: null })
    expect(await db.outbox.get(rejected.id)).toMatchObject({ state: 'pending', payload: { folderId: null } })
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [], next: '0' }, error: null }
      : { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '', doc: emptyDocument,
        doc_version: 1, plain_text: '', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.notes.get(note.id))?.folderId).toBeNull()
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
  })

  it('keeps the displayed local conflict snapshot current after later edits', async () => {
    const note = await createNote('account-a', null)
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [], next: '0' }, error: null }
      : { data: { status: 'conflict', record: {
        id: note.id, owner_id: 'account-a', title: '云端', doc: emptyDocument,
        doc_version: 1, plain_text: '云端正文', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    const conflict = (await db.conflicts.where('entityId').equals(note.id).first())!
    expect(conflict.local).toMatchObject({ title: '', plainText: '' })
    await setNoteContent('account-a', note.id, emptyDocument, '冲突后新写的正文', '本机新版', note.localRev)
    expect((await db.conflicts.get(conflict.id))?.local).toMatchObject({ title: '本机新版', plainText: '冲突后新写的正文' })
  })

  it('rejects a conflict response for a different account without discarding local work', async () => {
    const note = await createNote('account-a', null)
    rpc.mockResolvedValue({ data: { status: 'conflict', record: {
      id: note.id, owner_id: 'account-b', title: '不应接收', doc: emptyDocument,
      doc_version: 1, plain_text: '', folder_id: null, is_pinned: false,
      created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
    } }, error: null })
    expect(await syncOnce('account-a')).toBe(false)
    expect(await db.conflicts.where('ownerId').equals('account-a').count()).toBe(0)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(1)
    expect((await db.syncMeta.get('account-a'))?.lastError).toContain('不匹配的冲突记录')
  })

  it('accepts an identical remote record without making a false conflict', async () => {
    const note = await createNote('account-a', null)
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [], next: '0' }, error: null }
      : { data: { status: 'conflict', record: {
        id: note.id, owner_id: 'account-a', title: note.title, doc: { content: note.doc.content, type: 'doc' },
        doc_version: 1, plain_text: note.plainText, folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 5
      } }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await db.conflicts.where('ownerId').equals('account-a').count()).toBe(0)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.notes.get(note.id))?.serverVersion).toBe(5)
  })

  it('accepts an identical remote folder without making a false conflict', async () => {
    const folder = await createFolder('account-a', '资料')
    rpc.mockImplementation(async (name: string) => name === 'pull_changes'
      ? { data: { items: [], next: '0' }, error: null }
      : { data: { status: 'conflict', record: {
        id: folder.id, owner_id: 'account-a', name: folder.name, sort_order: folder.sortOrder,
        created_at: folder.createdAt, updated_at: folder.updatedAt, deleted_at: null, version: 3
      } }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await db.conflicts.where('ownerId').equals('account-a').count()).toBe(0)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.folders.get(folder.id))?.serverVersion).toBe(3)
  })

  it('keeps old-account mutations local when the active session belongs to another account', async () => {
    await createNote('account-b', null)
    expect(await syncOnce('account-b')).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
    expect(await db.outbox.where('ownerId').equals('account-b').count()).toBe(1)
    expect((await db.syncMeta.get('account-b'))?.lastError).toContain('账号与本地数据不匹配')
  })

  it('pins the same account token across every RPC in one sync run', async () => {
    const note = await createNote('account-a', null)
    rpc.mockImplementation(async (name: string) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      session.mockResolvedValue({ data: { session: { user: { id: 'account-b' }, access_token: 'token-b' } }, error: null })
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '', doc: emptyDocument, doc_version: 1,
        plain_text: '', folder_id: null, is_pinned: false, created_at: note.createdAt,
        updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(headers.mock.calls).toEqual([
      ['Authorization', 'Bearer token-a'],
      ['Authorization', 'Bearer token-a']
    ])
    expect(session).toHaveBeenCalledTimes(1)
  })
})

