// Keep the current production schema in one place so the isolated browser
// upgrade test starts from the exact same version-1 stores and indexes.
export const notesDbStoresV1 = {
  notes: 'id, ownerId, folderId, updatedAt, deletedAt, [ownerId+folderId]',
  folders: 'id, ownerId, sortOrder, deletedAt',
  outbox: 'id, ownerId, entityId, state, createdAt, [ownerId+entity+entityId]',
  conflicts: 'id, ownerId, entityId, createdAt',
  syncMeta: 'ownerId',
  history: 'id, ownerId, noteId, serverVersion, [ownerId+noteId]'
} as const
