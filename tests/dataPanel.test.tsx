import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const syncOnce = vi.hoisted(() => vi.fn())

vi.mock('../src/auth', () => ({ supabase: {} }))
vi.mock('../src/sync/engine', () => ({
  resolveConflict: vi.fn(),
  syncOnce
}))

import { DataPanel } from '../src/components/DataPanel'
import { db } from '../src/data/db'

beforeEach(async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  syncOnce.mockReset()
  syncOnce.mockResolvedValue(true)
  await Promise.all([db.notes.clear(), db.folders.clear(), db.outbox.clear(), db.conflicts.clear(), db.syncMeta.clear(), db.history.clear()])
})

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

it('keeps manual sync available when the browser reports offline', async () => {
  render(<DataPanel ownerId="account-a" note={null} currentFolderId={null} hasUnsavedDraft={false}
    onClose={() => undefined} onLogout={async () => undefined} onCleared={async () => undefined} />)

  expect(await screen.findByText(/浏览器显示可能离线/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: '立即重试同步' }) as HTMLButtonElement
  expect(retry.disabled).toBe(false)
  fireEvent.click(retry)
  await waitFor(() => expect(syncOnce).toHaveBeenCalledWith('account-a'))
})
