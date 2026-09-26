import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { supabase } from '../auth'
import { downloadBackup, importBackup, parseBackup, type BackupArchive } from '../data/backup'
import { db } from '../data/db'
import { clearAccountFromDevice, updateNote } from '../data/repository'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from '../data/saveGuard'
import type { Note } from '../data/types'
import { resolveConflict, syncOnce } from '../sync/engine'

type Props = { ownerId: string; note: Note | null; hasUnsavedDraft: boolean; onClose: () => void; onCleared: () => Promise<void> }

export function DataPanel({ ownerId, note, hasUnsavedDraft, onClose, onCleared }: Props) {
  const [preview, setPreview] = useState<BackupArchive | null>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [storage, setStorage] = useState<string | null>(null)
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh) }
  }, [])
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  useEffect(() => {
    if (!navigator.storage?.estimate) return
    void navigator.storage.estimate().then(({ usage, quota }) => {
      if (usage !== undefined && quota) setStorage(`本机网站存储约 ${(usage / 1048576).toFixed(1)} / ${(quota / 1048576).toFixed(0)} MB`)
    }).catch(() => undefined)
  }, [])
  const meta = useLiveQuery(() => db.syncMeta.get(ownerId), [ownerId])
  const outbox = useLiveQuery(() => db.outbox.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const conflicts = useLiveQuery(() => db.conflicts.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const history = useLiveQuery(() => note ? db.history.where('[ownerId+noteId]').equals([ownerId, note.id]).reverse().sortBy('serverVersion') : [], [ownerId, note?.id], []) ?? []

  const run = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await task(); toast.success(success) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }

  const readFile = async (file?: File) => {
    if (!file) return
    try {
      if (file.size > 100_000_000) throw new Error('备份文件过大，请分批处理')
      setPreview(parseBackup(await file.text()))
    }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '无法读取备份') }
  }

  return <div className="data-panel-overlay" onClick={onClose}>
    <section className="data-panel" role="dialog" aria-modal="true" aria-label="数据与同步" onClick={event => event.stopPropagation()}>
      <div className="data-panel-heading"><h2>数据与同步</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <section><h3>状态</h3>
        <p>{supabase ? online ? '设备在线' : '设备离线' : '本地演示，不连接云端'} · 待同步 {outbox.length} 项 · 待处理冲突 {conflicts.length} 项</p>
        {meta?.lastSyncedAt && <p>上次同步：{new Date(meta.lastSyncedAt).toLocaleString('zh-CN')}</p>}
        {meta?.lastError && <p className="panel-error">同步错误：{meta.lastError}</p>}
        {storage && <p>{storage}</p>}
        <button type="button" disabled={busy || !online || !supabase} onClick={() => void run(async () => { if (!await syncOnce(ownerId)) throw new Error('同步未成功，请查看上方错误') }, '同步已完成')}>立即重试同步</button>
      </section>
      <section><h3>冲突</h3>
        {conflicts.length === 0 ? <p>没有待处理冲突。</p> : conflicts.map(item => <div className="panel-card" key={item.id}>
          <p>{item.entity === 'note' ? '便签' : '文件夹'}：{'title' in item.local ? item.local.title || '无标题' : item.local.name}</p>
          <p>另一台设备也改动了这项。选择一边会替换另一边的当前内容；操作前建议先导出备份。</p>
          <details><summary>查看本机版本</summary><pre>{'plainText' in item.local ? item.local.plainText : item.local.name}</pre></details>
          <details><summary>查看云端版本</summary><pre>{'plainText' in item.remote ? item.remote.plainText : item.remote.name}</pre></details>
          <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => { if (confirm('使用此设备的版本覆盖云端版本？')) void run(() => resolveConflict(ownerId, item.id, 'local'), '已选择本机版本') }}>保留本机版本</button>
          <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => { if (confirm('使用云端版本替换本机版本？')) void run(() => resolveConflict(ownerId, item.id, 'remote'), '已选择云端版本') }}>采用云端版本</button>
        </div>)}
      </section>
      <section><h3>当前便签历史</h3>
        {!note ? <p>先选中一条便签。</p> : history.length === 0 ? <p>这条便签还没有已确认的云端历史。</p> : history.slice(-20).reverse().map(item => <div className="panel-card" key={item.id}>
          <span>{new Date(item.createdAt).toLocaleString('zh-CN')} · 版本 {item.serverVersion}</span>
          <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => {
            if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) { toast.error('当前草稿尚未保存，请先处理后再恢复历史'); return }
            if (confirm('把这个历史版本恢复为当前便签的新版本？')) void run(() => updateNote(ownerId, note.id, { title: item.snapshot.title, doc: item.snapshot.doc, plainText: item.snapshot.plainText, deletedAt: null }), '已恢复历史版本')
          }}>恢复</button>
        </div>)}
      </section>
      <section><h3>备份</h3>
        <p>备份文件包含便签、文件夹、未同步修改、冲突和历史。请妥善保管文件。</p>
        {hasUnsavedDraft && <p className="panel-error">当前编辑内容尚未保存，导出不会包含这部分草稿。请先返回编辑器另存为新便签。</p>}
        <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => void run(() => downloadBackup(ownerId), '备份下载已发起，请检查下载文件')}>导出 JSON 备份</button>
        <label className="panel-file">选择备份文件<input type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void readFile(file)
        }} /></label>
        {preview && <div className="panel-card"><p>预览：{preview.notes.length} 条便签、{preview.folders.length} 个文件夹、{preview.history.length} 条历史；来源账号 {preview.sourceAccount}。</p>
          <p>同账号缺失的便签会按原 ID 恢复；已有不同内容的便签会另存副本。导入不会覆盖现有便签；若云端同 ID 内容不同，同步时需处理冲突。</p>
          <button type="button" disabled={busy} onClick={() => void run(async () => { const result = await importBackup(ownerId, preview); setPreview(null); toast.info(`新增 ${result.notes} 条便签、${result.folders} 个文件夹`) }, '导入完成')}>确认导入</button>
          <button type="button" onClick={() => setPreview(null)}>取消</button>
        </div>}
      </section>
      <section><h3>清除这台设备上的账号数据</h3>
        <p>退出登录不会删除本地数据。清除前请先导出备份；有待同步内容或冲突时无法清除。清除后会退出登录；云端副本仍保留。</p>
        <button type="button" className="danger-action" disabled={busy || hasUnsavedDraft || ownerId !== 'local-demo' && (outbox.length > 0 || conflicts.length > 0)} onClick={() => {
          if (hasPendingEditorWrites()) { toast.error('本地仍在保存，请稍等再清除'); return }
          if (confirm('确认已检查备份文件，并清除此账号在这台设备上的便签、文件夹和本地历史，然后退出登录？')) void run(async () => { await clearAccountFromDevice(ownerId); await onCleared() }, '本机账号数据已清除')
        }}>清除本机数据并退出</button>
      </section>
    </section>
  </div>
}

