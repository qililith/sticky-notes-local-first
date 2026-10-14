import type { RichText } from './types'

export type RecoveryDraft = {
  token: string
  title: string
  doc: RichText
  plainText: string
}

const key = (ownerId: string, noteId: string) => `sticky-notes-recovery:${ownerId}:${noteId}`

export function readRecoveryDraft(ownerId: string, noteId: string): RecoveryDraft | null {
  try {
    const raw = localStorage.getItem(key(ownerId, noteId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const draft = value as RecoveryDraft
    return typeof draft.token === 'string' && typeof draft.title === 'string'
      && typeof draft.plainText === 'string' && draft.doc?.type === 'doc' ? draft : null
  } catch { return null }
}

export function writeRecoveryDraft(ownerId: string, noteId: string, change: Omit<RecoveryDraft, 'token'>): string | null {
  try {
    const token = crypto.randomUUID()
    localStorage.setItem(key(ownerId, noteId), JSON.stringify({ ...change, token }))
    return token
  } catch { return null }
}

export function clearRecoveryDraft(ownerId: string, noteId: string, token: string): void {
  if (readRecoveryDraft(ownerId, noteId)?.token !== token) return
  try { localStorage.removeItem(key(ownerId, noteId)) } catch { /* Keep the local copy. */ }
}

export function clearAccountRecoveryDrafts(ownerId: string): void {
  try {
    const prefix = `sticky-notes-recovery:${ownerId}:`
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const item = localStorage.key(index)
      if (item?.startsWith(prefix)) localStorage.removeItem(item)
    }
  } catch { /* The browser may block local storage. */ }
}
