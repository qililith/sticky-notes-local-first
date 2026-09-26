import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ callback: null as null | ((event: string, session: { user?: { id: string; email: string } } | null) => void) }))
const getUser = vi.hoisted(() => vi.fn(async () => ({ data: { user: { id: 'account-a', email: 'a@example.test' } }, error: null })))

vi.mock('../src/auth', () => ({
  demoMode: false,
  forgetAccount: vi.fn(),
  getRememberedAccount: () => null,
  rememberAccount: vi.fn(),
  supabase: { auth: {
    getUser,
    onAuthStateChange: (callback: typeof authState.callback) => {
      authState.callback = callback
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    },
    signOut: async () => ({ error: null })
  } }
}))
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: (_query: unknown, _deps: unknown, fallback: unknown) => fallback }))
vi.mock('../src/sync/engine', () => ({ startSync: () => undefined }))
vi.mock('../src/components/PwaUpdatePrompt', () => ({ PwaUpdatePrompt: () => null }))

import { App } from '../src/App'
import { accountClearedEventKey } from '../src/data/accountSyncGate'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'

beforeEach(() => {
  getUser.mockReset()
  getUser.mockImplementation(async () => ({ data: { user: { id: 'account-a', email: 'a@example.test' } }, error: null }))
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
afterEach(() => { cleanup(); authState.callback = null; setUnresolvedEditorDraft(false) })

function emit(event: string, session: { user?: { id: string; email: string } } | null = null) {
  if (!authState.callback) throw new Error('Auth listener not ready')
  authState.callback(event, session)
}

it('locks the local workspace immediately when sign-out has no unsaved write', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => emit('SIGNED_OUT'))
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('locks another tab after this account is cleared elsewhere', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: accountClearedEventKey('account-a'), newValue: 'cleared' })))
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('keeps the current editor mounted until an in-flight write settles', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  const finish = beginEditorWrite()
  try {
    act(() => emit('SIGNED_OUT'))
    expect(screen.getByRole('alert').textContent).toContain('当前账号已退出或切换')
    expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
  } finally {
    act(() => finish())
  }
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('keeps a failed draft available after sign-out until it is resolved', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => setUnresolvedEditorDraft(true))
  act(() => emit('SIGNED_OUT'))
  expect(screen.getByRole('alert').textContent).toContain('当前账号已退出或切换')
  expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
  act(() => setUnresolvedEditorDraft(false))
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('does not lock when an in-flight write fails after sign-out', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  const finish = beginEditorWrite()
  act(() => emit('SIGNED_OUT'))
  act(() => setUnresolvedEditorDraft(true))
  act(() => finish())
  expect(screen.getByRole('alert').textContent).toContain('当前账号已退出或切换')
  expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
  act(() => setUnresolvedEditorDraft(false))
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('does not restore a stale user after a newer sign-out event', async () => {
  let finishGetUser: ((value: { data: { user: { id: string; email: string } }; error: null }) => void) | undefined
  getUser.mockImplementationOnce(() => new Promise(resolve => { finishGetUser = resolve }))
  render(<App />)
  await waitFor(() => expect(authState.callback).not.toBeNull())
  act(() => emit('SIGNED_OUT'))
  await screen.findByRole('heading', { name: '欢迎使用' })
  await act(async () => { finishGetUser?.({ data: { user: { id: 'account-a', email: 'a@example.test' } }, error: null }) })
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
})

it('does not replace an in-flight editor with a different account', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  const finish = beginEditorWrite()
  try {
    act(() => emit('SIGNED_IN', { user: { id: 'account-b', email: 'b@example.test' } }))
    expect(screen.getByRole('alert').textContent).toContain('当前账号已退出或切换')
    expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
  } finally {
    act(() => finish())
  }
  await screen.findByRole('heading', { name: '欢迎使用' })
})

