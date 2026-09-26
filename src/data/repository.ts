import { db } from './db'
import { isAccountSyncPaused, notifyAccountCleared, pauseAccountSync, resumeAccountSync, withAccountSyncLock } from './accountSyncGate'
import { checkedFolderName, checkedTitle } from './limits'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from './saveGuard'
import { emptyDocument, folderPayload, notePayload, type Entity, type Folder, type Mutation, type Note, type RichText } from './types'

const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
let persistenceRequested = false

function requestPersistentStorage() {
  if (persistenceRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistenceRequested = true
  void navigator.storage.persist().catch(() => undefined)
}

function requireOwner(ownerId: string) {
  if (!ownerId) throw new Error('缺少账号，无法保存')
}

function requireWritableOwner(ownerId: string) {
  requireOwner(ownerId)
  if (isAccountSyncPaused(ownerId)) throw new Error('本机账号数据已清除，请重新登录')
}

async function queueMutation(entity: Entity, value: Note | Folder): Promise<void> {
  const existing = await db.outbox.where('[ownerId+entity+entityId]').equals([value.ownerId, entity, value.id]).toArray()
  const editable = existing.find(item => item.state === 'pending')
  const payload = entity === 'note' ? notePayload(value as Note) : folderPayload(value as Folder)
  if (editable) {
    await db.outbox.put({ ...editable, localRev: value.localRev, payload })
  } else {
    const mutation: Mutation = {
      id: id(), ownerId: value.ownerId, entity, entityId: value.id,
      baseVersion: value.serverVersion, localRev: value.localRev,
      payload, createdAt: now(), state: 'pending'
    }
    await db.outbox.add(mutation)
  }
}

async function refreshConflictLocal(entity: Entity, value: Note | Folder): Promise<void> {
  const conflicts = await db.conflicts.where('entityId').equals(value.id).toArray()
  for (const conflict of conflicts) {
    if (conflict.ownerId === value.ownerId && conflict.entity === entity) {
      await db.conflicts.update(conflict.id, { local: value })
    }
  }
}

export async function createNote(ownerId: string, folderId: string | null): Promise<Note> {
  requireOwner(ownerId)
  const stamp = now()
  const note: Note = {
    id: id(), ownerId, title: '', doc: emptyDocument, docVersion: 1, plainText: '', folderId,
    isPinned: false, createdAt: stamp, updatedAt: stamp, deletedAt: null,
    localRev: 1, serverVersion: 0, confirmedRev: 0
  }
  await db.transaction('rw', db.notes, db.outbox, async () => {
    requireWritableOwner(ownerId)
    await db.notes.add(note)
    await queueMutation('note', note)
  })
  requestPersistentStorage()
  return note
}

export async function createNoteWithContent(ownerId: string, folderId: string | null, title: string, doc: RichText, plainText: string): Promise<Note> {
  requireOwner(ownerId)
  checkedTitle(title)
  const stamp = now()
  const note: Note = { id: id(), ownerId, title, doc, docVersion: 1, plainText, folderId, isPinned: false, createdAt: stamp, updatedAt: stamp, deletedAt: null, localRev: 1, serverVersion: 0, confirmedRev: 0 }
  await db.transaction('rw', db.notes, db.outbox, async () => {
    requireWritableOwner(ownerId)
    await db.notes.add(note)
    await queueMutation('note', note)
  })
  requestPersistentStorage()
  return note
}

export async function updateNote(
  ownerId: string,
  noteId: string,
  change: Partial<Pick<Note, 'title' | 'doc' | 'plainText' | 'folderId' | 'isPinned' | 'deletedAt'>>,
  expectedLocalRev?: number
): Promise<Note> {
  requireOwner(ownerId)
  if (change.title !== undefined) checkedTitle(change.title)
  return db.transaction('rw', db.notes, db.outbox, db.conflicts, async () => {
    requireWritableOwner(ownerId)
    const current = await db.notes.get(noteId)
    if (!current || current.ownerId !== ownerId) throw new Error('便签不存在')
    if (expectedLocalRev !== undefined && current.localRev !== expectedLocalRev) {
      throw new Error('便签已在其他窗口修改，请先检查最新内容')
    }
    const next = { ...current, ...change, localRev: current.localRev + 1, updatedAt: now() }
    await db.notes.put(next)
    await queueMutation('note', next)
    await refreshConflictLocal('note', next)
    return next
  })
}

export async function setNoteContent(ownerId: string, noteId: string, doc: RichText, plainText: string, title: string, expectedLocalRev?: number) {
  return updateNote(ownerId, noteId, { doc, plainText, title }, expectedLocalRev)
}

export async function createFolder(ownerId: string, name: string): Promise<Folder> {
  requireOwner(ownerId)
  const trimmed = checkedFolderName(name)
  const stamp = now()
  return db.transaction('rw', db.folders, db.outbox, async () => {
    requireWritableOwner(ownerId)
    const folders = await db.folders.where('ownerId').equals(ownerId).toArray()
    const folder: Folder = {
      id: id(), ownerId, name: trimmed,
      sortOrder: Math.max(-1, ...folders.map(item => item.sortOrder)) + 1,
      createdAt: stamp, updatedAt: stamp, deletedAt: null,
      localRev: 1, serverVersion: 0, confirmedRev: 0
    }
    await db.folders.add(folder)
    await queueMutation('folder', folder)
    return folder
  })
}

export async function updateFolder(ownerId: string, folderId: string, change: Partial<Pick<Folder, 'name' | 'sortOrder' | 'deletedAt'>>): Promise<Folder> {
  requireOwner(ownerId)
  return db.transaction('rw', db.folders, db.outbox, db.conflicts, async () => {
    requireWritableOwner(ownerId)
    const current = await db.folders.get(folderId)
    if (!current || current.ownerId !== ownerId) throw new Error('文件夹不存在')
    const next = { ...current, ...change, name: change.name === undefined ? current.name : checkedFolderName(change.name), localRev: current.localRev + 1, updatedAt: now() }
    await db.folders.put(next)
    await queueMutation('folder', next)
    await refreshConflictLocal('folder', next)
    return next
  })
}

export async function deleteFolder(ownerId: string, folderId: string): Promise<void> {
  requireOwner(ownerId)
  await db.transaction('rw', db.folders, db.notes, db.outbox, db.conflicts, async () => {
    requireWritableOwner(ownerId)
    const folder = await db.folders.get(folderId)
    if (!folder || folder.ownerId !== ownerId) throw new Error('文件夹不存在')
    const nextFolder = { ...folder, deletedAt: now(), localRev: folder.localRev + 1, updatedAt: now() }
    await db.folders.put(nextFolder)
    await queueMutation('folder', nextFolder)
    await refreshConflictLocal('folder', nextFolder)
    const notes = await db.notes.where('[ownerId+folderId]').equals([ownerId, folderId]).toArray()
    for (const note of notes) {
      const nextNote = { ...note, folderId: null, localRev: note.localRev + 1, updatedAt: now() }
      await db.notes.put(nextNote)
      await queueMutation('note', nextNote)
      await refreshConflictLocal('note', nextNote)
    }
  })
}

export async function clearAccountFromDevice(ownerId: string): Promise<void> {
  requireOwner(ownerId)
  if (hasPendingEditorWrites()) throw new Error('本地仍在保存，请稍等再清除')
  if (hasUnresolvedEditorDraft()) throw new Error('当前草稿尚未保存，请先另存或复制草稿文本')
  const cloudAccount = ownerId !== 'local-demo'
  const wasPaused = cloudAccount && isAccountSyncPaused(ownerId)
  if (cloudAccount) pauseAccountSync(ownerId)
  try {
    await withAccountSyncLock(ownerId, async () => {
      if (hasPendingEditorWrites()) throw new Error('本地仍在保存，请稍等再清除')
      if (hasUnresolvedEditorDraft()) throw new Error('当前草稿尚未保存，请先另存或复制草稿文本')
      await db.transaction('rw', [db.notes, db.folders, db.outbox, db.conflicts, db.syncMeta, db.history], async () => {
        if (cloudAccount) {
          const pending = await db.outbox.where('ownerId').equals(ownerId).count()
          const conflicts = await db.conflicts.where('ownerId').equals(ownerId).count()
          if (pending || conflicts) throw new Error('仍有未同步内容或冲突，请先导出备份并处理')
        }
        await db.notes.where('ownerId').equals(ownerId).delete()
        await db.folders.where('ownerId').equals(ownerId).delete()
        if (!cloudAccount) {
          await db.outbox.where('ownerId').equals(ownerId).delete()
          await db.conflicts.where('ownerId').equals(ownerId).delete()
        }
        await db.syncMeta.delete(ownerId)
        await db.history.where('ownerId').equals(ownerId).delete()
      })
    })
    if (cloudAccount) notifyAccountCleared(ownerId)
  } catch (error) {
    if (cloudAccount && !wasPaused) resumeAccountSync(ownerId)
    throw error
  }
}

