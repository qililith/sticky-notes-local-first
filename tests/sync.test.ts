import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
const session = vi.hoisted(() => vi.fn())
const headers = vi.hoisted(() => vi.fn())
const authChange = vi.hoisted(() => vi.fn())
const unsubscribe = vi.hoisted(() => vi.fn())
vi.mock('../src/auth', () => ({ supabase: {
  auth: { getSession: session, onAuthStateChange: authChange },
  rpc: (name: string, args: Record<string, unknown>) => ({
    setHeader: (key: string, value: string) => { headers(key, value); return rpc(name, args) }
  })
} }))

import { db } from '../src/data/db'
import { isAccountSyncPaused, resumeAccountSync } from '../src/data/accountSyncGate'
import { clearAccountFromDevice, createFolder, createNote, setNoteContent, updateFolder, updateNote } from '../src/data/repository'
import { emptyDocument } from '../src/data/types'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'
import { resolveConflict, startSync, syncOnce } from '../src/sync/engine'

beforeEach(() => {
  session.mockResolvedValue({ data: { session: { user: { id: 'account-a' }, access_token: 'token-a' } }, error: null })
  authChange.mockReturnValue({ data: { subscription: { unsubscribe } } })
})

afterEach(async () => {
  setUnresolvedEditorDraft(false)
  resumeAccountSync('account-a'); resumeAccountSync('account-b')
  rpc.mockReset(); session.mockReset(); headers.mockReset()
  authChange.mockReset(); unsubscribe.mockReset()
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.syncMeta.clear(), db.history.clear()])
})

