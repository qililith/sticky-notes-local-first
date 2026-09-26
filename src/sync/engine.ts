import { supabase } from '../auth'
import { isAccountSyncPaused, withAccountSyncLock } from '../data/accountSyncGate'
import { db } from '../data/db'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from '../data/saveGuard'
import { folderPayload, notePayload, type Conflict, type Folder, type FolderPayload, type Mutation, type Note, type NotePayload, type SyncMeta } from '../data/types'

type RemoteRow = Record<string, unknown> & { id: string; owner_id: string; version: number }
type ApplyResult = { status: 'ok' | 'conflict'; record: RemoteRow | null; seq?: string }
type PullResult = { items: { seq: string; entity: 'note' | 'folder'; record: RemoteRow }[]; next: string }

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]))
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

function sameRemoteContent(mutation: Mutation, row: RemoteRow): boolean {
  if (mutation.entity === 'note') {
    const payload = mutation.payload as NotePayload
    return row.title === payload.title && sameJson(row.doc, payload.doc)
      && row.doc_version === payload.docVersion && row.plain_text === payload.plainText
      && (row.folder_id ?? null) === payload.folderId && row.is_pinned === payload.isPinned
      && Boolean(row.deleted_at) === Boolean(payload.deletedAt)
  }
  const payload = mutation.payload as FolderPayload
  return row.name === payload.name && row.sort_order === payload.sortOrder
    && Boolean(row.deleted_at) === Boolean(payload.deletedAt)
}

function serverNote(row: RemoteRow, current?: Note): Note {
  if (row.doc_version !== 1 || !row.doc || typeof row.doc !== 'object' || (row.doc as { type?: unknown }).type !== 'doc') {
    throw new Error('服务器便签正文版本或格式不受支持')
  }
  return {
    id: row.id, ownerId: row.owner_id, title: String(row.title ?? ''),
    doc: row.doc as Note['doc'], docVersion: 1, plainText: String(row.plain_text ?? ''),
    folderId: row.folder_id ? String(row.folder_id) : null,
    isPinned: Boolean(row.is_pinned),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    localRev: current?.localRev ?? row.version,
    serverVersion: row.version,
    confirmedRev: current?.localRev ?? row.version
  }
}

function serverFolder(row: RemoteRow, current?: Folder): Folder {
  return {
    id: row.id, ownerId: row.owner_id, name: String(row.name ?? ''), sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    localRev: current?.localRev ?? row.version,
    serverVersion: row.version,
    confirmedRev: current?.localRev ?? row.version
  }
}

async function meta(ownerId: string): Promise<SyncMeta> {
  return (await db.syncMeta.get(ownerId)) ?? { ownerId, cursor: '0', lastSyncedAt: null, lastError: null }
}

async function setError(ownerId: string, message: string | null) {
  const current = await meta(ownerId)
  await db.syncMeta.put({ ...current, lastError: message })
}

async function tokenForAccount(ownerId: string): Promise<string> {
  if (!supabase) throw new Error('云端服务尚未配置')
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session?.access_token || data.session.user.id !== ownerId) {
    throw new Error('当前登录账号与本地数据不匹配，已暂停同步')
  }
  return data.session.access_token
}

async function recordConflict(ownerId: string, mutation: Mutation, remote: RemoteRow) {
  await db.transaction('rw', db.outbox, db.conflicts, db.notes, db.folders, async () => {
    const local = mutation.entity === 'note' ? await db.notes.get(mutation.entityId) : await db.folders.get(mutation.entityId)
    if (!local) return
    const conflict: Conflict = {
      id: mutation.id, ownerId, entity: mutation.entity, entityId: mutation.entityId,
      local, remote: mutation.entity === 'note' ? serverNote(remote) : serverFolder(remote),
      createdAt: new Date().toISOString()
    }
    await db.conflicts.put(conflict)
    await db.outbox.update(mutation.id, { state: 'conflict', error: '另一台设备有更新' })
  })
}

