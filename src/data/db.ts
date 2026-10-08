import Dexie, { type EntityTable } from 'dexie'
import { notesDbStoresV1 } from './dbSchema'
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
    this.version(1).stores(notesDbStoresV1)
  }
}

export const db = new NotesDatabase()