describe('sync sequencing', () => {
  it.each(['note', 'folder'] as const)('keeps a newer %s conflict when an older matching history entry is pulled', async entity => {
    const local = entity === 'note' ? await createNote('account-a', null) : await createFolder('account-a', '本机')
    const matching = { id: local.id, owner_id: 'account-a', version: 2, title: '', name: '本机',
      doc: emptyDocument, doc_version: 1, plain_text: '', folder_id: null, is_pinned: false,
      sort_order: 0, created_at: local.createdAt, updated_at: local.updatedAt, deleted_at: null }
    const newer = { ...matching, version: 3, title: '较新云端', name: '较新云端', plain_text: '较新云端' }
    rpc.mockImplementation(async (name: string) => name === 'apply_mutation'
      ? { data: { status: 'conflict', record: newer }, error: null }
      : { data: { items: [{ seq: '2', entity, record: matching }, { seq: '3', entity, record: newer }], next: '3' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    const stored = entity === 'note' ? await db.notes.get(local.id) : await db.folders.get(local.id)
    expect(stored).toEqual(local)
    const conflicts = await db.conflicts.where('entityId').equals(local.id).toArray()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].remote.serverVersion).toBe(3)
  })

  it('keeps edits saved during a folder rejection instead of replaying stale following content', async () => {
    const note = await createNote('account-a', 'deleted-folder')
    let calls = 0
    const sent: Array<{ title: string; folderId: string | null }> = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      const payload = args.p_payload as { title: string; folderId: string | null }
      sent.push(structuredClone(payload))
      if (++calls === 1) {
        await updateNote('account-a', note.id, { title: '请求期间保存的新标题', folderId: 'valid-folder' })
        return { data: null, error: new Error('Folder does not belong to account') }
      }
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: payload.title, doc: emptyDocument,
        doc_version: 1, plain_text: '', folder_id: payload.folderId, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await syncOnce('account-a')).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ title: '请求期间保存的新标题', folderId: 'valid-folder' })
    expect(await db.notes.get(note.id)).toMatchObject({ title: '请求期间保存的新标题', folderId: 'valid-folder' })
    expect(await db.outbox.count()).toBe(0)
  })

  it.each(['note', 'folder'] as const)('does not duplicate a %s conflict when its upload response is also pulled', async entity => {
    const local = entity === 'note' ? await createNote('account-a', null) : await createFolder('account-a', '本机')
    const remote = { id: local.id, owner_id: 'account-a', version: 3, title: '云端', name: '云端',
      doc: emptyDocument, doc_version: 1, plain_text: '云端正文', folder_id: null, is_pinned: false,
      sort_order: 0, created_at: local.createdAt, updated_at: local.updatedAt, deleted_at: null }
    rpc.mockImplementation(async (name: string) => name === 'apply_mutation'
      ? { data: { status: 'conflict', record: remote }, error: null }
      : { data: { items: [{ seq: '3', entity, record: remote }], next: '3' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await syncOnce('account-a')).toBe(true)
    const conflicts = await db.conflicts.where('entityId').equals(local.id).toArray()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].remote.serverVersion).toBe(3)
    expect(await db.outbox.get(conflicts[0].id)).toMatchObject({ state: 'conflict' })
  })

  it('uploads a newly selected folder before an older queued note', async () => {
    const note = await createNote('account-a', null)
    const original = (await db.outbox.where('entityId').equals(note.id).first())!
    await db.outbox.update(original.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    const folder = await createFolder('account-a', '新分类')
    await updateNote('account-a', note.id, { folderId: folder.id, title: '保留的标题', plainText: '保留的正文' })
    let folderExists = false
    const sent: string[] = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      sent.push(String(args.p_entity))
      if (args.p_entity === 'folder') {
        folderExists = true
        return { data: { status: 'ok', record: {
          id: folder.id, owner_id: 'account-a', name: folder.name, sort_order: folder.sortOrder,
          created_at: folder.createdAt, updated_at: folder.updatedAt, deleted_at: null, version: 1
        } }, error: null }
      }
      if (!folderExists) return { data: null, error: new Error('Folder does not belong to account') }
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '保留的标题', doc: emptyDocument,
        doc_version: 1, plain_text: '保留的正文', folder_id: folder.id, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(sent).toEqual(['folder', 'note'])
    expect(await db.outbox.count()).toBe(0)
    expect(await db.notes.get(note.id)).toMatchObject({ folderId: folder.id, plainText: '保留的正文', serverVersion: 1 })
    expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull()
  })

  it('retries the frozen folder dependency after a lost response before sending its later edit and the note', async () => {
    const note = await createNote('account-a', null)
    const first = (await db.outbox.where('entityId').equals(note.id).first())!
    await db.outbox.update(first.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    const folder = await createFolder('account-a', '原名')
    await updateNote('account-a', note.id, { folderId: folder.id })
    const sent: Record<string, unknown>[] = []
    let folderCalls = 0
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      sent.push(structuredClone(args))
      if (args.p_entity === 'folder') {
        if (++folderCalls === 1) return { data: null, error: new Error('Failed to fetch') }
        const payload = args.p_payload as { name: string; sortOrder: number }
        return { data: { status: 'ok', record: {
          id: folder.id, owner_id: 'account-a', name: payload.name, sort_order: payload.sortOrder,
          created_at: folder.createdAt, updated_at: folder.updatedAt, deleted_at: null, version: folderCalls - 1
        } }, error: null }
      }
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '', doc: emptyDocument,
        doc_version: 1, plain_text: '', folder_id: folder.id, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(false)
    expect(sent.map(args => args.p_entity)).toEqual(['folder'])
    await updateFolder('account-a', folder.id, { name: '新名' })
    expect(await syncOnce('account-a')).toBe(true)
    expect(sent.map(args => args.p_entity)).toEqual(['folder', 'folder', 'folder', 'note'])
    expect(sent[1]).toEqual(sent[0])
    expect(sent[2]).toMatchObject({ p_base_version: 1, p_payload: { name: '新名' } })
    expect(await db.folders.get(folder.id)).toMatchObject({ name: '新名', serverVersion: 2 })
    expect(await db.outbox.count()).toBe(0)
  })

  it('resumes promptly on same-account token refresh instead of waiting through failure backoff', async () => {
    session.mockResolvedValueOnce({ data: { session: null }, error: new Error('Failed to fetch') })
    rpc.mockResolvedValue({ data: { items: [], next: '0' }, error: null })
    const stop = startSync('account-a')
    try {
      await vi.waitFor(async () => expect((await db.syncMeta.get('account-a'))?.lastError).toContain('Failed to fetch'))
      const callback = authChange.mock.calls[0]?.[0]
      expect(callback).toBeTypeOf('function')
      callback('TOKEN_REFRESHED', { user: { id: 'account-a' } })
      // Auth callbacks must return without starting nested auth work under SDK locks.
      expect(session).toHaveBeenCalledTimes(1)
      await vi.waitFor(async () => expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull())
      expect(session).toHaveBeenCalledTimes(2)
    } finally { stop() }
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not lose reconnection while a failing sync is still running', async () => {
    let release!: (value: unknown) => void
    session.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    rpc.mockResolvedValue({ data: { items: [], next: '0' }, error: null })
    const stop = startSync('account-a')
    try {
      await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(1))
      window.dispatchEvent(new Event('online'))
      release({ data: { session: null }, error: new Error('Failed to fetch') })
      await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2))
      await vi.waitFor(async () => expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull())
    } finally { stop() }
  })

  it('ignores other-account refreshes and cancels a queued refresh trigger on stop', async () => {
    rpc.mockResolvedValue({ data: { items: [], next: '0' }, error: null })
    const stop = startSync('account-a')
    try {
      await vi.waitFor(async () => expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull())
      const callback = authChange.mock.calls[0]?.[0]
      expect(callback).toBeTypeOf('function')
      callback('TOKEN_REFRESHED', { user: { id: 'account-b' } })
      callback('SIGNED_OUT', null)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(session).toHaveBeenCalledTimes(1)
      callback('TOKEN_REFRESHED', { user: { id: 'account-a' } })
      stop()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(session).toHaveBeenCalledTimes(1)
    } finally { stop() }
  })

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
    rpc.mockResolvedValueOnce({ data: { items: [], next: '0' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    const rejected = (await db.outbox.where('ownerId').equals('account-a').first())!
    expect(rejected.state).toBe('rejected')
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
    expect(await syncOnce('account-a')).toBe(true)
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
    const sent: Array<string | null> = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      const folderId = (args.p_payload as { folderId?: string | null }).folderId ?? null
      sent.push(folderId)
      if (folderId) return { data: null, error: new Error('Folder does not belong to account') }
      return { data: { status: 'ok', record: {
        id: note.id, owner_id: 'account-a', title: '', doc: emptyDocument,
        doc_version: 1, plain_text: '', folder_id: null, is_pinned: false,
        created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(sent).toEqual([folder.id, null])
    expect((await db.notes.get(note.id))?.folderId).toBeNull()
    expect((await db.notes.get(note.id))?.plainText).toBe('')
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.syncMeta.get('account-a'))?.lastError).toBeNull()
  })

  it('moves local notes out of a folder when a tombstone is pulled', async () => {
    const folder = await createFolder('account-a', '将删除')
    const note = await createNote('account-a', folder.id)
    await db.outbox.clear()
    await db.folders.put({ ...folder, serverVersion: 1, confirmedRev: folder.localRev })
    await db.notes.put({ ...note, serverVersion: 1, confirmedRev: note.localRev })
    rpc.mockResolvedValueOnce({ data: { items: [{ seq: '3', entity: 'folder', record: {
      id: folder.id, owner_id: 'account-a', name: folder.name, sort_order: folder.sortOrder,
      created_at: folder.createdAt, updated_at: folder.updatedAt, deleted_at: '2026-10-02T00:00:00.000Z', version: 2
    } }], next: '3' }, error: null })
    rpc.mockResolvedValueOnce({ data: { items: [], next: '3' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.folders.get(folder.id))?.deletedAt).toBeTruthy()
    expect((await db.notes.get(note.id))?.folderId).toBeNull()
    expect(await db.outbox.where('entityId').equals(note.id).first()).toMatchObject({ state: 'pending', payload: { folderId: null } })
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

  it('keeps uploading other notes and still pulls after the server rejects one note', async () => {
    const rejectedNote = await createNote('account-a', null)
    const healthyNote = await createNote('account-a', null)
    const rejectedMutation = (await db.outbox.where('entityId').equals(rejectedNote.id).first())!
    await db.outbox.update(rejectedMutation.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    const remoteId = crypto.randomUUID()
    const calls: string[] = []
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      calls.push(name === 'pull_changes' ? 'pull' : String(args.p_entity_id))
      if (name === 'pull_changes') return { data: { items: [{ seq: '1', entity: 'note', record: {
        id: remoteId, owner_id: 'account-a', title: '另一台设备', doc: emptyDocument, doc_version: 1, plain_text: '云端新便签',
        folder_id: null, is_pinned: false, created_at: rejectedNote.createdAt, updated_at: rejectedNote.updatedAt, deleted_at: null, version: 1
      } }], next: '1' }, error: null }
      if (args.p_entity_id === rejectedNote.id) return { data: null, error: new Error('Mutation too large') }
      return { data: { status: 'ok', record: {
        id: healthyNote.id, owner_id: 'account-a', title: '', doc: emptyDocument, doc_version: 1, plain_text: '',
        folder_id: null, is_pinned: false, created_at: healthyNote.createdAt, updated_at: healthyNote.updatedAt, deleted_at: null, version: 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(calls).toEqual([rejectedNote.id, healthyNote.id, 'pull'])
    expect(await db.outbox.get(rejectedMutation.id)).toMatchObject({ state: 'rejected', error: expect.stringContaining('超过云端单次上传限制') })
    expect(await db.outbox.where('entityId').equals(healthyNote.id).count()).toBe(0)
    expect((await db.notes.get(remoteId))?.plainText).toBe('云端新便签')
    expect(await db.notes.get(rejectedNote.id)).toMatchObject({ serverVersion: 0, localRev: rejectedNote.localRev })
    expect((await db.syncMeta.get('account-a'))?.lastError).toContain('1 项被云端拒绝')
  })

  it('still stops the whole round on a network error', async () => {
    const first = await createNote('account-a', null)
    await createNote('account-a', null)
    const firstMutation = (await db.outbox.where('entityId').equals(first.id).first())!
    await db.outbox.update(firstMutation.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    rpc.mockResolvedValue({ data: null, error: new Error('Failed to fetch') })
    expect(await syncOnce('account-a')).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect((await db.outbox.get(firstMutation.id))?.state).toBe('inflight')
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(2)
  })

  it('still stops the whole round on an authentication error', async () => {
    const first = await createNote('account-a', null)
    await createNote('account-a', null)
    const firstMutation = (await db.outbox.where('entityId').equals(first.id).first())!
    await db.outbox.update(firstMutation.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    rpc.mockResolvedValue({ data: null, error: Object.assign(new Error('JWT expired'), { status: 401 }) })
    expect(await syncOnce('account-a')).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(await db.outbox.where('ownerId').equals('account-a').count()).toBe(2)
    expect((await db.syncMeta.get('account-a'))?.lastError).toContain('登录已失效')
  })

  it('applies other pulled records and defers a note whose format this app does not support', async () => {
    const newerId = crypto.randomUUID()
    const supportedId = crypto.randomUUID()
    const row = (id: string, version: number, docVersion: number, text: string) => ({
      id, owner_id: 'account-a', title: text, doc: emptyDocument, doc_version: docVersion, plain_text: text,
      folder_id: null, is_pinned: false, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null, version
    })
    rpc.mockResolvedValueOnce({ data: { items: [
      { seq: '1', entity: 'note', record: row(newerId, 1, 2, '新格式') },
      { seq: '2', entity: 'note', record: row(supportedId, 1, 1, '旧格式') }
    ], next: '2' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.notes.get(supportedId))?.plainText).toBe('旧格式')
    expect(await db.notes.get(newerId)).toBeUndefined()
    const meta = (await db.syncMeta.get('account-a'))!
    expect(meta.cursor).toBe('2')
    expect(meta.deferred).toEqual([expect.objectContaining({ entity: 'note', record: expect.objectContaining({ id: newerId, version: 1 }) })])
    expect(meta.lastError).toContain('更新应用')

    rpc.mockResolvedValueOnce({ data: { items: [], next: '2' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.syncMeta.get('account-a'))?.deferred).toHaveLength(1)

    rpc.mockResolvedValueOnce({ data: { items: [{ seq: '3', entity: 'note', record: row(newerId, 2, 1, '已转回旧格式') }], next: '3' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.notes.get(newerId))?.plainText).toBe('已转回旧格式')
    const after = (await db.syncMeta.get('account-a'))!
    expect(after.deferred ?? []).toHaveLength(0)
    expect(after.lastError).toBeNull()
  })

  it('marks only that note when its conflict copy uses an unsupported format', async () => {
    const note = await createNote('account-a', null)
    const other = await createNote('account-a', null)
    const noteMutation = (await db.outbox.where('entityId').equals(note.id).first())!
    await db.outbox.update(noteMutation.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'pull_changes') return { data: { items: [], next: '0' }, error: null }
      const id = String(args.p_entity_id)
      return { data: { status: id === note.id ? 'conflict' : 'ok', record: {
        id, owner_id: 'account-a', title: '云端', doc: emptyDocument, doc_version: id === note.id ? 2 : 1, plain_text: '云端',
        folder_id: null, is_pinned: false, created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: id === note.id ? 4 : 1
      } }, error: null }
    })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await db.outbox.get(noteMutation.id)).toMatchObject({ state: 'rejected', error: expect.stringContaining('更新应用') })
    expect(await db.outbox.where('entityId').equals(other.id).count()).toBe(0)
    expect(await db.conflicts.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.notes.get(note.id))?.plainText).toBe('')
  })

  it('accepts an identical pulled note when local edits have no upload queue', async () => {
    const note = await createNote('account-a', null)
    await db.outbox.clear()
    rpc.mockResolvedValueOnce({ data: { items: [{ seq: '1', entity: 'note', record: {
      id: note.id, owner_id: 'account-a', title: note.title, doc: emptyDocument, doc_version: 1, plain_text: note.plainText,
      folder_id: null, is_pinned: false, created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 4
    } }], next: '1' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(await db.conflicts.where('ownerId').equals('account-a').count()).toBe(0)
    expect((await db.notes.get(note.id))?.serverVersion).toBe(4)
    expect((await db.notes.get(note.id))?.confirmedRev).toBe(note.localRev)
  })

  it('keeps a conflict instead of skipping a different pulled note when the upload queue is missing', async () => {
    const note = await createNote('account-a', null)
    await db.outbox.clear()
    rpc.mockResolvedValueOnce({ data: { items: [{ seq: '1', entity: 'note', record: {
      id: note.id, owner_id: 'account-a', title: '云端标题', doc: emptyDocument, doc_version: 1, plain_text: '云端正文',
      folder_id: null, is_pinned: false, created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 4
    } }], next: '1' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect((await db.notes.get(note.id))?.plainText).toBe('')
    const conflict = (await db.conflicts.where('entityId').equals(note.id).first())!
    expect(conflict.remote).toMatchObject({ plainText: '云端正文', serverVersion: 4 })
    expect((await db.syncMeta.get('account-a'))?.cursor).toBe('1')
  })

  it('accepts an identical pulled record that matches a still-pending local edit', async () => {
    const note = await createNote('account-a', null)
    const queued = (await db.outbox.where('entityId').equals(note.id).first())!
    await db.conflicts.add({
      id: crypto.randomUUID(), ownerId: 'account-a', entity: 'note', entityId: note.id,
      local: note, remote: { ...note, title: '占位', serverVersion: 1 }, createdAt: note.createdAt
    })
    rpc.mockResolvedValueOnce({ data: { items: [{ seq: '2', entity: 'note', record: {
      id: note.id, owner_id: 'account-a', title: note.title, doc: emptyDocument, doc_version: 1, plain_text: note.plainText,
      folder_id: null, is_pinned: false, created_at: note.createdAt, updated_at: note.updatedAt, deleted_at: null, version: 3
    } }], next: '2' }, error: null })
    expect(await syncOnce('account-a')).toBe(true)
    expect(rpc.mock.calls.some(call => call[0] === 'apply_mutation')).toBe(false)
    expect(await db.conflicts.where('entityId').equals(note.id).count()).toBe(0)
    expect(await db.outbox.get(queued.id)).toBeUndefined()
    expect((await db.notes.get(note.id))?.serverVersion).toBe(3)
  })

  it('advances a folder revision when the cloud version is chosen', async () => {
    const folder = await createFolder('account-a', '本机')
    await db.outbox.clear()
    const conflictId = crypto.randomUUID()
    await db.conflicts.add({
      id: conflictId, ownerId: 'account-a', entity: 'folder', entityId: folder.id,
      local: folder, remote: { ...folder, name: '云端', localRev: 1, serverVersion: 5, confirmedRev: 1 },
      createdAt: folder.createdAt
    })
    rpc.mockResolvedValue({ data: { items: [], next: '0' }, error: null })
    await resolveConflict('account-a', conflictId, 'remote')
    const stored = (await db.folders.get(folder.id))!
    expect(stored.name).toBe('云端')
    expect(stored.serverVersion).toBe(5)
    expect(stored.localRev).toBeGreaterThan(folder.localRev)
    expect(stored.confirmedRev).toBe(stored.localRev)
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
