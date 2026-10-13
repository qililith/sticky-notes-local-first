import { expect, it } from 'vitest'
import { strFromU8 } from 'fflate'
import { downloadBatchExport, prepareBatchExport, type BatchExportKind } from '../src/data/batchExport'
import { makeNoteExport } from '../src/data/noteExport'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'
import type { Folder, Note } from '../src/data/types'

const base = { ownerId: 'test', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', localRev: 1, confirmedRev: 0, serverVersion: 0, deletedAt: null }
const note = (id: string, folderId: string | null, title = '同名'): Note => ({ ...base, id, folderId, title, plainText: `内容${id}`, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `内容${id}` }] }] }, docVersion: 1, isPinned: false })
const folder = (id: string, name: string): Folder => ({ ...base, id, name, sortOrder: 0 })

it('preserves folder structure and does not overwrite same-name or case-colliding notes', () => {
  const notes = [note('1', 'a'), note('2', 'a'), note('3', 'b'), note('4', null), note('5', 'c', '../CON')]
  const exported = prepareBatchExport(notes, [folder('a', '项目'), folder('b', '项目'), folder('c', '未分类')], { kind: 'all' }, 'md-zip')
  const paths = Object.keys(exported.files!)
  expect(paths).toContain('项目/同名.md')
  expect(paths).toContain('项目/同名 (2).md')
  expect(paths).toContain('项目 (2)/同名.md')
  expect(paths).toContain('未分类/同名.md')
  expect(paths.some(path => path.startsWith('未分类 (2)/'))).toBe(true)
  expect(new Set(paths).size).toBe(5)
  expect(paths.every(path => !path.split('/').includes('..'))).toBe(true)
  expect(Object.values(exported.files!).map(data => strFromU8(data)).join('')).toContain('内容5')
})

it.each(['txt-zip', 'md-zip', 'html-zip', 'txt-merged', 'md-merged'] as BatchExportKind[])('filters soft-deleted and other-folder content for %s', kind => {
  const notes = [note('1', 'a'), note('2', 'b'), { ...note('3', 'a'), deletedAt: base.updatedAt }]
  const exported = prepareBatchExport(notes, [folder('a', '选择的文件夹'), folder('b', '别的文件夹')], { kind: 'folder', folderId: 'a' }, kind)
  expect(exported.count).toBe(1)
  const content = exported.content ?? Object.values(exported.files!).map(data => strFromU8(data)).join('')
  expect(content).toContain('内容1')
  expect(content).not.toContain('内容2')
  expect(content).not.toContain('内容3')
})

it('exports standalone HTML with safe literal text and checked task state', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '<script>&中文', marks: [{ type: 'highlight' }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }] }] }
  ] }
  const exported = makeNoteExport({ title: '<标题>', doc }, 'html')
  const parsed = new DOMParser().parseFromString(exported.content, 'text/html')
  expect(parsed.title).toBe('<标题>')
  expect(parsed.querySelector('script')).toBeNull()
  expect(parsed.querySelector('mark')?.textContent).toBe('<script>&中文')
  expect((parsed.querySelector('input') as HTMLInputElement).checked).toBe(true)
  expect((parsed.querySelector('input') as HTMLInputElement).disabled).toBe(true)
  expect(parsed.querySelector('style')?.textContent).toContain('#fff2b3')
})

it('refuses an empty selection or a disappeared folder', () => {
  expect(() => prepareBatchExport([], [], { kind: 'all' }, 'md-zip')).toThrow('没有可导出')
  expect(() => prepareBatchExport([note('1', 'missing')], [], { kind: 'folder', folderId: 'missing' }, 'md-zip')).toThrow('已不可用')
})

it('refuses pending writes and unresolved drafts before taking a batch snapshot', async () => {
  const finish = beginEditorWrite()
  try { await expect(downloadBatchExport('test', { kind: 'all' }, 'txt-merged')).rejects.toThrow('仍在保存') }
  finally { finish() }
  setUnresolvedEditorDraft(true)
  try { await expect(downloadBatchExport('test', { kind: 'all' }, 'md-zip')).rejects.toThrow('草稿尚未保存') }
  finally { setUnresolvedEditorDraft(false) }
})
