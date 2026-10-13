import { strToU8, zip } from 'fflate'
import { db } from './db'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from './saveGuard'
import { makeNoteExport, type NoteExportFormat } from './noteExport'
import type { Folder, Note } from './types'

export type BatchExportKind = 'txt-zip' | 'md-zip' | 'html-zip' | 'txt-merged' | 'md-merged'
export type BatchExportScope = { kind: 'all' } | { kind: 'folder'; folderId: string | null }

function safeName(name: string): string {
  return makeNoteExport({ title: name, doc: { type: 'doc', content: [] } }, 'txt').filename.slice(0, -4)
}

function uniqueName(name: string, used: Set<string>, extension = ''): string {
  let candidate = name + extension
  let count = 2
  while (used.has(candidate.normalize('NFC').toLowerCase())) candidate = `${name} (${count++})${extension}`
  used.add(candidate.normalize('NFC').toLowerCase())
  return candidate
}

export function prepareBatchExport(notes: Note[], folders: Folder[], scope: BatchExportScope, kind: BatchExportKind) {
  const activeFolders = folders.filter(folder => !folder.deletedAt)
  const folder = scope.kind === 'folder' && scope.folderId ? activeFolders.find(item => item.id === scope.folderId) : null
  if (scope.kind === 'folder' && scope.folderId && !folder) throw new Error('所选文件夹已不可用，请重新选择')
  const selected = notes.filter(note => !note.deletedAt && (scope.kind === 'all' || note.folderId === scope.folderId))
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  if (!selected.length) throw new Error('所选范围没有可导出的便签')
  const format = kind.split('-')[0] as NoteExportFormat
  const scopeName = scope.kind === 'all' ? '全部便签' : folder?.name ?? '未分类'
  const base = `便签导出-${safeName(scopeName)}`
  if (kind.endsWith('-merged')) {
    const separator = format === 'md' ? '\n\n---\n\n' : `\n\n${'='.repeat(40)}\n\n`
    return { filename: `${base}.${format}`, content: selected.map(note => makeNoteExport(note, format).content).join(separator), files: null, count: selected.length }
  }
  const directoryNames = new Set<string>(['未分类'])
  const folderPaths = new Map(activeFolders.sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, uniqueName(safeName(item.name), directoryNames)]))
  const usedPaths = new Set<string>()
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const note of selected) {
    const file = makeNoteExport(note, format)
    const directory = note.folderId ? folderPaths.get(note.folderId) ?? '未分类' : '未分类'
    const extension = `.${format}`
    const path = uniqueName(`${directory}/${file.filename.slice(0, -extension.length)}`, usedPaths, extension)
    files[path] = strToU8(file.content)
  }
  return { filename: `${base}-${format.toUpperCase()}.zip`, content: null, files, count: selected.length }
}

export async function downloadBatchExport(ownerId: string, scope: BatchExportScope, kind: BatchExportKind): Promise<number> {
  if (hasPendingEditorWrites()) throw new Error('本地仍在保存，请稍等再批量导出')
  if (hasUnresolvedEditorDraft()) throw new Error('当前草稿尚未保存，请先单条导出或另存为新便签')
  const snapshot = await db.transaction('r', db.notes, db.folders, async () => ({
    notes: await db.notes.where('ownerId').equals(ownerId).toArray(),
    folders: await db.folders.where('ownerId').equals(ownerId).toArray()
  }))
  if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) throw new Error('编辑状态已变化，请保存后再批量导出')
  const exported = prepareBatchExport(snapshot.notes, snapshot.folders, scope, kind)
  const blob = exported.files
    ? new Blob([Uint8Array.from(await new Promise<Uint8Array>((resolve, reject) => zip(exported.files!, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)))).buffer], { type: 'application/zip' })
    : new Blob([exported.content!], { type: kind.startsWith('md') ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = exported.filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return exported.count
}
