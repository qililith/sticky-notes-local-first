import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { createEditorExtensions } from '../data/editorSchema'
import { sameStructuredValue } from '../data/equality'
import { ArrowLeft, Bold, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, Database, Download, FileText, FolderInput, Heading1, Heading2, Heading3, Highlighter, Italic, List, ListOrdered, Maximize2, Menu, Minimize2, Moon, PanelLeftOpen, Pin, Redo2, Sun, Trash2, Type, Undo2, X } from 'lucide-react'
import type { Folder, Note, RichText } from '../data/types'
import { MAX_TITLE_LENGTH, titleWithSuffix } from '../data/limits'
import { beginEditorWrite } from '../data/saveGuard'
import { downloadNoteExport, type NoteExportFormat } from '../data/noteExport'
import { clearRecoveryDraft, readRecoveryDraft, writeRecoveryDraft } from '../data/recoveryDraft'
import { drainLatestWrite } from '../data/latestWriteQueue'

type Props = {
  note: Note | null
  folders: Folder[]
  onEdit: (id: string, change: { title: string; doc: RichText; plainText: string }, expectedRev: number) => Promise<Note>
  onSaveCopy: (change: { title: string; doc: RichText; plainText: string }) => Promise<boolean>
  onDiscardError: () => void
  onMoveFolder: (folderId: string | null) => void
  onOpenSidebar?: () => void
  onOpenConflicts: () => void
  localError: string | null
  syncError: string | null
  pendingCount: number
  syncIssueCount: number
  hasConflict: boolean
  isMobile: boolean
  theme: string
  onToggleTheme: () => void
  onBack?: () => void
  onPin?: () => void
  onDelete?: () => void
}

const RECOVERY_DRAFT_INTERVAL_MS = 5000

