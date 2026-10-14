import type { RichText } from './types'

export const RECOVERY_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export type RecoveryDraft = {
  token: string
  noteId: string
  title: string
  doc: RichText
  plainText: string
  savedAt: string
}

type RecoveryDraftValue = Omit<RecoveryDraft, 'noteId'>
type DraftChange = Pick<RecoveryDraft, 'title' | 'doc' | 'plainText'>

const prefix = (ownerId: string) => `sticky-notes-recovery:${ownerId}:`
const key = (ownerId: string, noteId: string) => `${prefix(ownerId)}${noteId}`

function readStored(raw: string, noteId: string): RecoveryDraft | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const draft = value as RecoveryDraftValue
    if (typeof draft.token !== 'string' || typeof draft.title !== 'string'
      || typeof draft.plainText !== 'string' || draft.doc?.type !== 'doc') return null

    // Give an older draft one short recovery window after upgrading its format.
    const savedAt = typeof draft.savedAt === 'string' && Number.isFinite(Date.parse(draft.savedAt))
      ? draft.savedAt : new Date().toISOString()
    if (Date.now() - Date.parse(savedAt) > RECOVERY_DRAFT_TTL_MS || Date.parse(savedAt) > Date.now() + 5 * 60 * 1000) return null
    return { ...draft, noteId, savedAt }
  } catch { return null }
}

export function readRecoveryDraft(ownerId: string, noteId: string): RecoveryDraft | null {
  try {
    const storageKey = key(ownerId, noteId)
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const draft = readStored(raw, noteId)
    if (!draft) { localStorage.removeItem(storageKey); return null }
    if (!JSON.parse(raw).savedAt) localStorage.setItem(storageKey, JSON.stringify({ ...draft, noteId: undefined }))
    return draft
  } catch { return null }
}

export function listAccountRecoveryDrafts(ownerId: string): RecoveryDraft[] {
  try {
    const draftPrefix = prefix(ownerId)
    const noteIds: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index)
      if (storageKey?.startsWith(draftPrefix)) noteIds.push(storageKey.slice(draftPrefix.length))
    }
    return noteIds.map(noteId => readRecoveryDraft(ownerId, noteId)).filter((draft): draft is RecoveryDraft => draft !== null)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch { return [] }
}

export function cleanupExpiredRecoveryDrafts(ownerId: string): void {
  void listAccountRecoveryDrafts(ownerId)
}

export function writeRecoveryDraft(ownerId: string, noteId: string, change: DraftChange): string | null {
  try {
    const token = crypto.randomUUID()
    const draft: RecoveryDraftValue = { ...change, token, savedAt: new Date().toISOString() }
    localStorage.setItem(key(ownerId, noteId), JSON.stringify(draft))
    return token
  } catch { return null }
}

export function clearRecoveryDraft(ownerId: string, noteId: string, token: string): void {
  if (readRecoveryDraft(ownerId, noteId)?.token !== token) return
  try { localStorage.removeItem(key(ownerId, noteId)) } catch { /* Keep the local copy. */ }
}

export function clearAccountRecoveryDrafts(ownerId: string): void {
  try {
    const draftPrefix = prefix(ownerId)
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const item = localStorage.key(index)
      if (item?.startsWith(draftPrefix)) localStorage.removeItem(item)
    }
  } catch { /* The browser may block local storage. */ }
}
