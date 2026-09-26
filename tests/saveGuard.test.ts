import { expect, it } from 'vitest'
import { beginEditorWrite, hasPendingEditorWrites, hasUnresolvedEditorDraft, setUnresolvedEditorDraft } from '../src/data/saveGuard'

it('tracks queued editor writes independently of the editor component', () => {
  const finishA = beginEditorWrite()
  const finishB = beginEditorWrite()
  expect(hasPendingEditorWrites()).toBe(true)
  finishA()
  expect(hasPendingEditorWrites()).toBe(true)
  finishB()
  finishB()
  expect(hasPendingEditorWrites()).toBe(false)
})

it('tracks failed drafts separately from pending writes', () => {
  setUnresolvedEditorDraft(true)
  expect(hasUnresolvedEditorDraft()).toBe(true)
  expect(hasPendingEditorWrites()).toBe(false)
  setUnresolvedEditorDraft(false)
  expect(hasUnresolvedEditorDraft()).toBe(false)
})

