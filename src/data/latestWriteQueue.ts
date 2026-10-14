/** Drain a pending write slot, allowing callers to replace stale queued values. */
export async function drainLatestWrite<T>(takeNext: () => T | null, write: (value: T) => Promise<void>): Promise<void> {
  while (true) {
    const next = takeNext()
    if (next === null) return
    await write(next)
  }
}
