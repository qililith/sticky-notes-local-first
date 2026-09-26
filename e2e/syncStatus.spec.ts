import { expect, test } from '@playwright/test'

test('a sync failure is visible without opening the data panel', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('本地便签')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    await db.syncMeta.put({
      ownerId: 'local-demo', cursor: '0', lastSyncedAt: null,
      lastError: '测试同步失败'
    })
  })
  await expect(page.getByRole('button', { name: '数据与同步，同步失败' })).toBeVisible()
  await expect(page.locator('.data-status-button .conflict-badge')).toHaveText('!')
  await expect(page.locator('.save-status')).toHaveText('本地已保存 · 同步失败')
  await page.getByRole('button', { name: '查看同步问题' }).click()
  await expect(page.getByRole('dialog', { name: '数据与同步' })).toContainText('测试同步失败')
})

