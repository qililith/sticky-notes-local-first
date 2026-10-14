const syncNeededEvent = 'sticky-notes:sync-needed'

type SyncNeededDetail = { ownerId: string }

export function notifySyncNeeded(ownerId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SyncNeededDetail>(syncNeededEvent, { detail: { ownerId } }))
}

export function subscribeSyncNeeded(listener: (ownerId: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handle = (event: Event) => {
    const ownerId = (event as CustomEvent<SyncNeededDetail>).detail?.ownerId
    if (typeof ownerId === 'string') listener(ownerId)
  }
  window.addEventListener(syncNeededEvent, handle)
  return () => window.removeEventListener(syncNeededEvent, handle)
}
