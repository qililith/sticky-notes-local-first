import { expect, it } from 'vitest'
import { makeNoteExport } from '../src/data/noteExport'
import type { RichText } from '../src/data/types'

const paragraph = (text: string): RichText => ({ type: 'paragraph', content: [{ type: 'text', text }] })

it('exports Chinese headings, ordered numbering and nested completed tasks', () => {
  const doc: RichText = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '计划' }] },
    { type: 'orderedList', attrs: { start: 3 }, content: [
      { type: 'listItem', content: [paragraph('第三项'), { type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('已完成')] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph('未完成')] }
      ] }] },
      { type: 'listItem', content: [paragraph('第四项')] }
    ] }
  ] }
  const md = makeNoteExport({ title: '中文便签', doc }, 'md')
  expect(md.filename).toBe('中文便签.md')
  expect(md.content).toContain('# 中文便签\n\n## 计划')
  expect(md.content).toContain('3. 第三项\n   \n   - [x] 已完成\n   - [ ] 未完成\n4. 第四项')
  const txt = makeNoteExport({ title: '中文便签', doc }, 'txt')
  expect(txt.content).toContain('中文便签\n\n计划')
  expect(txt.content).toContain('- [x] 已完成')
  expect(txt.content).not.toContain('## 计划')
})

it('preserves literal markup, whitespace, hard breaks and supported marks', () => {
  const doc: RichText = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: ' 中文 ', marks: [{ type: 'bold' }, { type: 'italic' }] },
    { type: 'text', text: '<script>&amp; [链接]*' },
    { type: 'hardBreak' },
    { type: 'text', text: '高亮', marks: [{ type: 'highlight' }] }
  ] }, paragraph(''), paragraph('尾段')] }
  const md = makeNoteExport({ title: '#题目', doc }, 'md').content
  expect(md).toContain('# \\#题目')
  expect(md).toContain(' ***中文*** ')
  expect(md).toContain('\\<script\\>&amp;amp; \\[链接\\]\\*  \n<mark>高亮</mark>')
  expect(md).toContain('\n\n\n\n尾段')
  expect(makeNoteExport({ title: '#题目', doc }, 'txt').content).toContain(' 中文 <script>&amp; [链接]*\n高亮')
})

it('does not prematurely close code fences containing backticks', () => {
  const doc: RichText = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'a`b', marks: [{ type: 'code' }] }] },
    { type: 'codeBlock', content: [{ type: 'text', text: '```\n代码' }] }
  ] }
  expect(makeNoteExport({ title: '代码', doc }, 'md').content).toContain('`` a`b ``\n\n````\n```\n代码\n````')
})

it.each([
  ['', '无标题.txt'],
  ['会议/安排:今天?', '会议_安排_今天_.txt'],
  ['CON', '便签-CON.txt']
])('creates a usable filename for %s without changing exported title', (title, filename) => {
  const exported = makeNoteExport({ title, doc: { type: 'doc', content: [paragraph('正文')] } }, 'txt')
  expect(exported.filename).toBe(filename)
  expect(exported.content.startsWith(`${title || '无标题'}\n\n`)).toBe(true)
})

it('rejects an unsupported block rather than silently dropping its content', () => {
  expect(() => makeNoteExport({ title: '未来便签', doc: { type: 'doc', content: [{ type: 'unknown', text: '必须保留' }] } }, 'md')).toThrow('无法导出')
})

it('encodes link delimiters and does not produce executable Markdown links', () => {
  const doc: RichText = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: '网站', marks: [{ type: 'link', attrs: { href: 'https://example.com/a(b c)' } }] },
    { type: 'text', text: '不安全链接', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }
  ] }] }
  const content = makeNoteExport({ title: '链接', doc }, 'md').content
  expect(content).toContain('[网站](https://example.com/a%28b%20c%29)不安全链接')
  expect(content).not.toContain('javascript:')
})