async function recoverRejectedMutation(ownerId: string, mutation: Mutation) {
  // These RPC validation errors occur before writing or recording the mutation ID.
  // A newer pending snapshot supersedes it; otherwise make it editable again.
  await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.get(mutation.id)
    if (!current || current.ownerId !== ownerId || current.state !== 'inflight') return
    const queued = await db.outbox.where('[ownerId+entity+entityId]')
      .equals([ownerId, mutation.entity, mutation.entityId]).toArray()
    if (queued.some(item => item.id !== mutation.id && item.state === 'pending')) {
      await db.outbox.delete(mutation.id)
    } else {
      await db.outbox.update(mutation.id, { state: 'pending' })
    }
  })
}

async function uploadOne(ownerId: string, mutation: Mutation, token: string) {
  if (!supabase) return
  const fresh = await db.outbox.get(mutation.id)
  if (!fresh || fresh.ownerId !== ownerId || fresh.state === 'conflict') return
  mutation = fresh
  const previous = await db.conflicts.where('entityId').equals(mutation.entityId).toArray()
  if (previous.some(item => item.ownerId === ownerId)) return
  if (mutation.state === 'pending') {
    const marked = await db.transaction('rw', db.outbox, async () => {
      const latest = await db.outbox.get(mutation.id)
      if (!latest || latest.state !== 'pending') return null
      await db.outbox.update(mutation.id, { state: 'inflight' })
      return { ...latest, state: 'inflight' as const }
    })
    if (!marked) return
    mutation = marked
  }
  const { data, error } = await supabase.rpc('apply_mutation', {
    p_mutation_id: mutation.id, p_entity: mutation.entity,
    p_entity_id: mutation.entityId, p_base_version: mutation.baseVersion,
    p_payload: mutation.payload
  }).setHeader('Authorization', `Bearer ${token}`)
  if (error) {
    if (/Mutation too large|Folder does not belong to account/i.test(error.message)) {
      await recoverRejectedMutation(ownerId, mutation)
    }
    throw error
  }
  const result = data as ApplyResult
  if (!result || !['ok', 'conflict'].includes(result.status)) throw new Error('服务器返回了无法识别的同步结果')
  if (result.status === 'conflict') {
    if (!result.record) throw new Error('服务器记录不存在，待同步内容已保留')
    if (result.record.owner_id !== ownerId || result.record.id !== mutation.entityId) throw new Error('服务器返回了不匹配的冲突记录')
    if (!sameRemoteContent(mutation, result.record)) {
      await recordConflict(ownerId, mutation, result.record)
      return
    }
  }
  if (!result.record || result.record.owner_id !== ownerId || result.record.id !== mutation.entityId) throw new Error('服务器返回了不匹配的记录')
  await db.transaction('rw', db.notes, db.folders, db.outbox, db.history, async () => {
    const queued = await db.outbox.get(mutation.id)
    if (!queued) return
    if (mutation.entity === 'note') {
      const local = await db.notes.get(mutation.entityId)
      if (local) {
        const ack = serverNote(result.record!, local)
        await db.history.put({ id: `${ownerId}:${ack.id}:${ack.serverVersion}`, ownerId, noteId: ack.id, serverVersion: ack.serverVersion, snapshot: ack, createdAt: new Date().toISOString() })
        await db.notes.put(local.localRev === mutation.localRev
          ? { ...ack, localRev: local.localRev, confirmedRev: mutation.localRev }
          : { ...local, serverVersion: ack.serverVersion, confirmedRev: mutation.localRev })
      }
    } else {
      const local = await db.folders.get(mutation.entityId)
      if (local) {
        const ack = serverFolder(result.record!, local)
        await db.folders.put(local.localRev === mutation.localRev
          ? { ...ack, localRev: local.localRev, confirmedRev: mutation.localRev }
          : { ...local, serverVersion: ack.serverVersion, confirmedRev: mutation.localRev })
      }
    }
    await db.outbox.delete(mutation.id)
    const following = await db.outbox.where('[ownerId+entity+entityId]').equals([ownerId, mutation.entity, mutation.entityId]).toArray()
    for (const next of following) if (next.state === 'pending') await db.outbox.update(next.id, { baseVersion: result.record!.version })
  })
}

