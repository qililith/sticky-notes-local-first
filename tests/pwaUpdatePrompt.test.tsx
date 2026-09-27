import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const update = vi.hoisted(() => vi.fn(async () => undefined))
const error = vi.hoisted(() => vi.fn())
const registered = vi.hoisted(() => ({ onNeedReload: undefined as (() => void) | undefined }))
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: { onNeedReload?: () => void } = {}) => {
    registered.onNeedReload = options.onNeedReload
    return { needRefresh: [true], updateServiceWorker: update }
  }
}))
vi.mock('sonner', () => ({ toast: { error } }))

import { PwaUpdatePrompt } from '../src/components/PwaUpdatePrompt'
import { beginEditorWrite, setUnresolvedEditorDraft } from '../src/data/saveGuard'

afterEach(() => { cleanup(); setUnresolvedEditorDraft(false); update.mockClear(); error.mockClear(); registered.onNeedReload = undefined })

describe('PWA update prompt', () => {
  it('waits for pending editor writes before requesting a reload', () => {
    const endWrite = beginEditorWrite()
    try {
      render(<PwaUpdatePrompt />)
      const button = screen.getByRole('button', { name: '更新并刷新' })
      fireEvent.click(button)
      expect(update).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalled()
      endWrite()
      fireEvent.click(button)
      expect(update).toHaveBeenCalledWith(true)
    } finally { endWrite() }
  })

  it('does not reload while a failed local draft remains unresolved', () => {
    render(<PwaUpdatePrompt />)
    const button = screen.getByRole('button', { name: '更新并刷新' })
    setUnresolvedEditorDraft(true)
    fireEvent.click(button)
    expect(update).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('便签有未保存草稿，请先另存或复制草稿文本')
    setUnresolvedEditorDraft(false)
    fireEvent.click(button)
    expect(update).toHaveBeenCalledWith(true)
  })

  it('rechecks draft safety when another tab activates the new service worker', () => {
    render(<PwaUpdatePrompt />)
    setUnresolvedEditorDraft(true)
    expect(registered.onNeedReload).toBeTypeOf('function')
    act(() => registered.onNeedReload!())
    expect(error).toHaveBeenCalledWith('便签有未保存草稿，请先另存或复制草稿文本')
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '更新并刷新' })).toBeTruthy()
  })

  it('rechecks writes that started after the update button was clicked', () => {
    render(<PwaUpdatePrompt />)
    fireEvent.click(screen.getByRole('button', { name: '更新并刷新' }))
    const finish = beginEditorWrite()
    try {
      expect(registered.onNeedReload).toBeTypeOf('function')
      act(() => registered.onNeedReload!())
      expect(error).toHaveBeenCalledWith('本地仍在保存，请稍等再更新')
    } finally { finish() }
  })
})
