let pendingEditorWrites = 0
let unresolvedEditorDraft = false
const listeners = new Set<() => void>()

function notifySafetyChange(): void {
  for (const listener of listeners) listener()
}

export function beginEditorWrite(): () => void {
  pendingEditorWrites += 1
  notifySafetyChange()
  let finished = false
  return () => {
    if (finished) return
    finished = true
    pendingEditorWrites -= 1
    notifySafetyChange()
  }
}

export function hasPendingEditorWrites(): boolean {
  return pendingEditorWrites > 0
}

export function setUnresolvedEditorDraft(value: boolean): void {
  if (unresolvedEditorDraft === value) return
  unresolvedEditorDraft = value
  notifySafetyChange()
}

export function hasUnresolvedEditorDraft(): boolean {
  return unresolvedEditorDraft
}

export function subscribeEditorSafety(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