async function applyChange(ownerId: string, entity: 'note' | 'folder', row: RemoteRow) {
  if (row.owner_id !== ownerId) throw new Error('同步记录账号不匹配')
  if (entity === 'note') {
    const current = await db.notes.get(row.id)
    if (current && row.version <= current.serverVersion) return
    const dirty = current && current.localRev > current.confirmedRev
    if (dirty) {
      const pending = await db.outbox.where('[ownerId+entity+entityId]').equals([ownerId, entity, row.id]).first()
      if (pending) await recordConflict(ownerId, pending, row)
      return
    }
    const received = serverNote(row, current)
    if (current) {
      received.localRev = current.localRev + 1
      received.confirmedRev = received.localRev
    }
    await db.notes.put(received)
    await db.history.put({ id: `${ownerId}:${received.id}:${received.serverVersion}`, ownerId, noteId: received.id, serverVersion: received.serverVersion, snapshot: received, createdAt: new Date().toISOString() })
  } else {
    const current = await db.folders.get(row.id)
    if (current && row.version <= current.serverVersion) return
    const dirty = current && current.localRev > current.confirmedRev
    if (dirty) {
      const pending = await db.outbox.where('[ownerId+entity+entityId]').equals([ownerId, entity, row.id]).first()
      if (pending) await recordConflict(ownerId, pending, row)
      return
    }
    await db.folders.put(serverFolder(row, current))
  }
}

async function pull(ownerId: string, token: string) {
  if (!supabase) return
  let cursor = (await meta(ownerId)).cursor
  for (;;) {
    const { data, error } = await supabase.rpc('pull_changes', { p_after: cursor, p_limit: 100 })
      .setHeader('Authorization', `Bearer ${token}`)
    if (error) throw error
    const page = data as PullResult
    if (!page || !Array.isArray(page.items) || typeof page.next !== 'string') throw new Error('服务器返回了无法识别的变更列表')
    await db.transaction('rw', [db.notes, db.folders, db.outbox, db.conflicts, db.syncMeta, db.history], async () => {
      for (const item of page.items) await applyChange(ownerId, item.entity, item.record)
      await db.syncMeta.put({ ...(await meta(ownerId)), cursor: page.next, lastSyncedAt: new Date().toISOString(), lastError: null })
    })
    cursor = page.next
    if (page.items.length < 100) break
  }
}

function describeError(cause: unknown): string {
  const error = cause as { status?: number; message?: string }
  const detail = error?.message ?? '未知错误'
  if (/Mutation too large/i.test(detail)) return '便签内容超过云端单次上传限制；内容仍保存在本机。请先导出备份，再拆分或缩短便签。'
  if (/Folder does not belong to account/i.test(detail)) return '便签所选文件夹在云端已删除或不可用；便签仍保存在本机。请将便签移到“未分类”，再重试同步。'
  if (error?.status === 401) return `登录已失效：${detail}`
  if (error?.status === 403) return `权限被拒绝：${detail}`
  if (error?.status && error.status >= 500) return `云端暂时不可用：${detail}`
  if (!navigator.onLine || /fetch|network|timeout/i.test(detail)) return `网络连接失败：${detail}`
  return detail
}

