import { expect, test } from '@playwright/test'

async function createNamedNote(page: import('@playwright/test').Page, name: string) {
  await page.getByTitle('新建便签').first().click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('')
  await page.getByRole('textbox', { name: '便签标题' }).fill(name)
  await expect(page.locator('.note-item-title').filter({ hasText: name })).toBeVisible()
  await expect(page.locator('.save-status')).toContainText('本地已保存')
}

test('pending local writes block navigation until they finish', async ({ page }) => {
  await page.goto('/')
  await createNamedNote(page, '便签 A')
  await createNamedNote(page, '便签 B')
  await page.locator('.note-item').filter({ hasText: '便签 A' }).click()
  await page.evaluate(async () => {
    const { beginEditorWrite } = await import('/src/data/saveGuard.ts')
    Object.assign(window, { __finishTestWrite: beginEditorWrite() })
  })
  await page.locator('.note-item').filter({ hasText: '便签 B' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('便签 A')
  await expect(page.getByText('本地仍在保存，请稍等再切换')).not.toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('便签 A')
  await page.evaluate(() => {
    const finish = (window as Window & { __finishTestWrite?: () => void }).__finishTestWrite
    finish?.()
  })
  await page.locator('.note-item').filter({ hasText: '便签 B' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('便签 B')
})

test('rapid typing and repeated clicks during new-note creation do not alter the old note', async ({ page }) => {
  await page.goto('/')
  await createNamedNote(page, '旧便签')
  await page.getByTitle('新建便签').first().dblclick()
  await page.getByRole('textbox', { name: '便签标题' }).fill('新便签')
  await expect(page.locator('.note-item-title').filter({ hasText: '新便签' })).toBeVisible()
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').toArray()).map(note => note.title).sort()
  })).toEqual(['新便签', '旧便签'].sort())
})

test('a failed local save retains the draft and blocks leaving until copied', async ({ page }) => {
  await page.goto('/')
  await createNamedNote(page, '便签 A')
  await createNamedNote(page, '便签 B')
  await page.locator('.note-item').filter({ hasText: '便签 A' }).click()
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const table = db.notes as unknown as { put: (...args: unknown[]) => Promise<unknown> }
    const original = table.put.bind(table)
    table.put = async () => {
      table.put = original
      throw new DOMException('Storage full', 'QuotaExceededError')
    }
  })
  await page.getByRole('textbox', { name: '便签标题' }).fill('未保存草稿')
  await expect(page.locator('.save-status')).toHaveText('本地未保存')
  expect(await page.evaluate(async () => (await import('/src/data/saveGuard.ts')).hasUnresolvedEditorDraft())).toBe(true)
  await page.locator('.note-item').filter({ hasText: '便签 B' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未保存草稿')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未保存草稿')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { Object.assign(window, { __copiedDraft: value }) } }
    })
  })
  await page.getByRole('button', { name: '复制草稿文本' }).click()
  expect(await page.evaluate(() => (window as Window & { __copiedDraft?: string }).__copiedDraft)).toBe('未保存草稿')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').filter(item => item.title === '便签 A').first()
    if (!note) throw new Error('测试便签不存在')
    await db.conflicts.put({ id: crypto.randomUUID(), ownerId: note.ownerId, entity: 'note', entityId: note.id,
      local: note, remote: { ...note, title: '云端版本', serverVersion: 1 }, createdAt: new Date().toISOString() })
  })
  await page.getByRole('button', { name: '数据与同步' }).click()
  const panel = page.getByRole('dialog', { name: '数据与同步' })
  await expect(panel.getByRole('button', { name: '导出 JSON 备份' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '清除本机数据并退出' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '保留本机版本' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '采用云端版本' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: '另存为新便签' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未保存草稿（恢复副本）')
  expect(await page.evaluate(async () => (await import('/src/data/saveGuard.ts')).hasUnresolvedEditorDraft())).toBe(false)
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').toArray()).map(note => note.title).sort()
  })).toEqual(['便签 A', '便签 B', '未保存草稿（恢复副本）'].sort())
})

test('external deletion keeps a failed draft available for recovery', async ({ page }) => {
  await page.goto('/')
  await createNamedNote(page, '待删便签')
  await createNamedNote(page, '另一便签')
  await page.locator('.note-item').filter({ hasText: '待删便签' }).click()
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const table = db.notes as unknown as { put: (...args: unknown[]) => Promise<unknown> }
    const original = table.put.bind(table)
    table.put = async () => {
      table.put = original
      throw new DOMException('Storage full', 'QuotaExceededError')
    }
  })
  await page.getByRole('textbox', { name: '便签标题' }).fill('未保存的删除前草稿')
  await expect(page.locator('.save-status')).toHaveText('本地未保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').filter(item => item.title === '待删便签').first()
    if (!note) throw new Error('测试便签不存在')
    await db.notes.put({ ...note, deletedAt: new Date().toISOString(), localRev: note.localRev + 1 })
  })
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未保存的删除前草稿')
  await expect(page.getByRole('button', { name: '另存为新便签' })).toBeVisible()
  await page.getByRole('button', { name: '另存为新便签' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未保存的删除前草稿（恢复副本）')
})

test('mobile editor keeps the unsaved warning and recovery actions in view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  const title = page.getByRole('textbox', { name: '便签标题' })
  await expect(title).toBeVisible()
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const table = db.notes as unknown as { put: (...args: unknown[]) => Promise<unknown> }
    const original = table.put.bind(table)
    table.put = async () => {
      table.put = original
      throw new DOMException('Storage full', 'QuotaExceededError')
    }
  })
  await title.fill('手机草稿')
  await expect(page.locator('.save-status')).toHaveText('本地未保存')
  await expect(page.locator('.save-status')).toBeInViewport()
  await expect(page.getByRole('button', { name: '复制草稿文本' })).toBeInViewport()
  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(title).toHaveValue('手机草稿')
})

test('an external update does not replace a draft whose local save failed', async ({ page }) => {
  await page.goto('/')
  await createNamedNote(page, '原标题')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const table = db.notes as unknown as { put: (...args: unknown[]) => Promise<unknown> }
    const original = table.put.bind(table)
    table.put = async () => {
      table.put = original
      throw new DOMException('Storage full', 'QuotaExceededError')
    }
  })
  const title = page.getByRole('textbox', { name: '便签标题' })
  await title.fill('未保存的标题')
  await expect(page.locator('.save-status')).toHaveText('本地未保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').first()
    if (!note) throw new Error('测试便签不存在')
    await db.notes.put({ ...note, title: '另一窗口的新标题', localRev: note.localRev + 1, confirmedRev: note.localRev + 1 })
  })
  await expect(page.getByRole('button', { name: '加载新版本' })).toBeVisible()
  await expect(title).toHaveValue('未保存的标题')
  await expect(page.getByRole('button', { name: '另存为新便签' })).toBeVisible()
})

