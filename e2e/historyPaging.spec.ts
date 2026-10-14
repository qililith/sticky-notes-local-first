import { expect, test } from '@playwright/test'

test('the history panel fetches older versions only after requested', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('历史分页')
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.title
  })).toBe('历史分页')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = (await db.notes.where('ownerId').equals('local-demo').first())!
    await db.history.bulkPut(Array.from({ length: 25 }, (_, index) => ({
      id: crypto.randomUUID(), ownerId: note.ownerId, noteId: note.id, serverVersion: index + 1,
      snapshot: { ...note, serverVersion: index + 1, plainText: `历史正文 ${index + 1}` },
      createdAt: new Date().toISOString()
    })))
  })
  await page.locator('.sync-status-button').first().click()
  const section = page.getByRole('dialog', { name: '数据与同步' }).locator('section').filter({ has: page.getByRole('heading', { name: '这条便签的以前内容' }) })
  await expect(section.getByRole('button', { name: '恢复', exact: true })).toHaveCount(20)
  await expect(section).toContainText('历史正文 25')
  await expect(section.locator('.history-preview').filter({ hasText: /^历史正文 1$/ })).toHaveCount(0)
  await section.getByRole('button', { name: '更早的内容' }).click()
  await expect(section.getByRole('button', { name: '恢复', exact: true })).toHaveCount(25)
  await expect(section.locator('.history-preview').filter({ hasText: /^历史正文 1$/ })).toHaveCount(1)
  await page.getByRole('button', { name: '查看本机占用' }).click()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).toContainText('25 个旧版本')
})
