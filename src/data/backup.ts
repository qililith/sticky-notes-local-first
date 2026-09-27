import { db } from './db'
import { isAccountSyncPaused } from './accountSyncGate'
import { titleWithSuffix } from './limits'
import { validateBackup } from './backupValidation'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from './saveGuard'
import { folderPayload, notePayload, type Conflict, type Folder, type Mutation, type Note, type Revision } from './types'

export type BackupArchive = {
  schema: 1
  exportedAt: string
  sourceAccount: string
  notes: Note[]
  folders: Folder[]
  pending: Mutation[]
  conflicts: Conflict[]
  history: Revision[]
}

export async function makeBackup(ownerId: string): Promise<BackupArchive> {
  return db.transaction('r', db.notes, db.folders, db.outbox, db.conflicts, db.history, async () => {
    const [notes, folders, pending, conflicts, history] = await Promise.all([
      db.notes.where('ownerId').equals(ownerId).toArray(),
      db.folders.where('ownerId').equals(ownerId).toArray(),
      db.outbox.where('ownerId').equals(ownerId).toArray(),
      db.conflicts.where('ownerId').equals(ownerId).toArray(),
      db.history.where('ownerId').equals(ownerId).toArray()
    ])
    return { schema: 1 as const, exportedAt: new Date().toISOString(), sourceAccount: ownerId, notes, folders, pending, conflicts, history }
  })
}

