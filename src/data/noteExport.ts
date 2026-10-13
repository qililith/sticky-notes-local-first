import type { RichText } from './types'
import { getSchema } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import { createEditorExtensions } from './editorSchema'

export type NoteExportFormat = 'txt' | 'md' | 'html'
type ExportContent = { title: string; doc: RichText }
let htmlSchema: ReturnType<typeof getSchema> | undefined

function escapeMarkdown(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]<>#+.!|~()-]/g, '\\$&')
}

function wrapMark(text: string, marker: string): string {
  return text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before: string, body: string, after: string) => body ? `${before}${marker}${body}${marker}${after}` : text)
}

function codeFence(text: string, minimum: number): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(Math.max(minimum, longest + 1))
}

function inline(node: RichText, format: NoteExportFormat): string {
  if (node.type === 'hardBreak') return format === 'md' ? '  \n' : '\n'
  if (node.type !== 'text') return (node.content ?? []).map(child => inline(child, format)).join('')
  const raw = node.text ?? ''
  if (format === 'txt') return raw
  let text = escapeMarkdown(raw)
  if (node.marks?.some(mark => mark.type === 'code')) {
    const fence = codeFence(raw, 1)
    text = `${fence} ${raw} ${fence}`
  }
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') text = wrapMark(text, '**')
    if (mark.type === 'italic') text = wrapMark(text, '*')
    if (mark.type === 'strike') text = wrapMark(text, '~~')
    if (mark.type === 'highlight') text = `<mark>${text}</mark>`
    if (mark.type === 'underline') text = `<u>${text}</u>`
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^(https?:|mailto:)/i.test(mark.attrs.href)) {
      const href = mark.attrs.href.replace(/[\s<>()[\]\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
      text = `[${text}](${href})`
    }
  }
  return text
}

function block(node: RichText, format: NoteExportFormat): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'doc': return children.map(child => block(child, format)).join('\n\n')
    case 'paragraph': return inline(node, format)
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1))
      return `${format === 'md' ? `${'#'.repeat(level)} ` : ''}${inline(node, format)}`
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(node.attrs?.start) || 1
      return children.map((item, index) => {
        const marker = node.type === 'orderedList' ? `${start + index}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- '
        const body = (item.content ?? []).map(child => block(child, format)).join('\n\n')
        return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`)
      }).join('\n')
    }
    case 'blockquote': return children.map(child => block(child, format)).join('\n\n').split('\n').map(line => `> ${line}`).join('\n')
    case 'codeBlock': {
      const text = inline(node, 'txt')
      if (format === 'txt') return text
      const fence = codeFence(text, 3)
      return `${fence}\n${text}\n${fence}`
    }
    case 'horizontalRule': return '---'
    default: throw new Error(`无法导出未支持的正文类型：${node.type}`)
  }
}

export function makeNoteExport(note: ExportContent, format: NoteExportFormat): { filename: string; content: string; mimeType: string } {
  const title = note.title.trim() ? note.title : '无标题'
  let basename = Array.from(title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')).slice(0, 80).join('').replace(/[. ]+$/g, '').trim() || '无标题'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) basename = `便签-${basename}`
  if (format === 'html') {
    const schema = htmlSchema ??= getSchema(createEditorExtensions())
    const doc = schema.nodeFromJSON(note.doc)
    doc.check()
    const container = document.createElement('main')
    const heading = document.createElement('h1')
    heading.textContent = title
    container.append(heading, DOMSerializer.fromSchema(schema).serializeFragment(doc.content))
    container.querySelectorAll('input').forEach(input => { input.disabled = true })
    container.querySelectorAll('a').forEach(link => {
      if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href')
    })
    const escapedTitle = document.createElement('span')
    escapedTitle.textContent = title
    return {
      filename: `${basename}.html`, mimeType: 'text/html;charset=utf-8',
      content: `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle.innerHTML}</title><style>body{max-width:760px;margin:32px auto;padding:0 24px;font:16px/1.7 system-ui;color:#292929;overflow-wrap:anywhere}h1,h2,h3{line-height:1.35}mark{background:#fff2b3;color:#343025;padding:2px 4px;border-radius:3px}pre{overflow:auto;padding:16px;background:#f4f4f1}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #ccc;color:#666}ul[data-type="taskList"]{list-style:none;padding-left:0}li[data-type="taskItem"]{display:flex;gap:8px;align-items:baseline}li[data-type="taskItem"]>div{flex:1}li[data-type="taskItem"]>div>p{margin:0}</style></head><body>${container.outerHTML}</body></html>\n`
    }
  }
  const heading = format === 'md' ? `# ${escapeMarkdown(title)}` : title
  return {
    filename: `${basename}.${format}`,
    content: `${heading}\n\n${block(note.doc, format)}\n`,
    mimeType: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
  }
}

export function downloadNoteExport(note: ExportContent, format: NoteExportFormat): void {
  const exported = makeNoteExport(note, format)
  const url = URL.createObjectURL(new Blob([exported.content], { type: exported.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = exported.filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
