import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { createEditorExtensions } from '../data/editorSchema'
import { Bold, CheckSquare, Heading1, Heading2, Heading3, Highlighter, Italic, List, ListOrdered, Maximize2, Minimize2, Plus, Redo2, Undo2 } from 'lucide-react'
import type { Note, RichText } from '../data/types'
import { MAX_TITLE_LENGTH, titleWithSuffix } from '../data/limits'
import { beginEditorWrite } from '../data/saveGuard'

type Props = {
  note: Note | null
  onEdit: (id: string, change: { title: string; doc: RichText; plainText: string }, expectedRev: number) => Promise<Note>
  onSaveCopy: (change: { title: string; doc: RichText; plainText: string }) => Promise<void>
  onDiscardError: () => void
  onCreate: () => void
  onOpenConflicts: () => void
  localError: string | null
  syncError: string | null
  pendingCount: number
  hasConflict: boolean
  isMobile: boolean
}

function EditorBody({ note, onEdit, onSaveCopy, onDiscardError, onCreate, onOpenConflicts, localError, syncError, pendingCount, hasConflict, isMobile }: Props & { note: Note }) {
  const [title, setTitle] = useState(note.title)
  const titleRef = useRef(note.title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [wordCount, setWordCount] = useState(note.plainText.length)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingWrites = useRef(0)
  const expectedRev = useRef(note.localRev)
  const [saving, setSaving] = useState(false)
  const [externalChange, setExternalChange] = useState(false)

  const enqueue = useCallback((doc: RichText, plainText: string, nextTitle: string) => {
    const capturedId = note.id
    pendingWrites.current += 1
    const endWrite = beginEditorWrite()
    setSaving(true)
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      const saved = await onEdit(capturedId, { doc, plainText, title: nextTitle }, expectedRev.current)
      expectedRev.current = saved.localRev
    }).catch(() => undefined).finally(() => {
      pendingWrites.current -= 1
      endWrite()
      if (pendingWrites.current === 0) setSaving(false)
    })
  }, [note.id, onEdit])

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
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

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

  return (
    <div className={`editor-container ${fullscreen ? 'fullscreen' : ''}`}>
      <div className="editor-toolbar">
        <div className="toolbar-group">
          {toolbar.map(({ label, icon: Icon, action }, index) => (
            <span className="toolbar-wrapper" key={label}>
              {(index === 3 || index === 6 || index === 9) && <span className="toolbar-divider" />}
              <button type="button" className="toolbar-btn" title={label} aria-label={label} onClick={action}><Icon size={16} /></button>
            </span>
          ))}
        </div>
        <div className="toolbar-spacer" />
        <span className={`save-status ${localError || externalChange || hasConflict || syncError ? 'unsaved' : ''}`}>{localError ? '本地未保存' : externalChange ? '其它窗口已更新' : saving ? '本地保存中…' : hasConflict ? '本地已保存 · 同步冲突' : syncError ? '本地已保存 · 同步失败' : pendingCount ? `本地已保存 · 待同步 ${pendingCount}` : '本地已保存'}</span>
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
        <span className="word-count">{wordCount} 字</span>
        <button type="button" className="toolbar-btn fullscreen-btn" title={fullscreen ? '退出全屏' : '全屏编辑'} onClick={() => setFullscreen(!fullscreen)}>
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="editor-body">
        <input ref={titleInputRef} className="editor-title" aria-label="便签标题" placeholder="便签标题" title={`标题最多 ${MAX_TITLE_LENGTH} 个字符`} maxLength={MAX_TITLE_LENGTH} value={title}
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
      {isMobile && <button type="button" className="fab-btn" title="新建便签" onClick={onCreate}><Plus size={24} /></button>}
    </div>
  )
}

export function NoteEditor(props: Props) {
  if (!props.note) return <div className="editor-empty"><div className="editor-empty-content"><p>选择或创建一个便签开始编辑</p></div></div>
  return <EditorBody key={props.note.id} {...props} note={props.note} />
}
