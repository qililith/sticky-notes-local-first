import { expect, it } from 'vitest'
import { drainLatestWrite } from '../src/data/latestWriteQueue'

it('coalesces stale snapshots while a local write is in progress', async () => {
  let pending: number | null = 1
  let startFirst!: () => void
  let finishFirst!: () => void
  const firstStarted = new Promise<void>(resolve => { startFirst = resolve })
  const firstGate = new Promise<void>(resolve => { finishFirst = resolve })
  const written: number[] = []

  const draining = drainLatestWrite(() => {
    const next = pending
    pending = null
    return next
  }, async value => {
    written.push(value)
    if (value === 1) {
      startFirst()
      await firstGate
    }
  })

  await firstStarted
  pending = 2
  pending = 3
  finishFirst()
  await draining

  expect(written).toEqual([1, 3])
})
