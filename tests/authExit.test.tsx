import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ callback: null as null | ((event: string, session: { user?: { id: string; email: string } } | null) => void) }))
type AuthResult = { data: { user: { id: string; email: string } | null }; error: { name: string; status?: number } | null }
const getUser = vi.hoisted(() => vi.fn<() => Promise<AuthResult>>())
const remembered = vi.hoisted(() => ({ account: null as { id: string; email: string } | null }))

vi.mock('../src/auth', () => ({
  accountKey: 'sticky-notes-last-account',
  demoMode: false,
  forgetAccount: () => { remembered.account = null },
  getRememberedAccount: () => remembered.account,
  rememberAccount: (user: { id: string; email: string }) => { remembered.account = user },
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
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  getUser.mockReset()
  getUser.mockImplementation(async () => ({ data: { user: { id: 'account-a', email: 'a@example.test' } }, error: null }))
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
afterEach(() => { cleanup(); authState.callback = null; setUnresolvedEditorDraft(false); Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }) })

function emit(event: string, session: { user?: { id: string; email: string } } | null = null) {
  if (!authState.callback) throw new Error('Auth listener not ready')
  authState.callback(event, session)
}

it('does not reopen a locally locked account from a leftover SDK session', async () => {
  remembered.account = null
  render(<App />)
  await screen.findByRole('heading', { name: '欢迎使用' })
  act(() => emit('SIGNED_IN', { user: { id: 'account-a', email: 'a@example.test' } }))
  act(() => window.dispatchEvent(new Event('focus')))
  expect(getUser).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
})

it('locks on another tab removing the account hint, even without an SDK sign-out event', async () => {
  let finishVerification!: (result: AuthResult) => void
  getUser.mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve }))
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => {
    remembered.account = null
    window.dispatchEvent(new StorageEvent('storage', { key: 'sticky-notes-last-account', newValue: null }))
  })
  await screen.findByRole('heading', { name: '欢迎使用' })
  await act(async () => finishVerification({ data: { user: { id: 'account-a', email: 'a@example.test' } }, error: null }))
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
})

it('opens remembered local data without waiting for a slow online auth service', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  getUser.mockImplementationOnce(() => new Promise(() => {}))
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  expect(screen.queryByText('加载中…')).toBeNull()
})

it.each([
  { name: 'AuthRetryableFetchError', status: 0 },
  { name: 'AuthApiError', status: 503 },
  { name: 'AuthApiError', status: 429 }
])('retains the remembered workspace on transient auth failure $status', async error => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  getUser.mockResolvedValueOnce({ data: { user: null }, error })
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
})

it('continues listening for sign-out when the remembered workspace starts offline', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => emit('SIGNED_OUT'))
  await screen.findByRole('heading', { name: '欢迎使用' })
})

it('rechecks an offline-started account on reconnection and locks a missing session', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400 } })
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  expect(getUser).not.toHaveBeenCalled()
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  act(() => window.dispatchEvent(new Event('online')))
  await screen.findByRole('heading', { name: '欢迎使用' })
  expect(remembered.account).toBeNull()
})

it('retries a temporary auth failure on focus without reloading local data', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } })
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', status: 403 } })
  act(() => window.dispatchEvent(new Event('focus')))
  await screen.findByRole('heading', { name: '欢迎使用' })
  expect(getUser).toHaveBeenCalledTimes(2)
})

it('does not automatically reopen a signed-out account on focus or reconnection', async () => {
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  act(() => emit('SIGNED_OUT'))
  await screen.findByRole('heading', { name: '欢迎使用' })
  act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) })
  expect(getUser).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
})

it('preserves a pending editor when background auth explicitly rejects the account', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  let finishVerification!: (result: AuthResult) => void
  getUser.mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve }))
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  const finishWrite = beginEditorWrite()
  try {
    await act(async () => finishVerification({ data: { user: null }, error: { name: 'AuthApiError', status: 403 } }))
    expect(screen.getByRole('alert').textContent).toContain('请先处理草稿')
    expect(screen.queryByRole('heading', { name: '欢迎使用' })).toBeNull()
  } finally { act(() => finishWrite()) }
  await screen.findByRole('heading', { name: '欢迎使用' })
  expect(remembered.account).toBeNull()
})

it('does not let a different background-verified account replace a pending editor', async () => {
  remembered.account = { id: 'account-a', email: 'a@example.test' }
  let finishVerification!: (result: AuthResult) => void
  getUser.mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve }))
  render(<App />)
  await screen.findByRole('button', { name: '退出登录' })
  const finishWrite = beginEditorWrite()
  try {
    await act(async () => finishVerification({ data: { user: { id: 'account-b', email: 'b@example.test' } }, error: null }))
    expect(screen.getByRole('alert').textContent).toContain('请先处理草稿')
  } finally { act(() => finishWrite()) }
  await screen.findByRole('heading', { name: '欢迎使用' })
})

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
