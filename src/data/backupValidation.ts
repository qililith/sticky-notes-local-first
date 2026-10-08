import type { BackupArchive } from './backup'
import { checkDocument } from './editorSchema'
import { checkedFolderName, checkedTitle } from './limits'

type Row = Record<string, unknown>
const object = (value: unknown): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const counter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function requireValid(valid: unknown, label: string): asserts valid {
  if (!valid) throw new Error(`备份文件中的${label}无效，未导入任何内容`)
}

export function validateBackup(value: unknown): BackupArchive {
  requireValid(object(value), '格式')
  requireValid(value.schema === 1 && nonempty(value.sourceAccount), '版本或内容不符合要求：账号')
  requireValid(date(value.exportedAt), '导出时间')
  const sourceAccount = value.sourceAccount
  const collections = ['notes', 'folders', 'pending', 'conflicts', 'history'] as const
  const labels = { notes: '便签', folders: '文件夹', pending: '待上传', conflicts: '冲突', history: '历史' }
  for (const key of collections) {
    const rows = value[key]
    requireValid(Array.isArray(rows), `${labels[key]}列表`)
    const ids = new Set<string>()
    for (const row of rows) {
      requireValid(object(row) && nonempty(row.id) && row.ownerId === sourceAccount, `${labels[key]}记录或账号归属`)
      requireValid(!ids.has(row.id), `${labels[key]}重复 ID`)
      ids.add(row.id)
    }
  }
  const metadata = (row: Row, label: string) => {
    requireValid(uuid(row.id) && row.ownerId === sourceAccount && date(row.createdAt) && date(row.updatedAt), `${label}身份或时间`)
    requireValid(counter(row.localRev) && Number(row.localRev) >= 1 && counter(row.serverVersion)
      && counter(row.confirmedRev) && Number(row.confirmedRev) <= Number(row.localRev), `${label}版本`)
  }
  const notePayload = (row: Row, label: string) => {
    requireValid(typeof row.title === 'string' && typeof row.plainText === 'string' && typeof row.isPinned === 'boolean'
      && (row.folderId === null || uuid(row.folderId)) && (row.deletedAt === null || date(row.deletedAt)), `${label}字段`)
    checkedTitle(row.title)
    requireValid(row.docVersion === undefined || row.docVersion === 1, `${label}正文版本`)
    try { checkDocument(row.doc) } catch { throw new Error(`备份文件中的${label}正文结构不受支持，未导入任何内容`) }
    // Compatibility with the first schema-1 exports, which omitted docVersion.
    row.docVersion = 1
  }
  const folderPayload = (row: Row, label: string) => {
    requireValid(typeof row.name === 'string' && typeof row.sortOrder === 'number' && Number.isInteger(row.sortOrder)
      && row.sortOrder >= -2147483648 && row.sortOrder <= 2147483647
      && (row.deletedAt === null || date(row.deletedAt)), `${label}字段`)
    checkedFolderName(row.name)
  }
  const entity = (row: unknown, kind: unknown, label: string) => {
    requireValid(object(row), label)
    metadata(row, label)
    if (kind === 'note') notePayload(row, label)
    else { requireValid(kind === 'folder', `${label}类型`); folderPayload(row, label) }
  }
  for (const row of value.notes as Row[]) entity(row, 'note', '便签')
  for (const row of value.folders as Row[]) entity(row, 'folder', '文件夹')
  const noteIds = new Set((value.notes as Row[]).map(row => row.id))
  const folderIds = new Set((value.folders as Row[]).map(row => row.id))
  for (const row of value.notes as Row[]) requireValid(row.folderId === null || folderIds.has(row.folderId), '便签缺少所属文件夹')
  for (const row of value.pending as Row[]) {
    requireValid(uuid(row.id) && uuid(row.entityId) && counter(row.baseVersion) && counter(row.localRev)
      && Number(row.localRev) >= 1 && date(row.createdAt) && typeof row.state === 'string' && ['pending', 'inflight', 'conflict', 'rejected'].includes(row.state)
      && (row.error === undefined || typeof row.error === 'string') && object(row.payload), '待上传记录')
    if (row.entity === 'note') notePayload(row.payload, '待上传便签')
    else { requireValid(row.entity === 'folder', '待上传类型'); folderPayload(row.payload, '待上传文件夹') }
    requireValid((row.entity === 'note' ? noteIds : folderIds).has(row.entityId), '待上传记录缺少关联实体')
  }
  for (const row of value.conflicts as Row[]) {
    requireValid(uuid(row.id) && uuid(row.entityId) && date(row.createdAt), '冲突记录')
    requireValid((row.entity === 'note' ? noteIds : folderIds).has(row.entityId), '冲突缺少关联实体')
    for (const key of ['local', 'remote']) {
      entity(row[key], row.entity, `冲突${key}版本`)
      requireValid((row[key] as Row).id === row.entityId, '冲突关联 ID')
    }
  }
  for (const row of value.history as Row[]) {
    requireValid(uuid(row.noteId) && counter(row.serverVersion) && date(row.createdAt), '历史记录')
    requireValid(noteIds.has(row.noteId), '历史缺少关联便签')
    entity(row.snapshot, 'note', '历史快照')
    requireValid((row.snapshot as Row).id === row.noteId && (row.snapshot as Row).serverVersion === row.serverVersion, '历史关联 ID 或版本')
  }
  return value as unknown as BackupArchive
}
