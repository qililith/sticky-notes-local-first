import { afterEach, expect, it } from 'vitest'
import { clearAccountRecoveryDrafts, clearRecoveryDraft, readRecoveryDraft, writeRecoveryDraft } from '../src/data/recoveryDraft'
import { emptyDocument } from '../src/data/types'

afterEach(() => localStorage.clear())

it('keeps the newest browser-close draft until that exact write is saved', () => {
  const original = writeRecoveryDraft('account-a', 'note-a', { title: '标题', doc: emptyDocument, plainText: '第一段' })!
  const newer = writeRecoveryDraft('account-a', 'note-a', { title: '标题', doc: emptyDocument, plainText: '第二段' })!
  clearRecoveryDraft('account-a', 'note-a', original)
  expect(readRecoveryDraft('account-a', 'note-a')?.plainText).toBe('第二段')
  expect(readRecoveryDraft('account-b', 'note-a')).toBeNull()
  clearRecoveryDraft('account-a', 'note-a', newer)
  expect(readRecoveryDraft('account-a', 'note-a')).toBeNull()
})

it('clears only the selected account after an explicit device reset', () => {
  writeRecoveryDraft('account-a', 'note-a', { title: 'A', doc: emptyDocument, plainText: 'A' })
  writeRecoveryDraft('account-b', 'note-b', { title: 'B', doc: emptyDocument, plainText: 'B' })
  clearAccountRecoveryDrafts('account-a')
  expect(readRecoveryDraft('account-a', 'note-a')).toBeNull()
  expect(readRecoveryDraft('account-b', 'note-b')?.plainText).toBe('B')
})
