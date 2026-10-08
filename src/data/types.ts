export type RichText = {
  type: string
  attrs?: Record<string, unknown>
  content?: RichText[]
  marks?: { type: string; attrs?: Record<string, unknown>; [key: string]: unknown }[]
  text?: string
  [key: string]: unknown
}

export type Note = {
  id: string
  ownerId: string
  title: string
  doc: RichText
  docVersion: 1
  plainText: string
  folderId: string | null
  isPinned: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  localRev: number
  serverVersion: number
  confirmedRev: number
}

export type Folder = {
  id: string
  ownerId: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  localRev: number
  serverVersion: number
  confirmedRev: number
}

export type Entity = 'note' | 'folder'

export type NotePayload = Pick<Note, 'title' | 'doc' | 'docVersion' | 'plainText' | 'folderId' | 'isPinned' | 'deletedAt'>
export type FolderPayload = Pick<Folder, 'name' | 'sortOrder' | 'deletedAt'>

export type Mutation = {
  id: string
  ownerId: string
  entity: Entity
  entityId: string
  baseVersion: number
  localRev: number
  payload: NotePayload | FolderPayload
  createdAt: string
  state: 'pending' | 'inflight' | 'conflict' | 'rejected'
  error?: string
}

export type Conflict = {
  id: string
  ownerId: string
  entity: Entity
  entityId: string
  local: Note | Folder
  remote: Note | Folder
  createdAt: string
}

export type DeferredChange = {
  seq: string
  entity: Entity
  record: { id: string; owner_id: string; version: number } & Record<string, unknown>
}

export type SyncMeta = {
  ownerId: string
  cursor: string
  lastSyncedAt: string | null
  lastError: string | null
  deferred?: DeferredChange[]
}

export type Revision = {
  id: string
  ownerId: string
  noteId: string
  serverVersion: number
  snapshot: Note
  createdAt: string
}

export const emptyDocument: RichText = { type: 'doc', content: [{ type: 'paragraph' }] }

export function notePayload(note: Note): NotePayload {
  return {
    title: note.title,
    doc: note.doc,
    docVersion: note.docVersion,
    plainText: note.plainText,
    folderId: note.folderId,
    isPinned: note.isPinned,
    deletedAt: note.deletedAt
  }
}

export function folderPayload(folder: Folder): FolderPayload {
  return { name: folder.name, sortOrder: folder.sortOrder, deletedAt: folder.deletedAt }
}
