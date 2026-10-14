import { afterEach, expect, it, vi } from 'vitest'
import { clearAccountRecoveryDrafts, clearRecoveryDraft, listAccountRecoveryDrafts, readRecoveryDraft, RECOVERY_DRAFT_TTL_MS, writeRecoveryDraft } from '../src/data/recoveryDraft'
import { emptyDocument } from '../src/data/types'

afterEach(() => { localStorage.clear(); vi.useRealTimers() })

it('keeps the newest browser-close draft until that exact write is saved', () => {
  const original = writeRecoveryDraft('account-a', 'note-a', { title: '标题', doc: emptyDocument, plainText: '第一段', baseLocalRev: 3 })!
  const newer = writeRecoveryDraft('account-a', 'note-a', { title: '标题', doc: emptyDocument, plainText: '第二段', baseLocalRev: 4 })!
  clearRecoveryDraft('account-a', 'note-a', original)
  expect(readRecoveryDraft('account-a', 'note-a')?.plainText).toBe('第二段')
  expect(readRecoveryDraft('account-a', 'note-a')?.baseLocalRev).toBe(4)
  expect(readRecoveryDraft('account-b', 'note-a')).toBeNull()
  clearRecoveryDraft('account-a', 'note-a', newer)
  expect(readRecoveryDraft('account-a', 'note-a')).toBeNull()
})

it('keeps legacy drafts recoverable without treating an invalid revision as safe', () => {
  localStorage.setItem('sticky-notes-recovery:account-a:note-a', JSON.stringify({
    token: 'legacy', title: '旧草稿', doc: emptyDocument, plainText: '旧内容', baseLocalRev: -1,
    savedAt: new Date().toISOString()
  }))
  expect(readRecoveryDraft('account-a', 'note-a')).toMatchObject({ plainText: '旧内容', baseLocalRev: undefined })
})

it('clears only the selected account after an explicit device reset', () => {
  writeRecoveryDraft('account-a', 'note-a', { title: 'A', doc: emptyDocument, plainText: 'A' })
  writeRecoveryDraft('account-b', 'note-b', { title: 'B', doc: emptyDocument, plainText: 'B' })
  clearAccountRecoveryDrafts('account-a')
  expect(readRecoveryDraft('account-a', 'note-a')).toBeNull()
  expect(readRecoveryDraft('account-b', 'note-b')?.plainText).toBe('B')
})

it('lists recoverable drafts even when their original note is missing', () => {
  writeRecoveryDraft('account-a', 'missing-note', { title: '丢失的便签', doc: emptyDocument, plainText: '待恢复内容' })
  expect(listAccountRecoveryDrafts('account-a').map(draft => [draft.noteId, draft.plainText])).toEqual([['missing-note', '待恢复内容']])
})

it('expires recovery drafts after the short retention window', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
  writeRecoveryDraft('account-a', 'note-a', { title: '临时内容', doc: emptyDocument, plainText: '临时' })
  vi.setSystemTime(new Date(Date.now() + RECOVERY_DRAFT_TTL_MS + 1))
  expect(readRecoveryDraft('account-a', 'note-a')).toBeNull()
  expect(localStorage.length).toBe(0)
})