function EditorBody({ note, folders, onEdit, onSaveCopy, onDiscardError, onMoveFolder, onOpenSidebar, onOpenConflicts, localError, syncError, pendingCount, syncIssueCount, hasConflict, isMobile, theme, onToggleTheme, onBack, onPin, onDelete }: Props & { note: Note }) {
  const [title, setTitle] = useState(note.title)
  const titleRef = useRef(note.title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [wordCount, setWordCount] = useState(note.plainText.length)
  const queuedChange = useRef<{ doc: RichText; plainText: string; title: string } | null>(null)
  const latestRecoveryChange = useRef<{ doc: RichText; plainText: string; title: string } | null>(null)
  const recoveryWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryToken = useRef<string | null>(null)
  const saveQueueRunning = useRef(false)
  const expectedRev = useRef(note.localRev)
  const [saving, setSaving] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const [recoveryDraft, setRecoveryDraft] = useState(() => readRecoveryDraft(note.ownerId, note.id))
  const toolbarGroupRef = useRef<HTMLDivElement>(null)
  const folderMenuRef = useRef<HTMLDetailsElement>(null)
  const [toolbarOverflow, setToolbarOverflow] = useState(false)
  const [toolbarShifted, setToolbarShifted] = useState(false)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const [mobileEditing, setMobileEditing] = useState(false)
  const [fontPanelOpen, setFontPanelOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState<'actions' | 'folders' | 'export' | null>(null)
  const mobileMenuRef = useRef<HTMLDialogElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)

  const persistRecoveryDraft = useCallback(() => {
    if (recoveryWriteTimer.current !== null) clearTimeout(recoveryWriteTimer.current)
    recoveryWriteTimer.current = null
    const latest = latestRecoveryChange.current
    if (!latest) return
    recoveryToken.current = writeRecoveryDraft(note.ownerId, note.id, latest)
  }, [note.id, note.ownerId])

  useEffect(() => {
    const flushRecovery = () => persistRecoveryDraft()
    window.addEventListener('pagehide', flushRecovery)
    window.addEventListener('beforeunload', flushRecovery)
    return () => {
      window.removeEventListener('pagehide', flushRecovery)
      window.removeEventListener('beforeunload', flushRecovery)
      persistRecoveryDraft()
    }
  }, [persistRecoveryDraft])

  const enqueue = useCallback((doc: RichText, plainText: string, nextTitle: string) => {
    const capturedId = note.id
    const change = { doc, plainText, title: nextTitle }
    queuedChange.current = change
    latestRecoveryChange.current = change
    if (recoveryWriteTimer.current === null) {
      recoveryWriteTimer.current = setTimeout(persistRecoveryDraft, RECOVERY_DRAFT_INTERVAL_MS)
    }
    if (saveQueueRunning.current) return
    saveQueueRunning.current = true
    const endWrite = beginEditorWrite()
    setSaving(true)
    void drainLatestWrite(
      () => {
        const next = queuedChange.current
        queuedChange.current = null
        return next
      },
      async next => {
        try {
          const saved = await onEdit(capturedId, next, expectedRev.current)
          expectedRev.current = saved.localRev
          if (!queuedChange.current) {
            latestRecoveryChange.current = null
            if (recoveryWriteTimer.current !== null) clearTimeout(recoveryWriteTimer.current)
            recoveryWriteTimer.current = null
            if (recoveryToken.current) clearRecoveryDraft(note.ownerId, capturedId, recoveryToken.current)
            recoveryToken.current = null
          }
        } catch { /* onEdit reports the failure; keep the recovery draft for the user. */ }
      }
    ).finally(() => {
      saveQueueRunning.current = false
      endWrite()
      setSaving(false)
    })
  }, [note.id, note.ownerId, onEdit, persistRecoveryDraft])

  const editor = useEditor({
    extensions: createEditorExtensions(),
    enablePasteRules: false,
    content: note.doc,
    onUpdate: ({ editor: changed }) => {
      const plainText = changed.getText({ blockSeparator: '\n' })
      setWordCount(plainText.length)
      enqueue(changed.getJSON() as RichText, plainText, titleRef.current)
    },
    editorProps: {
      attributes: { class: 'editor-content', 'aria-label': '便签正文' },
      transformPastedHTML: () => '',
      handlePaste: (view, event) => {
        if (!event.clipboardData) return false
        const plain = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
        event.preventDefault()
        if (!plain) { toast.error('剪贴板没有可粘贴的纯文本'); return true }
        const { state } = view
        if (state.selection.$from.parent.type.spec.code) {
          view.dispatch(closeHistory(state.tr).insertText(plain).scrollIntoView())
          view.dispatch(closeHistory(view.state.tr))
          return true
        }
        // Use the current view, not the editor reference captured during its
        // initialization. Text nodes preserve literal HTML and empty lines.
        const marks = state.storedMarks ?? state.selection.$from.marks()
        const paragraphs = plain.split('\n').map(line => state.schema.nodes.paragraph.create(null,
          line ? state.schema.text(line, marks) : undefined))
        const slice = Slice.maxOpen(Fragment.fromArray(paragraphs))
        view.dispatch(closeHistory(state.tr).replaceSelection(slice).setMeta('uiEvent', 'paste').scrollIntoView())
        view.dispatch(closeHistory(view.state.tr))
        return true
      }
    }
  }, [note.id])

  useEffect(() => {
    if (!editor || note.localRev <= expectedRev.current) return
    if (saving || localError || editor.isFocused || document.activeElement === titleInputRef.current) { setExternalChange(true); return }
    editor.commands.setContent(note.doc, { emitUpdate: false })
    titleRef.current = note.title
    setTitle(note.title)
    setWordCount(note.plainText.length)
    expectedRev.current = note.localRev
    setExternalChange(false)
    onDiscardError()
  }, [editor, note.localRev, note.doc, note.title, note.plainText, saving, localError, onDiscardError])

  useEffect(() => {
    titleRef.current = note.title
    setTitle(note.title)
  }, [note.id])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullscreen(false)
        setFolderMenuOpen(false)
        setFontPanelOpen(false)
        setMobileMenu(null)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    if (!isMobile) return
    const viewport = window.visualViewport
    const resize = () => document.documentElement.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    resize()
    viewport?.addEventListener('resize', resize)
    return () => {
      viewport?.removeEventListener('resize', resize)
      document.documentElement.style.removeProperty('--mobile-viewport-height')
    }
  }, [isMobile])

  useEffect(() => {
    const dialog = mobileMenuRef.current
    if (mobileMenu && isMobile) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) {
      dialog.close()
      moreButtonRef.current?.focus()
    }
  }, [mobileMenu, isMobile])

  useEffect(() => {
    const group = toolbarGroupRef.current
    if (!group) return
    const updateScrollState = () => {
      setToolbarOverflow(group.scrollWidth - group.clientWidth > 2)
      setToolbarShifted(group.scrollLeft > 8)
    }
    const resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(group)
    group.addEventListener('scroll', updateScrollState, { passive: true })
    const frame = window.requestAnimationFrame(updateScrollState)
    return () => {
      window.cancelAnimationFrame(frame)
      group.removeEventListener('scroll', updateScrollState)
      resizeObserver.disconnect()
    }
  }, [isMobile])

  const toolbar = [
    { label: '加粗', icon: Bold, action: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', icon: Italic, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: '高亮', icon: Highlighter, action: () => editor?.chain().focus().toggleHighlight().run() },
    { label: '大标题', icon: Heading1, action: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '中标题', icon: Heading2, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '小标题', icon: Heading3, action: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: '无序列表', icon: List, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '有序列表', icon: ListOrdered, action: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: '待办清单', icon: CheckSquare, action: () => editor?.chain().focus().toggleTaskList().run() },
    { label: '撤销', icon: Undo2, action: () => editor?.chain().focus().undo().run() },
    { label: '重做', icon: Redo2, action: () => editor?.chain().focus().redo().run() }
  ]
  const saveStatus = localError ? '本地未保存' : externalChange ? '其它窗口已更新' : saving ? '本地保存中…' : hasConflict ? '本地已保存 · 同步冲突' : syncError ? '本地已保存 · 同步失败' : pendingCount ? `本地已保存 · 待同步 ${pendingCount}` : '本地已保存'
  const idleSaveStatus = !localError && !externalChange && !saving && !hasConflict && !syncError && !pendingCount
  const hasSaveIssue = Boolean(localError || externalChange || hasConflict || syncError || syncIssueCount)
  const hasRecoverableDraft = recoveryDraft && (recoveryDraft.title !== note.title
    || recoveryDraft.plainText !== note.plainText || !sameStructuredValue(recoveryDraft.doc, note.doc))
  useEffect(() => { editor?.setEditable(!hasRecoverableDraft) }, [editor, hasRecoverableDraft])
  const exportNote = (format: NoteExportFormat) => {
    if (!editor) return
    try {
      downloadNoteExport({ title: titleRef.current, doc: editor.getJSON() as RichText }, format)
      setMobileMenu(null)
      toast.success('下载已发起，请检查下载文件')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '导出失败') }
  }
  const moveToFolder = (folderId: string | null) => { setFolderMenuOpen(false); onMoveFolder(folderId) }
  const toggleToolbarPage = () => {
    const group = toolbarGroupRef.current
    if (!group) return
    group.scrollTo({ left: toolbarShifted ? 0 : group.scrollWidth, behavior: 'smooth' })
  }
  const handleToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || (event.target as HTMLElement).closest('.toolbar-folder-popover')) return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary'))
      .filter(control => control.offsetParent !== null && !control.closest('.toolbar-folder-popover'))
    const current = controls.indexOf(event.target as HTMLElement)
    if (current < 0 || controls.length === 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowRight' ? (current + 1) % controls.length : (current - 1 + controls.length) % controls.length
    event.preventDefault()
    controls[next]?.focus()
  }
  const handleFolderMenuKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setFolderMenuOpen(false)
      folderMenuRef.current?.querySelector<HTMLElement>('summary')?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    const items = Array.from(folderMenuRef.current?.querySelectorAll<HTMLButtonElement>('.toolbar-folder-popover button') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className={`editor-container ${fullscreen ? 'fullscreen' : ''} ${isMobile ? 'mobile-editor' : ''}`}>
      {hasRecoverableDraft && <div className="session-ended-banner" role="alert">
        <span>上次关闭时有一段内容尚未确认保存。</span>
        <button type="button" onClick={() => void (async () => {
          if (await onSaveCopy({ title: titleWithSuffix(recoveryDraft.title, '（找回副本）'), doc: recoveryDraft.doc, plainText: recoveryDraft.plainText })) {
            clearRecoveryDraft(note.ownerId, note.id, recoveryDraft.token)
          }
        })()}>另存这段内容</button>
        <button type="button" onClick={() => {
          if (!confirm('确认不需要找回上次未保存的内容？')) return
          clearRecoveryDraft(note.ownerId, note.id, recoveryDraft.token)
          setRecoveryDraft(null)
        }}>保留当前便签</button>
      </div>}
      {isMobile && <div className="mobile-editor-header">
        <button type="button" aria-label="返回列表" onClick={onBack}><ArrowLeft size={22} /></button>
        <div className="mobile-header-spacer" />
        {toolbar.slice(9).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={21} /></button>)}
        <button type="button" ref={moreButtonRef} aria-label="更多便签操作" aria-haspopup="dialog" aria-expanded={Boolean(mobileMenu)} onClick={() => { setFontPanelOpen(false); setMobileMenu('actions') }}><Menu size={23} />{hasSaveIssue && <span className="mobile-issue-dot" />}</button>
      </div>}
      {(!isMobile || localError || externalChange || hasConflict || syncError) && <div className={`editor-toolbar ${isMobile ? 'mobile-recovery-toolbar' : ''}`} role="toolbar" aria-label="便签编辑工具" onKeyDown={handleToolbarKeyDown}>
        {onOpenSidebar && <button type="button" className="toolbar-btn sidebar-expand-btn" title="展开侧栏" aria-label="展开侧栏" onClick={onOpenSidebar}><PanelLeftOpen size={16} /></button>}
        <div ref={toolbarGroupRef} className={`toolbar-group ${toolbarOverflow ? 'has-overflow' : ''} ${toolbarShifted ? 'is-shifted' : ''}`} role="group" aria-label="排版工具">
          {toolbar.map(({ label, icon: Icon, action }, index) => (
            <span className="toolbar-wrapper" key={label}>
              {(index === 3 || index === 6 || index === 9) && <span className="toolbar-divider" />}
              <button type="button" className="toolbar-btn" title={label} aria-label={label} onClick={action}><Icon size={16} /></button>
            </span>
          ))}
        </div>
        {toolbarOverflow && <button type="button" className="toolbar-btn toolbar-scroll-next" title={toolbarShifted ? '返回前面的排版工具' : '查看更多排版工具'} aria-label={toolbarShifted ? '向左返回前面的排版工具' : '向右查看更多排版工具'} onClick={toggleToolbarPage}>{toolbarShifted ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button>}
        <div className="toolbar-spacer" />
        <button type="button" className={`sync-status-button ${localError || externalChange || hasConflict || syncError ? 'unsaved' : ''} ${idleSaveStatus ? 'is-idle' : ''}`} title="打开数据与同步" onClick={onOpenConflicts}><Database size={15} /><span className="sync-status-label">{saveStatus}</span>{syncIssueCount > 0 && <span className="sync-issue-badge" aria-label={`${syncIssueCount} 项需要处理`}>{syncIssueCount}</span>}</button>
        {hasConflict && <button type="button" className="toolbar-btn recovery-btn" onClick={onOpenConflicts}>处理冲突</button>}
        {syncError && !hasConflict && <button type="button" className="toolbar-btn recovery-btn" onClick={onOpenConflicts}>查看同步问题</button>}
        {(localError || externalChange) && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor) return
          void onSaveCopy({ title: titleWithSuffix(titleRef.current, '（恢复副本）'), doc: editor.getJSON() as RichText, plainText: editor.getText({ blockSeparator: '\n' }) })
        }}>另存为新便签</button>}
        {(localError || externalChange) && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor || !navigator.clipboard?.writeText) { toast.error('无法自动复制，请手动复制标题和正文'); return }
          const draft = [titleRef.current, editor.getText({ blockSeparator: '\n' })].filter(Boolean).join('\n\n')
          void navigator.clipboard.writeText(draft).then(() => toast.success('草稿文本已复制')).catch(() => toast.error('复制失败，请手动复制标题和正文'))
        }}>复制草稿文本</button>}
        {externalChange && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor || !confirm('加载另一窗口的新版本？当前编辑器中尚未保存的内容会被替换，建议先另存副本。')) return
          editor.commands.setContent(note.doc, { emitUpdate: false })
          titleRef.current = note.title
          setTitle(note.title)
          setWordCount(note.plainText.length)
          expectedRev.current = note.localRev
          setExternalChange(false)
          onDiscardError()
        }}>加载新版本</button>}
        <details ref={folderMenuRef} className="toolbar-folder-menu" open={folderMenuOpen} onToggle={event => setFolderMenuOpen(event.currentTarget.open)} onKeyDown={handleFolderMenuKeyDown}><summary className="toolbar-btn" title="移动到文件夹" aria-label="移动当前便签到文件夹" aria-haspopup="menu" aria-expanded={folderMenuOpen}><FolderInput size={16} /></summary><div className="toolbar-folder-popover" role="menu" aria-label="选择目标文件夹"><p>移动到文件夹</p><button type="button" role="menuitemradio" aria-checked={note.folderId === null} className={note.folderId === null ? 'active' : ''} onClick={() => moveToFolder(null)}><span>未分类</span>{note.folderId === null && <Check size={14} />}</button>{folders.map(folder => <button type="button" role="menuitemradio" aria-checked={note.folderId === folder.id} className={note.folderId === folder.id ? 'active' : ''} key={folder.id} onClick={() => moveToFolder(folder.id)}><span>{folder.name}</span>{note.folderId === folder.id && <Check size={14} />}</button>)}</div></details>
        <span className="word-count">{wordCount} 字</span>
        <button type="button" className="toolbar-btn editor-theme-toggle" aria-label="切换主题" title="切换主题" onClick={onToggleTheme}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <button type="button" className="toolbar-btn fullscreen-btn" title={fullscreen ? '退出全屏' : '全屏编辑'} onClick={() => setFullscreen(!fullscreen)}>
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>}
      <div className="editor-body" onFocusCapture={() => setMobileEditing(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMobileEditing(false) }}>
        {isMobile && (!mobileEditing || hasSaveIssue) && <div className={`mobile-note-meta ${hasSaveIssue ? 'has-issue' : ''}`}>
          <button type="button" className="mobile-sync-status" onClick={onOpenConflicts} aria-label={`数据与同步：${saveStatus}`}><Database size={14} /><span>{saveStatus}</span>{syncIssueCount > 0 && <span> · {syncIssueCount} 项需处理</span>}</button>
          <span>{wordCount} 字</span>
        </div>}
        <input ref={titleInputRef} className="editor-title" aria-label="便签标题" placeholder="便签标题" title={`标题最多 ${MAX_TITLE_LENGTH} 个字符`} maxLength={MAX_TITLE_LENGTH} value={title} disabled={Boolean(hasRecoverableDraft)}
          onChange={event => {
            const next = event.target.value
            titleRef.current = next
            setTitle(next)
            if (editor) enqueue(editor.getJSON() as RichText, editor.getText({ blockSeparator: '\n' }), next)
          }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); editor?.commands.focus('start') } }}
        />
        <EditorContent editor={editor} className="editor-content-shell" />
      </div>
      {isMobile && <div className="mobile-editor-tools">
        {fontPanelOpen && <div className="mobile-font-panel" role="group" aria-label="字体设置" id="mobile-font-panel">
          {toolbar.slice(3, 6).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={22} /><span>{label}</span></button>)}
          {toolbar.slice(0, 3).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={22} /><span>{label}</span></button>)}
        </div>}
        <div className="mobile-bottom-toolbar" role="toolbar" aria-label="常用排版" onKeyDown={handleToolbarKeyDown}>
          <button type="button" className={fontPanelOpen ? 'active' : ''} aria-label="字体" aria-expanded={fontPanelOpen} aria-controls="mobile-font-panel" onPointerDown={event => event.preventDefault()} onClick={() => setFontPanelOpen(current => !current)}><Type size={24} /></button>
          {[toolbar[7], toolbar[6], toolbar[8]].map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={24} /></button>)}
          <button type="button" aria-label="收起键盘和字体面板" onClick={() => { editor?.commands.blur(); titleInputRef.current?.blur(); setMobileEditing(false); setFontPanelOpen(false) }}><ChevronDown size={24} /></button>
        </div>
      </div>}
      {isMobile && <dialog ref={mobileMenuRef} className="mobile-action-sheet" aria-label={mobileMenu === 'folders' ? '移动到文件夹' : mobileMenu === 'export' ? '导出便签' : '更多便签操作'} onCancel={() => setMobileMenu(null)}>
        <div className="mobile-sheet-heading"><h2>{mobileMenu === 'folders' ? '移动到文件夹' : mobileMenu === 'export' ? '导出便签' : '更多功能'}</h2><button type="button" aria-label="关闭操作菜单" onClick={() => setMobileMenu(null)}><X size={22} /></button></div>
        {mobileMenu === 'export' ? <div className="mobile-sheet-items">
          <button type="button" onClick={() => exportNote('txt')}><FileText size={20} /><span>导出 TXT</span></button>
          <button type="button" onClick={() => exportNote('md')}><FileText size={20} /><span>导出 Markdown</span></button>
        </div> : mobileMenu === 'folders' ? <div className="mobile-sheet-items">
          {[{ id: null, name: '未分类' }, ...folders].map(folder => <button type="button" key={folder.id ?? 'none'} aria-pressed={note.folderId === folder.id} onClick={() => { onMoveFolder(folder.id); setMobileMenu(null) }}><FolderInput size={20} /><span>{folder.name}</span>{note.folderId === folder.id && <Check size={18} />}</button>)}
        </div> : <div className="mobile-sheet-items">
          <button type="button" onClick={() => { onPin?.(); setMobileMenu(null) }}><Pin size={20} /><span>{note.isPinned ? '取消置顶' : '置顶便签'}</span></button>
          <button type="button" onClick={() => setMobileMenu('folders')}><FolderInput size={20} /><span>移动便签</span><ChevronRight size={18} /></button>
          <button type="button" onClick={() => setMobileMenu('export')}><Download size={20} /><span>导出便签</span><ChevronRight size={18} /></button>
          <button type="button" onClick={() => { setMobileMenu(null); onOpenConflicts() }}><Database size={20} /><span>数据与同步</span></button>
          <button type="button" onClick={onToggleTheme}>{theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}<span>切换主题</span></button>
          <button type="button" onClick={() => { setFullscreen(current => !current); setMobileMenu(null) }}><Maximize2 size={20} /><span>{fullscreen ? '退出全屏' : '全屏编辑'}</span></button>
          <button type="button" className="danger" onClick={() => { setMobileMenu(null); onDelete?.() }}><Trash2 size={20} /><span>移入回收站</span></button>
        </div>}
      </dialog>}
    </div>
  )
}

export function NoteEditor(props: Props) {
  if (!props.note) return <div className="editor-empty"><div className="editor-empty-content"><p>选择或创建一个便签开始编辑</p></div></div>
  return <EditorBody key={props.note.id} {...props} note={props.note} />
}