export async function downloadBackup(ownerId: string): Promise<BackupArchive> {
  if (hasPendingEditorWrites()) throw new Error('本地仍在保存，请稍等再导出备份')
  if (hasUnresolvedEditorDraft()) throw new Error('当前草稿尚未保存，备份无法包含这部分内容')
  const archive = await makeBackup(ownerId)
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `便签备份-${new Date().toISOString().slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return archive
}

export function parseBackup(text: string): BackupArchive {
  if (text.length > 100_000_000) throw new Error('备份文件过大，请分批处理')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('文件不是有效的 JSON') }
  return validateBackup(value)
}

async function stableImportId(ownerId: string, sourceAccount: string, kind: string, sourceId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ownerId}\0${sourceAccount}\0${kind}\0${sourceId}`)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  hash[6] = (hash[6] & 0x0f) | 0x40
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = [...hash.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function importBackup(ownerId: string, archive: BackupArchive): Promise<{ notes: number; folders: number; copies: number }> {
  archive = validateBackup(archive)
  const sameAccount = archive.sourceAccount === ownerId
  const folderMap = new Map<string, string>()
  const legacyFolderMap = new Map<string, string>()
  const noteMap = new Map<string, string>()
  let addedNotes = 0
  let addedFolders = 0
  let copies = 0
  // All hashing happens before the IndexedDB transaction; WebCrypto would otherwise close it.
  for (const source of archive.folders) {
    folderMap.set(source.id, await stableImportId(ownerId, archive.sourceAccount, 'folder', `${source.id}\0${JSON.stringify(folderPayload(source))}`))
    legacyFolderMap.set(source.id, await stableImportId(ownerId, archive.sourceAccount, 'folder', source.id))
  }
  for (const source of archive.notes) {
    const fingerprint = JSON.stringify(notePayload(source))
    noteMap.set(source.id, await stableImportId(ownerId, archive.sourceAccount, 'note', `${source.id}\0${fingerprint}`))
  }
  const conflictMap = new Map<string, { id: string; legacyId: string }>()
  for (const source of archive.conflicts) {
    // A conflict ID stays the same while newer remote versions are pulled.
    // Deduplicate each snapshot, not every version of that conflict together.
    const fingerprint = JSON.stringify(source.entity === 'note' ? notePayload(source.remote as Note) : folderPayload(source.remote as Folder))
    const kind = source.entity === 'note' ? 'conflict' : 'folder-conflict'
    conflictMap.set(source.id, {
      id: await stableImportId(ownerId, archive.sourceAccount, kind, `${source.id}\0${fingerprint}`),
      legacyId: await stableImportId(ownerId, archive.sourceAccount, 'conflict', source.id)
    })
  }
  await db.transaction('rw', db.notes, db.folders, db.outbox, db.history, async () => {
    if (isAccountSyncPaused(ownerId)) throw new Error('本机账号数据已清除，请重新登录')
    for (const source of archive.folders) {
      const existing = await db.folders.get(source.id)
      if (sameAccount && existing?.ownerId === ownerId
        && JSON.stringify(folderPayload(existing)) === JSON.stringify(folderPayload(source))) {
        folderMap.set(source.id, source.id)
        continue
      }
      // Earlier imports used only the source ID. Reuse an unchanged copy, but
      // preserve later folder names/order/deletion states as separate snapshots.
      const legacy = await db.folders.get(legacyFolderMap.get(source.id)!)
      if (legacy?.ownerId === ownerId && JSON.stringify(folderPayload(legacy)) === JSON.stringify(folderPayload(source))) {
        folderMap.set(source.id, legacy.id)
        continue
      }
      const newId = sameAccount && !existing ? source.id : folderMap.get(source.id)!
      folderMap.set(source.id, newId)
      if (await db.folders.get(newId)) continue
      const folder: Folder = { ...source, id: newId, ownerId, localRev: 1, serverVersion: 0, confirmedRev: 0 }
      await db.folders.add(folder)
      await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'folder', entityId: newId, baseVersion: 0, localRev: 1, payload: folderPayload(folder), createdAt: new Date().toISOString(), state: 'pending' })
      addedFolders++
      if (sameAccount && existing) copies++
    }
    for (const source of archive.notes) {
      const existing = await db.notes.get(source.id)
      const same = sameAccount && existing?.ownerId === ownerId
        && JSON.stringify(notePayload(existing)) === JSON.stringify(notePayload(source))
      if (same) { noteMap.set(source.id, source.id); continue }
      const restoreOriginal = sameAccount && !existing
      const newId = restoreOriginal ? source.id : noteMap.get(source.id)!
      noteMap.set(source.id, newId)
      if (await db.notes.get(newId)) continue
      const note: Note = {
        ...source, id: newId, ownerId,
        title: restoreOriginal ? source.title : titleWithSuffix(source.title, '（导入副本）'),
        folderId: source.folderId ? folderMap.get(source.folderId) ?? null : null,
        localRev: 1, serverVersion: 0, confirmedRev: 0
      }
      await db.notes.add(note)
      await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'note', entityId: newId, baseVersion: 0, localRev: 1, payload: notePayload(note), createdAt: new Date().toISOString(), state: 'pending' })
      addedNotes++
      if (!restoreOriginal) copies++
    }
    // A conflict's remote version may not be in the current-note list. Keep it as a visible copy.
    for (const source of archive.conflicts) {
      const { id: newId, legacyId } = conflictMap.get(source.id)!
      if (source.entity === 'folder') {
        if (await db.folders.get(newId)) continue
        const remote = source.remote as Folder
        const folder: Folder = { ...remote, id: newId, ownerId, name: titleWithSuffix(remote.name, '（冲突副本）'), deletedAt: null, localRev: 1, serverVersion: 0, confirmedRev: 0 }
        await db.folders.add(folder)
        await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'folder', entityId: newId, baseVersion: 0, localRev: 1, payload: folderPayload(folder), createdAt: new Date().toISOString(), state: 'pending' })
        addedFolders++; copies++
        continue
      }
      const remote = source.remote as Note
      if (await db.notes.get(newId)) continue
      const note: Note = { ...remote, id: newId, ownerId, title: titleWithSuffix(remote.title, '（冲突副本）'), folderId: null, deletedAt: null, localRev: 1, serverVersion: 0, confirmedRev: 0 }
      const legacy = await db.notes.get(legacyId)
      if (legacy?.ownerId === ownerId && JSON.stringify(notePayload(legacy)) === JSON.stringify(notePayload(note))) continue
      await db.notes.add(note)
      await db.outbox.add({ id: crypto.randomUUID(), ownerId, entity: 'note', entityId: newId, baseVersion: 0, localRev: 1, payload: notePayload(note), createdAt: new Date().toISOString(), state: 'pending' })
      addedNotes++; copies++
    }
    for (const source of archive.history) {
      const targetId = noteMap.get(source.noteId)!
      const id = `import:${ownerId}:${targetId}:${source.id}`
      if (await db.history.get(id)) continue
      await db.history.add({ ...source, id, ownerId, noteId: targetId, snapshot: { ...source.snapshot, id: targetId, ownerId, folderId: source.snapshot.folderId ? folderMap.get(source.snapshot.folderId) ?? null : null } })
    }
  })
  return { notes: addedNotes, folders: addedFolders, copies }
}
