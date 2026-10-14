import { expect, test } from '@playwright/test'

test('system back returns from data panel to note, then from note to list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签' }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('手机返回测试')
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.title
  })).toBe('手机返回测试')
  await page.getByRole('button', { name: '更多便签操作' }).click()
  await page.getByRole('button', { name: '数据与同步', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('手机返回测试')
  await page.goBack()
  await expect(page.locator('.note-item-title').filter({ hasText: '手机返回测试' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '便签标题' })).not.toBeVisible()
})

test('system back keeps an editor open while its local write is pending', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toBeVisible()
  await page.evaluate(async () => {
    const { beginEditorWrite } = await import('/src/data/saveGuard.ts')
    Object.assign(window, { finishPendingWrite: beginEditorWrite() })
  })
  await page.goBack()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toBeVisible()
  await page.evaluate(() => (window as Window & { finishPendingWrite?: () => void }).finishPendingWrite?.())
  await page.goBack()
  await expect(page.getByRole('textbox', { name: '便签标题' })).not.toBeVisible()
})

test('system back returns from settings sync to settings and then the note list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签' }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('更多功能返回测试')
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.title
  })).toBe('更多功能返回测试')
  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(page.locator('.note-item-title').filter({ hasText: '更多功能返回测试' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.history.state?.stickyNotesMobile?.layer)).toBe('list')
  await page.getByRole('button', { name: /^设置/ }).click()
  await expect(page.getByRole('region', { name: '设置' })).toBeVisible()
  await page.getByRole('button', { name: /云同步/ }).click()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).not.toBeVisible()
  await expect(page.getByRole('region', { name: '设置' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('region', { name: '设置' })).not.toBeVisible()
  await expect(page.locator('.note-item-title').filter({ hasText: '更多功能返回测试' })).toBeVisible()
})
