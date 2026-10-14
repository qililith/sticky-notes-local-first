import { afterEach, expect, it, vi } from 'vitest'
import { db, runWithDatabaseRecovery } from '../src/data/db'

afterEach(async () => {
  vi.restoreAllMocks()
  localStorage.clear()
  if (!db.isOpen()) await db.open()
})

it('reopens the database and retries a save that never returns', async () => {
  const operation = vi.fn<() => Promise<string>>()
    .mockImplementationOnce(() => new Promise(() => undefined))
    .mockResolvedValueOnce('saved')

  await expect(runWithDatabaseRecovery(operation, 20)).resolves.toBe('saved')
  expect(operation).toHaveBeenCalledTimes(2)
  expect(localStorage.getItem('sticky-notes-storage-diagnostics')).toContain('save-retry-ok')
})

it('returns a recoverable error instead of leaving a save pending forever', async () => {
  const operation = vi.fn<() => Promise<string>>(() => new Promise(() => undefined))
  const startedAt = performance.now()

  await expect(runWithDatabaseRecovery(operation, 20)).rejects.toThrow('内容已放入恢复草稿')
  expect(performance.now() - startedAt).toBeLessThan(500)
  expect(operation).toHaveBeenCalledTimes(2)
})
