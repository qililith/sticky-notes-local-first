import { useEffect, useMemo, useRef, useState } from 'react'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { supabase } from '../auth'
import { downloadBackup, importBackup, MAX_BACKUP_BYTES, OVERSIZE_BACKUP_MESSAGE, parseBackup, type BackupArchive } from '../data/backup'
import { db } from '../data/db'
import { sameStructuredValue } from '../data/equality'
import { HISTORY_PAGE_SIZE, historyCloudTime, historyPreview } from '../data/historyView'
import { clearAccountFromDevice, createNoteWithContent, restoreNoteRevision, updateNote } from '../data/repository'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft } from '../data/saveGuard'
import type { Note } from '../data/types'
import { titleWithSuffix } from '../data/limits'
import { clearRecoveryDraft, listAccountRecoveryDrafts, type RecoveryDraft } from '../data/recoveryDraft'
import { resolveConflict, syncOnce } from '../sync/engine'
import { downloadBatchExport, type BatchExportKind } from '../data/batchExport'
import { estimateAccountStorage, formatStorageBytes, persistenceLabel, recordPersistence, type AccountStorageEstimate } from '../data/storageUsage'

type Props = { ownerId: string; note: Note | null; currentFolderId?: string | null; hasUnsavedDraft: boolean; onClose: () => void; onLogout: () => Promise<void>; onCleared: () => Promise<void> }

function formatTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function DataPanel({ ownerId, note, currentFolderId, hasUnsavedDraft, onClose, onLogout, onCleared }: Props) {
  const [preview, setPreview] = useState<BackupArchive | null>(null)
  const fileReadId = useRef(0)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [historyPages, setHistoryPages] = useState(1)
  const [storage, setStorage] = useState<AccountStorageEstimate | null>(null)
  const [recoveryDrafts, setRecoveryDrafts] = useState(() => listAccountRecoveryDrafts(ownerId))
  const [exportScope, setExportScope] = useState(currentFolderId ?? '__all__')
  const [exportKind, setExportKind] = useState<BatchExportKind>('md-zip')
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
  useEffect(() => { setHistoryPages(1) }, [note?.id])
  const meta = useLiveQuery(() => db.syncMeta.get(ownerId), [ownerId])
  const outbox = useLiveQuery(() => db.outbox.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const pending = outbox.filter(item => item.state === 'pending' || item.state === 'inflight')
  const rejected = outbox.filter(item => item.state === 'rejected')
  const conflicts = useLiveQuery(() => db.conflicts.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const historyCount = useLiveQuery(() => note ? db.history.where('[ownerId+noteId]').equals([ownerId, note.id]).count() : 0, [ownerId, note?.id])
  const visibleHistory = useLiveQuery(() => note ? db.history.where('[ownerId+noteId+serverVersion]')
    .between([ownerId, note.id, 0], [ownerId, note.id, Dexie.maxKey]).reverse()
    .limit(historyPages * HISTORY_PAGE_SIZE).toArray() : [], [ownerId, note?.id, historyPages])
  const folders = useLiveQuery(() => db.folders.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const notes = useLiveQuery(() => db.notes.where('ownerId').equals(ownerId).toArray(), [ownerId], []) ?? []
  const activeNoteCount = notes.filter(item => !item.deletedAt).length
  const unmatchedRecoveryDrafts = useMemo(() => recoveryDrafts.filter(draft => {
    const saved = notes.find(item => item.id === draft.noteId)
    return !saved || saved.title !== draft.title || saved.plainText !== draft.plainText || !sameStructuredValue(saved.doc, draft.doc)
  }), [notes, recoveryDrafts])
  const exportCount = notes.filter(item => !item.deletedAt && (exportScope === '__all__' || item.folderId === (exportScope === '__unfiled__' ? null : exportScope))).length

  const run = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await task(); toast.success(success) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }

  const readFile = async (file?: File) => {
    const readId = ++fileReadId.current
    setPreview(null)
    if (!file) return
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error(OVERSIZE_BACKUP_MESSAGE)
      const text = await file.text()
      if (readId === fileReadId.current) setPreview(parseBackup(text))
    }
    catch (cause) { if (readId === fileReadId.current) toast.error(cause instanceof Error ? cause.message : '无法读取备份') }
  }

  const syncSummary = !supabase
    ? '现在是本地演示，内容只留在这台设备，不会同步到其他设备。'
    : !online
      ? pending.length
        ? `浏览器显示可能离线。还有 ${pending.length} 条改动保存在这台设备；你仍可立即尝试同步。`
        : '浏览器显示可能离线。已保存的内容可以继续查看和编辑，也可以立即尝试同步。'
      : conflicts.length
        ? `有 ${conflicts.length} 条内容和另一台设备不一致，请在下面选择保留哪一边。`
        : rejected.length
          ? `有 ${rejected.length} 条内容没能同步，请在下面处理。`
          : pending.length
            ? `待同步 ${pending.length} 项。内容已保存在这台设备。`
            : meta?.lastSyncedAt
              ? `已同步。最近一次：${formatTime(meta.lastSyncedAt)}`
              : '还没有完成过同步。'

  return <div className="data-panel-overlay" onClick={onClose}>
    <section className="data-panel" role="dialog" aria-modal="true" aria-label="数据与同步" onClick={event => event.stopPropagation()}>
      <div className="data-panel-heading"><h2>数据与同步</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <section>
        <h3>同步</h3>
        <p>{syncSummary}</p>
        {meta?.lastError && rejected.length === 0 && conflicts.length === 0 && <p className="panel-error">{meta.lastError}</p>}
        <p>这台设备上有 {activeNoteCount} 条便签。</p>
        {supabase && <button type="button" disabled={busy} onClick={() => void run(async () => { if (!await syncOnce(ownerId)) throw new Error('同步还没完成，请查看上面的说明') }, '同步完成')}>立即重试同步</button>}
      </section>
      {(rejected.length > 0 || conflicts.length > 0) && <section>
        <h3>需要你处理</h3>
        {rejected.map(item => <div className="panel-card" key={item.id}>
          <p>{item.entity === 'note' ? '便签' : '文件夹'}：{'title' in item.payload ? item.payload.title || '无标题' : item.payload.name}</p>
          <p>内容还在这台设备上，但没能同步到其他设备。</p>
          <p className="panel-error">{item.error ?? '这次同步没有被接受。'}</p>
          {item.entity === 'note' && item.error?.includes('便签所选文件夹') ? <>
            <p>下面只改分类，标题和正文不动。</p>
            {conflicts.some(conflict => conflict.entity === item.entity && conflict.entityId === item.entityId) && <p>这条便签还有版本不一致，请先选择保留哪一边。</p>}
            <button type="button" disabled={busy || hasUnsavedDraft || conflicts.some(conflict => conflict.entity === item.entity && conflict.entityId === item.entityId)} onClick={() => void run(async () => {
              if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) throw new Error('请先保存或另存当前草稿')
              await updateNote(ownerId, item.entityId, { folderId: null })
              if (supabase && !await syncOnce(ownerId)) throw new Error('已移到未分类，但同步还没完成')
            }, '已移到未分类')}>移到未分类并重试</button>
          </> : <p>按上面的说明改这一条后，再点同步。其他便签不受影响。</p>}
        </div>)}
        {conflicts.map(item => <div className="panel-card" key={item.id}>
          <p>{item.entity === 'note' ? '便签' : '文件夹'}：{'title' in item.local ? item.local.title || '无标题' : item.local.name}</p>
          <p>这台设备和另一台设备都改过。选一边会替换另一边的当前内容，操作前建议先导出备份。</p>
          <details><summary>这台设备上的内容</summary><pre>{'plainText' in item.local ? item.local.plainText : item.local.name}</pre></details>
          <details><summary>其他设备上的内容</summary><pre>{'plainText' in item.remote ? item.remote.plainText : item.remote.name}</pre></details>
          <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => { if (confirm('用这台设备的内容覆盖其他设备？')) void run(() => resolveConflict(ownerId, item.id, 'local'), '已保留这台设备的内容') }}>保留这台设备的</button>
          <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => { if (confirm('用其他设备的内容替换这台设备上的？')) void run(() => resolveConflict(ownerId, item.id, 'remote'), '已采用其他设备的内容') }}>采用其他设备的</button>
        </div>)}
      </section>}
      {unmatchedRecoveryDrafts.length > 0 && <section>
        <h3>本机临时恢复草稿</h3>
        <p>这些内容只存在于当前浏览器，最多保留 24 小时。恢复会另存为新便签，不会覆盖现有内容。</p>
        {unmatchedRecoveryDrafts.map((draft: RecoveryDraft) => <div className="panel-card" key={`${draft.noteId}:${draft.token}`}>
          <p>{draft.title || '无标题'} · 保存于 {formatTime(draft.savedAt)}</p>
          <details><summary>查看草稿内容</summary><pre>{draft.plainText}</pre></details>
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            await createNoteWithContent(ownerId, null, titleWithSuffix(draft.title, '（恢复副本）'), draft.doc, draft.plainText)
            clearRecoveryDraft(ownerId, draft.noteId, draft.token)
            setRecoveryDrafts(current => current.filter(item => item.noteId !== draft.noteId || item.token !== draft.token))
          }, '草稿已另存为新便签')}>恢复为新便签</button>
          <button type="button" disabled={busy} onClick={() => {
            if (!confirm('删除这份本机临时草稿？此操作不能撤销。')) return
            clearRecoveryDraft(ownerId, draft.noteId, draft.token)
            setRecoveryDrafts(current => current.filter(item => item.noteId !== draft.noteId || item.token !== draft.token))
          }}>删除草稿</button>
        </div>)}
      </section>}
      <section>
        <h3>这条便签的以前内容</h3>
        {!note ? <p>先打开一条便签。</p> : historyCount === undefined || visibleHistory === undefined ? <p>正在读取旧内容…</p> : historyCount === 0 ? <p>还没有可恢复的旧内容。</p> : <>
          <p>从近到远排列。恢复前会先把现在的内容另存为一条便签。</p>
          {visibleHistory.map(item => <div className="panel-card" key={item.id}>
            <span>{formatTime(historyCloudTime(item))}</span>
            <p className="history-preview">{historyPreview(item)}</p>
            <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => {
              if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) { toast.error('请先保存或另存当前草稿'); return }
              if (confirm('把这段旧内容恢复成现在的便签？当前内容会先另存为副本。')) void run(() => restoreNoteRevision(ownerId, note.id, item.id), '已恢复，原内容已另存为副本')
            }}>恢复</button>
          </div>)}
          {visibleHistory.length < historyCount && <button type="button" onClick={() => setHistoryPages(count => count + 1)}>更早的内容</button>}
        </>}
      </section>
      <section>
        <h3>备份</h3>
        <p>建议定期导出一份备份，放到这台电脑以外的地方。换设备或出问题时可以用它恢复。</p>
        {hasUnsavedDraft && <p className="panel-error">正在编辑的内容还没保存，备份里不会包含这一段。请先另存为新便签。</p>}
        <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => void run(() => downloadBackup(ownerId), '已开始下载备份')}>导出备份</button>
        <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => void run(() => downloadBackup(ownerId, { includeHistory: false }), '已开始下载当前内容')}>只导出当前内容</button>
        <label className="panel-file">导入备份<input type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void readFile(file)
        }} /></label>
        {preview && <div className="panel-card">
          <p>预览：{preview.notes.length} 条便签、{preview.folders.length} 个文件夹{preview.history.length ? `、${preview.history.length} 个旧版本` : ''}。</p>
          <p>不会覆盖你现在的便签。相同内容会跳过，不同的会另存一份。</p>
          <button type="button" disabled={busy} onClick={() => void run(async () => { const result = await importBackup(ownerId, preview); setPreview(null); toast.info(`新增 ${result.notes} 条便签`) }, '导入完成')}>确认导入</button>
          <button type="button" onClick={() => setPreview(null)}>取消</button>
        </div>}
      </section>
      <section>
        <h3>本机占用</h3>
        <p>查看这台设备上保存了多少便签和旧版本。数字是估算，不能代替备份。</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await recordPersistence()
          setStorage(await estimateAccountStorage(ownerId))
        }, '占用信息已更新')}>查看本机占用</button>
        {storage && <>
          <p>{storage.notes} 条便签（含回收站）、{storage.history} 个旧版本、{storage.outbox} 项待上传或需处理记录。</p>
          <p>便签与文件夹约 {formatStorageBytes(storage.noteBytes)}，旧版本约 {formatStorageBytes(storage.historyBytes)}，待上传与冲突约 {formatStorageBytes(storage.queueBytes + storage.conflictBytes)}。</p>
          {storage.siteUsageBytes !== null && <p>本网址在浏览器中共占用约 {formatStorageBytes(storage.siteUsageBytes)}{storage.siteQuotaBytes !== null ? `，浏览器报告的空间上限约 ${formatStorageBytes(storage.siteQuotaBytes)}` : ''}。</p>}
          <p>{persistenceLabel(storage.persistence)}。请定期导出备份。</p>
        </>}
      </section>
      <section>
        <h3>导出为文件</h3>
        <p>生成便于阅读的副本，不能用来完整恢复便签。</p>
        <label>范围<select aria-label="导出范围" value={exportScope} disabled={busy} onChange={event => setExportScope(event.target.value)}>
          <option value="__all__">全部便签</option><option value="__unfiled__">未分类</option>
          {folders.filter(folder => !folder.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        <label>格式<select aria-label="批量导出类型" value={exportKind} disabled={busy} onChange={event => setExportKind(event.target.value as BatchExportKind)}>
          <option value="md-zip">Markdown（压缩包）</option>
          <option value="txt-zip">纯文本（压缩包）</option>
          <option value="html-zip">网页（压缩包）</option>
          <option value="md-merged">合并成一个 Markdown</option>
          <option value="txt-merged">合并成一个文本文件</option>
        </select></label>
        <p>共 {exportCount} 条，不含回收站。</p>
        {hasUnsavedDraft && <p className="panel-error">请先保存或另存当前草稿。</p>}
        <button type="button" disabled={busy || hasUnsavedDraft || exportCount === 0} onClick={() => void run(() => downloadBatchExport(ownerId,
          exportScope === '__all__' ? { kind: 'all' } : { kind: 'folder', folderId: exportScope === '__unfiled__' ? null : exportScope }, exportKind), '已开始下载')}>下载</button>
      </section>
      <section>
        <h3>这台设备</h3>
        <p>退出登录不会删掉这台设备上的内容。清除会删掉这台设备上的便签，其他设备不受影响。</p>
        <button type="button" disabled={busy || hasUnsavedDraft} onClick={() => void onLogout()}>退出登录</button>
        <button type="button" className="danger-action" disabled={busy || hasUnsavedDraft || ownerId !== 'local-demo' && (outbox.length > 0 || conflicts.length > 0)} onClick={() => {
          if (hasPendingEditorWrites()) { toast.error('请稍等，正在保存'); return }
          if (confirm('确认已经导出备份，并清除这台设备上的便签？')) void run(async () => { await clearAccountFromDevice(ownerId); await onCleared() }, '这台设备上的数据已清除')
        }}>清除本机数据并退出</button>
      </section>
    </section>
  </div>
}
