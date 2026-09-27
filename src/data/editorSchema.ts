import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'

// One format definition for editing and backup validation.
export const createEditorExtensions = () => [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true })
]

let schema: ReturnType<typeof getSchema> | undefined
export function checkDocument(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'doc') throw new Error('正文格式不正确')
  schema ??= getSchema(createEditorExtensions())
  // fromJSON rejects unknown nodes/marks; check also verifies child structure.
  schema.nodeFromJSON(value).check()
}
