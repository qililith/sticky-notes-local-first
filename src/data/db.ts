import Dexie, { type EntityTable } from 'dexie'
import type { Conflict, Folder, Mutation, Note, Revision, SyncMeta } from './types'

export class NotesDatabase extends Dexie {
  notes!: EntityTable<Note, 'id'>
  folders!: EntityTable<Folder, 'id'>
  outbox!: EntityTable<Mutation, 'id'>
  conflicts!: EntityTable<Conflict, 'id'>
  syncMeta!: EntityTable<SyncMeta, 'ownerId'>
  history!: EntityTable<Revision, 'id'>

  constructor(name = 'sticky-notes-v1') {
    super(name)
    this.version(1).stores({
      notes: 'id, ownerId, folderId, updatedAt, deletedAt, [ownerId+folderId]',
      folders: 'id, ownerId, sortOrder, deletedAt',
      outbox: 'id, ownerId, entityId, state, createdAt, [ownerId+entity+entityId]',
      conflicts: 'id, ownerId, entityId, createdAt',
      syncMeta: 'ownerId',
      history: 'id, ownerId, noteId, serverVersion, [ownerId+noteId]'
    })
  }
}

export const db = new NotesDatabase()

