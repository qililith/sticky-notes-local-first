import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Database, FileText, GripVertical, Menu, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Plus, Search, Settings, StickyNote, Sun, Trash2, X } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import type { User as AuthUser } from '@supabase/supabase-js'
import { accountKey, demoMode, forgetAccount, getRememberedAccount, rememberAccount, supabase } from './auth'
import { db } from './data/db'
import { accountClearedEventKey, isAccountSyncPaused, resumeAccountSync } from './data/accountSyncGate'
import { MAX_FOLDER_NAME_LENGTH } from './data/limits'
import { hasPendingEditorWrites, hasUnresolvedEditorDraft, setUnresolvedEditorDraft, subscribeEditorSafety } from './data/saveGuard'
import { createFolder, createNote, createNoteWithContent, deleteFolder, reorderFolders, setNoteContent, updateFolder, updateNote } from './data/repository'
import type { Note, RichText } from './data/types'
import { startSync } from './sync/engine'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { SettingsPanel } from './components/SettingsPanel'

type Account = { id: string; email: string }
type MobileHistoryState = { token: string; layer: 'list' | 'editor' | 'settings' | 'panel'; noteId: string | null; view: 'list' | 'editor'; settingsOpen: boolean }
const demoAccount: Account = { id: 'local-demo', email: '本地演示' }
const trashId = '__trash__'
const NoteEditor = lazy(() => import('./components/NoteEditor').then(module => ({ default: module.NoteEditor })))
const DataPanel = lazy(() => import('./components/DataPanel').then(module => ({ default: module.DataPanel })))

function Login({ onLogin, onDemo }: { onLogin: (email: string, password: string) => Promise<void>; onDemo: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="login-page"><div className="login-container">
    <div className="login-brand"><div className="brand-logo"><StickyNote size={48} /></div><h1 className="brand-title">便签</h1><p className="brand-subtitle">简单、优雅地记录想法</p></div>
    <div className="login-form"><form className="login-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await onLogin(email, password) } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败') } finally { setBusy(false) }
    }}>
      <h2 className="login-title">欢迎使用</h2><p className="login-desc">请使用管理员为你创建的账号登录</p>
      {!supabase && <p className="form-message">尚未配置云端服务。请先按操作指南设置。</p>}
      <input className="login-input" type="email" autoComplete="username" placeholder="邮箱" aria-label="邮箱" value={email} onChange={event => setEmail(event.target.value)} required />
      <input className="login-input" type="password" autoComplete="current-password" placeholder="密码" aria-label="密码" value={password} onChange={event => setPassword(event.target.value)} required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn-login" type="submit" disabled={busy || !supabase}>{busy ? '登录中…' : '登录'}</button>
      {demoMode && <button className="btn-login" type="button" onClick={onDemo}>进入本地演示</button>}
    </form></div>
  </div></div>
}

function formatDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const gap = Date.now() - date.getTime()
  if (gap < 60_000) return '刚刚'
  if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} 分钟前`
  if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} 小时前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function NotesWorkspace({ account, onLogout, sessionEnded, onDiscardDraft }: { account: Account; onLogout: () => Promise<void>; sessionEnded: boolean; onDiscardDraft: () => void }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  const [listStyle, setListStyle] = useState<'cards' | 'compact'>(() => localStorage.getItem('note-list-style') === 'compact' ? 'compact' : 'cards')
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [foldersExpanded, setFoldersExpanded] = useState(true)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [noteId, setNoteId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const folderCreateBusyRef = useRef(false)
  const folderCreateCancelRef = useRef(false)
  const folderRenameHandledRef = useRef(false)
  const [localError, setLocalError] = useState<{ noteId: string; message: string } | null>(null)
  const [dataPanelOpen, setDataPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [creatingNote, setCreatingNote] = useState(false)
  const creatingNoteRef = useRef(false)
  const hasUnsavedDraft = localError?.noteId === noteId
  const navigationToken = useRef(crypto.randomUUID())
  const activeMobileLayer = useRef<'list' | 'editor' | 'settings' | 'panel'>('list')
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId

  const canLeaveEditor = useCallback(() => {
    if (hasPendingEditorWrites()) { toast.error('本地仍在保存，请稍等再切换'); return false }
    if (hasUnsavedDraft || hasUnresolvedEditorDraft()) { toast.error('当前便签尚未保存，请先继续编辑或另存为新便签'); return false }
    return true
  }, [hasUnsavedDraft])
  const canLeaveEditorRef = useRef(canLeaveEditor)
  canLeaveEditorRef.current = canLeaveEditor

  useEffect(() => {
    if (!isMobile) return
    const marker: MobileHistoryState = { token: navigationToken.current, layer: 'list', noteId: null, view: 'list', settingsOpen: false }
    window.history.replaceState({ ...(window.history.state ?? {}), stickyNotesMobile: marker }, '')
    activeMobileLayer.current = 'list'
    const onPopState = (event: PopStateEvent) => {
      const entry = event.state?.stickyNotesMobile as MobileHistoryState | undefined
      const next = entry?.token === navigationToken.current ? entry.layer : 'list'
      if (activeMobileLayer.current === 'editor' && next === 'list' && !canLeaveEditorRef.current()) {
        window.history.pushState({ ...(window.history.state ?? {}), stickyNotesMobile: {
          token: navigationToken.current, layer: 'editor', noteId: noteIdRef.current,
          view: 'editor', settingsOpen: false
        } }, '')
        return
      }
      activeMobileLayer.current = next
      setDataPanelOpen(next === 'panel')
      setSettingsOpen(next === 'settings' || next === 'panel' && Boolean(entry?.settingsOpen))
      setMobileView(next === 'editor' || entry?.view === 'editor' ? 'editor' : 'list')
      if (next === 'editor' && entry?.noteId) setNoteId(entry.noteId)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [isMobile])

  useEffect(() => {
    if (!isMobile) return
    const layer = dataPanelOpen ? 'panel' : settingsOpen ? 'settings' : mobileView
    if (layer === activeMobileLayer.current) {
      if (layer === 'editor') {
        const entry = window.history.state?.stickyNotesMobile
        if (entry?.token === navigationToken.current && entry.noteId !== noteId) {
          window.history.replaceState({ ...window.history.state, stickyNotesMobile: { ...entry, noteId } }, '')
        }
      }
      return
    }
    if (layer === 'list' || activeMobileLayer.current === 'panel' && layer !== 'panel') {
      window.history.back()
      return
    }
    window.history.pushState({ ...(window.history.state ?? {}), stickyNotesMobile: {
      token: navigationToken.current, layer, noteId, view: mobileView, settingsOpen
    } }, '')
    activeMobileLayer.current = layer
  }, [isMobile, mobileView, settingsOpen, dataPanelOpen, noteId])

  const loadedNotes = useLiveQuery(() => db.notes.where('ownerId').equals(account.id).toArray(), [account.id])
  const notesLoaded = loadedNotes !== undefined
  const notes = loadedNotes ?? []
  const folders = useLiveQuery(() => db.folders.where('ownerId').equals(account.id).toArray(), [account.id], []) ?? []
  const outbox = useLiveQuery(() => db.outbox.where('ownerId').equals(account.id).toArray(), [account.id], []) ?? []
  const pendingCount = outbox.filter(item => item.state === 'pending' || item.state === 'inflight').length
  const rejectedIds = useMemo(() => new Set(outbox.filter(item => item.state === 'rejected' && item.entity === 'note').map(item => item.entityId)), [outbox])
  const rejectedCount = outbox.filter(item => item.state === 'rejected').length
  const conflicts = useLiveQuery(() => db.conflicts.where('ownerId').equals(account.id).toArray(), [account.id], []) ?? []
  const syncError = useLiveQuery(() => db.syncMeta.get(account.id), [account.id])?.lastError ?? null
  const selectedNote = notes.find(note => note.id === noteId) ?? null
  const currentNote = selectedNote && (!selectedNote.deletedAt || hasUnsavedDraft || hasPendingEditorWrites()) ? selectedNote : null
  const currentNoteHasConflict = Boolean(currentNote && conflicts.some(item => item.entity === 'note' && item.entityId === currentNote.id))
  const activeFolders = useMemo(() => folders.filter(folder => !folder.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)), [folders])
  const visibleNotes = useMemo(() => notes.filter(note => {
    if (folderId === trashId) return !!note.deletedAt
    if (note.deletedAt) return false
    if (query.trim()) {
      const search = query.trim().toLocaleLowerCase()
      return `${note.title}\n${note.plainText}`.toLocaleLowerCase().includes(search)
    }
    return folderId === null || note.folderId === folderId
  }).sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), [notes, folderId, query])

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('note-list-style', listStyle) }, [listStyle])
  useEffect(() => {
    if (!hasUnsavedDraft) return
    const warnOnClose = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnOnClose)
    return () => window.removeEventListener('beforeunload', warnOnClose)
  }, [hasUnsavedDraft])
  useEffect(() => () => setUnresolvedEditorDraft(false), [])
  useEffect(() => demoMode || sessionEnded ? undefined : startSync(account.id), [account.id, sessionEnded])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const changed = () => { setIsMobile(media.matches); if (!media.matches) setSidebarOpen(false) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    if (!notesLoaded) return
    if (noteId && notes.some(note => note.id === noteId) && !visibleNotes.some(note => note.id === noteId) && !hasUnsavedDraft && !hasPendingEditorWrites()) setNoteId(visibleNotes[0]?.id ?? null)
    if (!noteId && !isMobile && visibleNotes[0] && folderId !== trashId) setNoteId(visibleNotes[0].id)
  }, [noteId, notes, notesLoaded, visibleNotes, isMobile, folderId, hasUnsavedDraft])

  const editNote = useCallback(async (id: string, change: { title: string; doc: RichText; plainText: string }, expectedRev: number) => {
    try { const saved = await setNoteContent(account.id, id, change.doc, change.plainText, change.title, expectedRev); setUnresolvedEditorDraft(false); setLocalError(previous => previous?.noteId === id ? null : previous); return saved }
    catch (cause) { const message = cause instanceof Error ? cause.message : '本地保存失败'; setUnresolvedEditorDraft(true); setLocalError({ noteId: id, message }); toast.error(message); throw cause }
  }, [account.id])

  const saveCopy = useCallback(async (change: { title: string; doc: RichText; plainText: string }) => {
    try {
      const copy = await createNoteWithContent(account.id, currentNote?.folderId ?? null, change.title, change.doc, change.plainText)
      setUnresolvedEditorDraft(false); setLocalError(null); setNoteId(copy.id); setFolderId(null); toast.success('已保存为新便签')
      return true
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '副本保存失败'); return false }
  }, [account.id, currentNote?.folderId])

  const create = useCallback(async () => {
    if (creatingNoteRef.current || !canLeaveEditor()) return
    creatingNoteRef.current = true
    setCreatingNote(true)
    try {
      const note = await createNote(account.id, folderId === trashId ? null : folderId)
      setQuery(''); if (folderId === trashId) setFolderId(null)
      setNoteId(note.id); setMobileView('editor'); setSidebarOpen(false)
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '新建失败') }
    finally { creatingNoteRef.current = false; setCreatingNote(false) }
  }, [account.id, folderId, canLeaveEditor])

  const act = async (task: () => Promise<unknown>, success?: string) => {
    try { await task(); if (success) toast.success(success) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '操作失败') }
  }

  const moveFolder = (sourceId: string, targetId: string) => {
    const expectedOrder = activeFolders.map(folder => folder.id)
    const ordered = [...expectedOrder]
    const source = ordered.indexOf(sourceId)
    const target = ordered.indexOf(targetId)
    if (source < 0 || target < 0 || source === target) return
    ordered.splice(target, 0, ordered.splice(source, 1)[0])
    void act(() => reorderFolders(account.id, ordered, expectedOrder))
  }

  const saveFolderName = (id: string) => {
    if (!editingName.trim()) { setEditingFolderId(null); return }
    const name = editingName
    folderRenameHandledRef.current = true
    setEditingFolderId(null)
    void act(() => updateFolder(account.id, id, { name }), '已重命名')
  }

  const createFolderAtTop = () => {
    if (folderCreateBusyRef.current) return
    const name = newFolderName.trim()
    if (!name) { setCreatingFolder(false); setNewFolderName(''); return }
    const previousOrder = activeFolders.map(folder => folder.id)
    folderCreateBusyRef.current = true
    folderCreateCancelRef.current = false
    void (async () => {
      try {
        const folder = await createFolder(account.id, name)
        setCreatingFolder(false)
        setNewFolderName('')
        await reorderFolders(account.id, [folder.id, ...previousOrder], [...previousOrder, folder.id])
        toast.success('文件夹已创建')
      } catch (cause) { toast.error(cause instanceof Error ? cause.message : '创建文件夹失败') }
      finally { folderCreateBusyRef.current = false }
    })()
  }

  const cancelFolderCreation = () => {
    folderCreateCancelRef.current = true
    setCreatingFolder(false)
    setNewFolderName('')
  }

  const selectFolder = (id: string | null) => { if (!canLeaveEditor()) return; setFolderId(id); setQuery(''); setNoteId(null); setSidebarOpen(false); setMobileView('list') }
  const chooseNote = (note: Note) => { if (note.deletedAt || note.id !== noteId && !canLeaveEditor()) return; setNoteId(note.id); if (isMobile) setMobileView('editor') }
  const selectedFolderName = folderId === trashId ? '回收站' : activeFolders.find(folder => folder.id === folderId)?.name ?? '全部便签'

  return <div className={`app-layout ${isMobile && mobileView === 'editor' ? 'mobile-editing-layout' : ''} ${sessionEnded ? 'session-ended' : ''}`}>
    {isMobile && <header className="app-header">
      {isMobile && <button type="button" className="btn-menu" aria-label={mobileView === 'editor' ? '返回列表' : '打开菜单'} onClick={() => mobileView === 'editor' ? canLeaveEditor() && setMobileView('list') : setSidebarOpen(true)}>
        {mobileView === 'editor' ? <ArrowLeft size={20} /> : <Menu size={20} />}
      </button>}
      <div className="app-actions"><button type="button" className="btn-theme data-status-button" aria-label={conflicts.length ? `设置，${conflicts.length} 项冲突` : rejectedCount ? `设置，${rejectedCount} 项需处理` : syncError ? '设置，同步失败' : '设置'} title="设置" onClick={() => setSettingsOpen(true)}><Settings size={20} />{(conflicts.length > 0 || rejectedCount > 0 || syncError) && <span className="conflict-badge" aria-hidden="true">{conflicts.length || rejectedCount || '!'}</span>}</button></div>
    </header>}
    {sessionEnded && <div className="session-ended-banner" role="alert"><span>当前账号已退出或切换。请先处理草稿；本地保存完成后会自动退出。</span>{hasUnsavedDraft && <button type="button" onClick={onDiscardDraft}>草稿已复制，退出</button>}</div>}
    {isMobile && sidebarOpen && <div className="sidebar-overlay" aria-hidden="true" onClick={() => setSidebarOpen(false)} />}
    <div className="app-main">
      <aside className={`app-sidebar ${isMobile ? 'mobile-sidebar' : ''} ${sidebarOpen ? 'open' : ''} ${!isMobile && !desktopSidebarOpen ? 'desktop-collapsed' : ''}`} aria-hidden={!isMobile && !desktopSidebarOpen}>
        <div className="folder-list">
          <div className="sidebar-top-row"><button type="button" className={`folder-item system-folder all-notes-item ${folderId === null ? 'active' : ''}`} onClick={() => selectFolder(null)}><span className="folder-item-name">全部便签</span></button>{!isMobile && desktopSidebarOpen && <button type="button" className="btn-icon btn-ghost sidebar-collapse-btn" title="收起侧栏" aria-label="收起侧栏" onClick={() => setDesktopSidebarOpen(false)}><PanelLeftClose size={15} /></button>}</div>
          <div className="folder-list-header">{isMobile ? <h3 className="folder-list-title mobile-folder-title">文件夹</h3> : <button type="button" className="folder-list-title-btn" aria-expanded={foldersExpanded} onClick={() => setFoldersExpanded(!foldersExpanded)}>{foldersExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<h3 className="folder-list-title">文件夹</h3></button>}<button type="button" className="btn-icon btn-ghost folder-add-btn" title="新建文件夹" aria-label="新建文件夹" onClick={() => { folderCreateCancelRef.current = false; setCreatingFolder(true) }}><Plus size={14} /></button></div>
          {(isMobile || foldersExpanded) && <div className="folder-list-content">
            {creatingFolder && <form className="folder-create-form" onSubmit={event => { event.preventDefault(); createFolderAtTop() }}><input className="folder-create-input" autoFocus placeholder="输入文件夹名称" aria-label="新文件夹名称" title={`按 Enter 创建，按 Escape 取消；名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`} maxLength={MAX_FOLDER_NAME_LENGTH} value={newFolderName} onChange={event => setNewFolderName(event.target.value)} onBlur={() => { if (folderCreateCancelRef.current) { folderCreateCancelRef.current = false; return } createFolderAtTop() }} onKeyDown={event => { if (event.key === 'Escape') cancelFolderCreation() }} /></form>}
            {activeFolders.map(folder => <div key={folder.id} className={`folder-item ${folderId === folder.id ? 'active' : ''}`} draggable={editingFolderId !== folder.id} onDragStart={event => event.dataTransfer.setData('text/plain', folder.id)} onDragOver={event => event.preventDefault()} onDrop={event => {
              event.preventDefault(); moveFolder(event.dataTransfer.getData('text/plain'), folder.id)
            }} onClick={() => { if (editingFolderId !== folder.id) selectFolder(folder.id) }}>
              <GripVertical size={14} className="folder-drag-handle" />
              {editingFolderId === folder.id ? <input className="folder-edit-input" autoFocus aria-label="重命名文件夹" title={`按 Enter 保存，按 Escape 取消；名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`} maxLength={MAX_FOLDER_NAME_LENGTH} value={editingName} onClick={event => event.stopPropagation()} onChange={event => setEditingName(event.target.value)} onBlur={() => { if (folderRenameHandledRef.current) { folderRenameHandledRef.current = false; return } saveFolderName(folder.id) }} onKeyDown={event => { if (event.key === 'Escape') { folderRenameHandledRef.current = true; setEditingFolderId(null) } if (event.key === 'Enter') { event.preventDefault(); saveFolderName(folder.id) } }} /> : <span className="folder-item-name">{folder.name}</span>}
              {editingFolderId !== folder.id && <div className="folder-actions"><button type="button" className="btn-icon-sm" title="重命名" onClick={event => { event.stopPropagation(); folderRenameHandledRef.current = false; setEditingFolderId(folder.id); setEditingName(folder.name) }}><Pencil size={14} /></button><button type="button" className="btn-icon-sm danger" title="删除文件夹" onClick={event => { event.stopPropagation(); if (currentNote?.folderId === folder.id && !canLeaveEditor()) return; if (confirm('删除文件夹？其中的便签会保留在全部便签中。')) void act(async () => { await deleteFolder(account.id, folder.id); if (folderId === folder.id) selectFolder(null) }, '文件夹已删除') }}><Trash2 size={14} /></button></div>}
            </div>)}
          </div>}
        </div>
        {!isMobile && <div className="sidebar-divider" />}
        {!isMobile && <NoteList notes={visibleNotes} loading={!notesLoaded} currentNoteId={noteId} rejectedIds={rejectedIds} label={query ? '搜索结果' : selectedFolderName} isTrash={folderId === trashId} query={query} setQuery={setQuery} onCreate={() => void create()} onSelect={chooseNote} onDelete={note => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNote(account.id, note.id, { deletedAt: new Date().toISOString() }), '已移入回收站') }} onRestore={note => void act(() => updateNote(account.id, note.id, { deletedAt: null }), '已恢复')} onPin={note => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNote(account.id, note.id, { isPinned: !note.isPinned })) }} />}
        <button type="button" className={`folder-item system-folder sidebar-trash ${folderId === trashId ? 'active' : ''}`} onClick={() => selectFolder(trashId)}><Trash2 size={14} /><span className="folder-item-name">回收站</span></button>
      </aside>
      {isMobile && mobileView === 'list' && <div className="mobile-note-list-container"><NoteList isMobile listStyle={listStyle} notes={visibleNotes} loading={!notesLoaded} currentNoteId={noteId} rejectedIds={rejectedIds} label={query ? '搜索结果' : selectedFolderName} isTrash={folderId === trashId} query={query} setQuery={setQuery} onCreate={() => void create()} onSelect={chooseNote} onDelete={note => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNote(account.id, note.id, { deletedAt: new Date().toISOString() }), '已移入回收站') }} onRestore={note => void act(() => updateNote(account.id, note.id, { deletedAt: null }), '已恢复')} onPin={note => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNote(account.id, note.id, { isPinned: !note.isPinned })) }} /></div>}
      {(!isMobile || mobileView === 'editor' || sessionEnded) && <main className={`app-editor ${isMobile ? 'mobile-active' : ''}`}>{creatingNote ? <div className="editor-empty">正在新建便签…</div> : currentNote ? <Suspense fallback={<div className="editor-empty">加载编辑器…</div>}><NoteEditor onBack={() => { if (canLeaveEditor()) setMobileView('list') }} onPin={() => { if (canLeaveEditor()) void act(() => updateNote(account.id, currentNote.id, { isPinned: !currentNote.isPinned })) }} onDelete={() => { if (!canLeaveEditor()) return; void act(async () => { await updateNote(account.id, currentNote.id, { deletedAt: new Date().toISOString() }); setNoteId(null); setMobileView('list') }, '已移入回收站') }} note={currentNote} folders={activeFolders} onEdit={editNote} onSaveCopy={saveCopy} onDiscardError={() => { setUnresolvedEditorDraft(false); setLocalError(null) }} onMoveFolder={destination => { if (!canLeaveEditor()) return; void act(() => updateNote(account.id, currentNote.id, { folderId: destination }), '已移动') }} onOpenSidebar={!isMobile && !desktopSidebarOpen ? () => setDesktopSidebarOpen(true) : undefined} onOpenConflicts={() => { if (!sessionEnded) setDataPanelOpen(true) }} localError={localError?.noteId === currentNote.id ? localError.message : null} syncError={syncError} pendingCount={pendingCount} syncIssueCount={conflicts.length + rejectedCount} hasConflict={currentNoteHasConflict} isMobile={isMobile} theme={theme} onToggleTheme={() => setTheme(current => current === 'light' ? 'dark' : 'light')} /></Suspense> : <div className="editor-empty"><div className="empty-editor-toolbar">{!isMobile && !desktopSidebarOpen && <button type="button" className="toolbar-btn" title="展开侧栏" aria-label="展开侧栏" onClick={() => setDesktopSidebarOpen(true)}><PanelLeftOpen size={18} /></button>}<div className="toolbar-spacer" /><button type="button" className="sync-status-button" title="打开数据与同步" onClick={() => setDataPanelOpen(true)}><Database size={15} /><span>数据与同步</span>{conflicts.length + rejectedCount > 0 && <span className="sync-issue-badge">{conflicts.length + rejectedCount}</span>}</button><button type="button" className="toolbar-btn" aria-label="切换主题" title="切换主题" onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</button></div><div className="editor-empty-content"><p>选择或创建一个便签开始编辑</p></div></div>}</main>}
    </div>
    {settingsOpen && !sessionEnded && <SettingsPanel listStyle={listStyle} onListStyleChange={setListStyle} theme={theme} onThemeChange={setTheme} onClose={() => setSettingsOpen(false)} onOpenSync={() => setDataPanelOpen(true)} hasSyncIssue={Boolean(conflicts.length || rejectedCount || syncError)} syncStatus={demoMode ? '本地演示，不连接云端' : conflicts.length ? `${conflicts.length} 项冲突待处理` : rejectedCount ? `${rejectedCount} 项需处理` : syncError ? '同步失败，点击查看' : pendingCount ? `${pendingCount} 项待同步` : '查看同步状态与数据'} />}
    {dataPanelOpen && !sessionEnded && <Suspense fallback={null}><DataPanel ownerId={account.id} note={currentNote} currentFolderId={folderId === trashId ? undefined : folderId} hasUnsavedDraft={Boolean(hasUnsavedDraft)} onClose={() => setDataPanelOpen(false)} onLogout={async () => { if (!canLeaveEditor()) return; setDataPanelOpen(false); await onLogout() }} onCleared={onLogout} /></Suspense>}
  </div>
}

function NoteList({ notes, loading, currentNoteId, rejectedIds, label, query, setQuery, isTrash, isMobile = false, listStyle = 'cards', onCreate, onSelect, onDelete, onRestore, onPin }: {
  notes: Note[]; loading: boolean; currentNoteId: string | null; rejectedIds: Set<string>; label: string; query: string; setQuery: (value: string) => void; isTrash: boolean; isMobile?: boolean; listStyle?: 'cards' | 'compact'
  onCreate: () => void; onSelect: (note: Note) => void; onDelete: (note: Note) => void; onRestore: (note: Note) => void; onPin: (note: Note) => void
}) {
  const [searchOpen, setSearchOpen] = useState(Boolean(query))
  const closeSearch = () => { setQuery(''); setSearchOpen(false) }
  return <div className={`note-list ${isMobile && listStyle === 'compact' ? 'compact-note-list' : ''} ${isTrash ? 'is-trash' : ''}`}>{(!isMobile || isTrash) && <div className="note-list-header"><div className="note-list-heading"><h3 className="note-list-title" title={label}>{isTrash ? '回收站' : '便签'}</h3>{!isTrash && !isMobile && <button type="button" className={`btn-icon btn-ghost note-search-toggle ${searchOpen ? 'active' : ''}`} title={searchOpen ? '收起搜索' : '搜索便签'} aria-label={searchOpen ? '收起搜索' : '搜索便签'} aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>{searchOpen ? <X size={16} /> : <Search size={16} />}</button>}</div>{!isMobile && <button type="button" className="btn-icon btn-primary" title="新建便签" aria-label="新建便签" onClick={onCreate}><Plus size={18} /></button>}</div>}
    {!isTrash && (isMobile || searchOpen) && <label className={`search-box ${isMobile ? 'mobile-list-search' : 'search-box-expanded'}`}><Search size={18} /><input autoFocus={!isMobile} aria-label="搜索便签" placeholder="搜索便签" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') closeSearch() }} />{isMobile && query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={18} /></button>}</label>}
    <div className="note-list-content" role="listbox" aria-label={label}>{loading ? <div className="note-list-empty"><p>正在读取这台设备上的便签…</p></div> : notes.length ? notes.map(note => <div key={note.id} role="option" aria-selected={currentNoteId === note.id} tabIndex={0} className={`note-item ${currentNoteId === note.id ? 'active' : ''} ${note.isPinned ? 'pinned' : ''}`} onClick={() => onSelect(note)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(note) } }}>
      <div className="note-item-header"><h4 className="note-item-title">{note.title || (isMobile && listStyle === 'compact' ? note.plainText.trim().split('\n')[0].slice(0, 60) : '') || '无标题'}</h4><div className="note-item-actions">{isTrash ? <button type="button" className="btn-icon-sm" title="恢复" onClick={event => { event.stopPropagation(); onRestore(note) }}><Check size={14} /></button> : <><button type="button" className="btn-icon-sm" title={note.isPinned ? '取消置顶' : '置顶'} onClick={event => { event.stopPropagation(); onPin(note) }}><Pin size={14} /></button><button type="button" className="btn-icon-sm danger" title="移入回收站" onClick={event => { event.stopPropagation(); if (confirm('将这条便签移入回收站？')) onDelete(note) }}><Trash2 size={14} /></button></>}</div></div>
      <p className="note-item-summary">{note.plainText.slice(0, 80) || '无内容'}</p><div className="note-item-footer"><span className="note-item-date">{formatDate(note.updatedAt)}</span>{rejectedIds.has(note.id) && !isTrash && <span className="note-item-badge">需处理</span>}{note.isPinned && !isTrash && <span className="note-item-badge">置顶</span>}</div>
    </div>) : <div className="note-list-empty"><FileText size={48} className="empty-icon" /><p>{query ? '没有找到便签' : isTrash ? '回收站为空' : '暂无便签'}</p>{!isMobile && !isTrash && !query && <button type="button" className="btn-text" onClick={onCreate}>创建第一条便签</button>}</div>}</div>
    {isMobile && <button type="button" className="mobile-list-create" title="新建便签" aria-label="新建便签" onClick={onCreate}><Plus size={26} /></button>}
  </div>
}

export function App() {
  const [account, setAccount] = useState<Account | null>(demoMode ? demoAccount : null)
  const [loading, setLoading] = useState(!demoMode)
  const [sessionEnded, setSessionEnded] = useState(false)
  const accountRef = useRef(account)
  const completeLogin = useRef<((user: AuthUser) => void) | null>(null)
  accountRef.current = account

  useEffect(() => {
    if (!sessionEnded) return
    const lockWhenSafe = () => {
      if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) return
      setSessionEnded(false)
      setAccount(null)
    }
    const unsubscribe = subscribeEditorSafety(lockWhenSafe)
    lockWhenSafe()
    return unsubscribe
  }, [sessionEnded])

  useEffect(() => {
    const clearedElsewhere = (event: StorageEvent) => {
      const current = accountRef.current
      const cleared = current && event.key === accountClearedEventKey(current.id) && event.newValue
      const signedOut = event.key === accountKey && event.newValue === null && !getRememberedAccount()
      if (!current || !cleared && !signedOut) return
      if (getRememberedAccount()?.id === current.id) forgetAccount()
      if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) setSessionEnded(true)
      else { setSessionEnded(false); setAccount(null) }
    }
    window.addEventListener('storage', clearedElsewhere)
    return () => window.removeEventListener('storage', clearedElsewhere)
  }, [])

  useEffect(() => {
    const warnOnClose = (event: BeforeUnloadEvent) => {
      if (!hasPendingEditorWrites() && !hasUnresolvedEditorDraft()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnOnClose)
    return () => window.removeEventListener('beforeunload', warnOnClose)
  }, [])

  useEffect(() => {
    if (demoMode) return
    let active = true
    const remembered = getRememberedAccount()
    // This hint opens only the local cache; the sync engine still checks the real session.
    if (remembered && !isAccountSyncPaused(remembered.id)) {
      accountRef.current = remembered
      setAccount(remembered)
    }
    setLoading(false)
    const client = supabase
    if (!client) return
    let authRevision = 0
    let verificationId = 0
    let verificationAllowed = true
    let verificationPending = false
    let eventTimer: number | undefined
    const lock = () => {
      verificationAllowed = false
      forgetAccount()
      if (hasPendingEditorWrites() || hasUnresolvedEditorDraft()) setSessionEnded(true)
      else { accountRef.current = null; setSessionEnded(false); setAccount(null) }
    }
    const accept = (user: AuthUser) => {
      if (isAccountSyncPaused(user.id)) return
      if (accountRef.current && accountRef.current.id !== user.id && (hasPendingEditorWrites() || hasUnresolvedEditorDraft())) {
        lock(); return
      }
      rememberAccount(user)
      accountRef.current = { id: user.id, email: user.email ?? '' }
      setSessionEnded(false)
      setAccount(accountRef.current)
    }
    const verify = async () => {
      if (!active || !navigator.onLine || !verificationAllowed || verificationPending) return
      const hint = getRememberedAccount()
      if (!hint || isAccountSyncPaused(hint.id)) return
      const revision = authRevision
      const requestId = ++verificationId
      verificationPending = true
      try {
        const { data, error } = await client.auth.getUser()
        if (!active || revision !== authRevision || requestId !== verificationId || getRememberedAccount()?.id !== hint.id) return
        if (data.user && !error) accept(data.user)
        else if (!error || error.name === 'AuthSessionMissingError' || error.status === 401 || error.status === 403
          || ['user_banned', 'user_not_found', 'session_not_found', 'refresh_token_not_found', 'refresh_token_already_used'].includes(error.code ?? '')) {
          lock()
        }
        // Transient/unknown failures leave the local workspace open. Never delete its data.
      } catch { /* A transport failure is not proof that this account was signed out. */ }
      finally { if (requestId === verificationId) verificationPending = false }
    }
    const retry = () => { void verify() }
    const signedIn = (user: AuthUser) => {
      authRevision += 1
      verificationId += 1
      verificationPending = false
      verificationAllowed = true
      accept(user)
      // Defer nested auth work until this state-change callback has returned.
      window.clearTimeout(eventTimer)
      eventTimer = window.setTimeout(retry, 0)
    }
    completeLogin.current = signedIn
    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'SIGNED_OUT') {
        authRevision += 1
        lock()
      }
      // A leftover SDK session must not undo a local lock, including on an offline reload.
      // An explicit form login reopens this device through completeLogin below.
      if (event === 'SIGNED_IN' && session?.user && getRememberedAccount()) signedIn(session.user)
    })
    retry()
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    const timer = window.setInterval(retry, 60_000)
    return () => {
      active = false
      completeLogin.current = null
      window.clearTimeout(eventTimer)
      window.clearInterval(timer)
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      subscription.subscription.unsubscribe()
    }
  }, [])

  const login = async (email: string, password: string) => {
    if (!supabase) throw new Error('云端服务尚未配置')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !data.user) throw new Error(error?.message ?? '登录失败')
    resumeAccountSync(data.user.id)
    rememberAccount(data.user)
    completeLogin.current?.(data.user)
  }

  const logout = async () => {
    if (!demoMode) { try { await supabase?.auth.signOut({ scope: 'local' }) } catch { /* Local account lock still applies. */ } }
    forgetAccount()
    setAccount(null)
  }

  const discardDraftAndLock = () => {
    if (hasPendingEditorWrites() || !window.confirm('确认草稿已复制到其他地方？退出后未保存的修改会丢失。')) return
    setSessionEnded(false)
    setAccount(null)
  }

  // These toasts contain status text only; they must not intercept toolbar clicks.
  return <><Toaster position="top-right" style={{ pointerEvents: 'none' }} toastOptions={{ style: { pointerEvents: 'none' } }} />{!sessionEnded && <PwaUpdatePrompt />}{loading ? <div className="app-loading"><div className="loading-spinner" /><p>加载中…</p></div> : account ? <NotesWorkspace key={account.id} account={account} onLogout={logout} sessionEnded={sessionEnded} onDiscardDraft={discardDraftAndLock} /> : <Login onLogin={login} onDemo={() => setAccount(demoAccount)} />}</>
}