export async function syncOnce(ownerId: string): Promise<boolean> {
  if (!supabase || !navigator.onLine || isAccountSyncPaused(ownerId)) return false
  const run = async (): Promise<boolean> => {
    if (isAccountSyncPaused(ownerId)) return false
    try {
      const token = await tokenForAccount(ownerId)
      const items = await db.outbox.where('ownerId').equals(ownerId).sortBy('createdAt')
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)
        || Number(b.entity === 'folder' && b.baseVersion === 0) - Number(a.entity === 'folder' && a.baseVersion === 0))
      for (const item of items) if (item.state !== 'conflict') await uploadOne(ownerId, item, token)
      await pull(ownerId, token)
      await setError(ownerId, null)
      return true
    } catch (cause) {
      await setError(ownerId, describeError(cause))
      return false
    }
  }
  return withAccountSyncLock(ownerId, run)
}

export async function resolveConflict(ownerId: string, conflictId: string, choice: 'local' | 'remote'): Promise<void> {
  if (isAccountSyncPaused(ownerId)) throw new Error('本机账号数据已清除，请重新登录')
  if (hasPendingEditorWrites()) throw new Error('本地仍在保存，请稍等再处理冲突')
  if (hasUnresolvedEditorDraft()) throw new Error('当前草稿尚未保存，请先另存或复制草稿文本')
  await db.transaction('rw', db.notes, db.folders, db.outbox, db.conflicts, db.history, async () => {
    if (isAccountSyncPaused(ownerId)) throw new Error('本机账号数据已清除，请重新登录')
    const conflict = await db.conflicts.get(conflictId)
    if (!conflict || conflict.ownerId !== ownerId) throw new Error('冲突记录不存在')
    const queued = await db.outbox.where('[ownerId+entity+entityId]').equals([ownerId, conflict.entity, conflict.entityId]).toArray()
    for (const item of queued) await db.outbox.delete(item.id)
    const remote = conflict.remote
    if (choice === 'remote') {
      if (conflict.entity === 'note') {
        const current = await db.notes.get(conflict.entityId)
        const note = { ...(remote as Note), localRev: Math.max(current?.localRev ?? 0, (remote as Note).localRev) + 1 }
        note.confirmedRev = note.localRev
        await db.notes.put(note)
        await db.history.put({ id: `${ownerId}:${note.id}:${note.serverVersion}`, ownerId, noteId: note.id, serverVersion: note.serverVersion, snapshot: note, createdAt: new Date().toISOString() })
      } else await db.folders.put(remote as Folder)
    } else {
      if (conflict.entity === 'note') {
        const local = await db.notes.get(conflict.entityId)
        if (!local || local.ownerId !== ownerId) throw new Error('本地便签不存在')
        await db.notes.put({ ...local, serverVersion: remote.serverVersion })
        await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'note', entityId: local.id, baseVersion: remote.serverVersion, localRev: local.localRev, payload: notePayload(local), createdAt: new Date().toISOString(), state: 'pending' })
      } else {
        const local = await db.folders.get(conflict.entityId)
        if (!local || local.ownerId !== ownerId) throw new Error('本地文件夹不存在')
        await db.folders.put({ ...local, serverVersion: remote.serverVersion })
        await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'folder', entityId: local.id, baseVersion: remote.serverVersion, localRev: local.localRev, payload: folderPayload(local), createdAt: new Date().toISOString(), state: 'pending' })
      }
    }
    await db.conflicts.delete(conflictId)
  })
  await syncOnce(ownerId)
}

export function startSync(ownerId: string) {
  let timer: number | undefined
  let failures = 0
  let running = false
  let stopped = false
  const trigger = async () => {
    if (stopped || running) return
    running = true
    const success = await syncOnce(ownerId)
    running = false
    if (stopped) return
    failures = success ? 0 : Math.min(failures + 1, 4)
    timer = window.setTimeout(() => void trigger(), 30_000 * (2 ** failures))
  }
  const immediate = () => { window.clearTimeout(timer); void trigger() }
  immediate()
  window.addEventListener('online', immediate)
  window.addEventListener('focus', immediate)
  return () => {
    stopped = true
    window.clearTimeout(timer)
    window.removeEventListener('online', immediate)
    window.removeEventListener('focus', immediate)
  }
}

