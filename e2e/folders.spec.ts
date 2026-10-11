import { expect, test, type Page } from '@playwright/test'

async function addFolder(page: Page, name: string) {
  await page.getByTitle('新建文件夹').click()
  const input = page.getByLabel('新文件夹名称')
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.folder-item-name').getByText(name, { exact: true })).toBeVisible()
}

async function folderOrder(page: Page) {
  return page.locator('.folder-item:not(.system-folder) .folder-item-name').allTextContents()
}

test('desktop creates newest first, reorders by drag, renames inline and preserves notes when deleting a folder', async ({ page }) => {
  await page.goto('/')
  for (const name of ['第一', '第二', '第三']) await addFolder(page, name)
  await expect.poll(() => folderOrder(page)).toEqual(['第三', '第二', '第一'])
  const third = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '第三' })
  const first = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '第一' })
  await third.dragTo(first)
  await expect.poll(() => folderOrder(page)).toEqual(['第二', '第一', '第三'])
  await page.reload()
  await expect.poll(() => folderOrder(page)).toEqual(['第二', '第一', '第三'])

  const target = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '第一' })
  await target.getByTitle('重命名').click()
  await page.getByLabel('重命名文件夹').fill('项目资料')
  await page.getByLabel('重命名文件夹').press('Enter')
  await expect.poll(() => folderOrder(page)).toEqual(['第二', '项目资料', '第三'])
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '项目资料' }).click()
  await page.getByTitle('新建便签').first().click()
  await page.getByLabel('便签标题', { exact: true }).fill('保留的便签')
  await expect(page.locator('.sync-status-button')).toContainText('本地已保存')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '项目资料' }).getByTitle('删除文件夹').click()
  await expect.poll(() => folderOrder(page)).toEqual(['第二', '第三'])
  await expect(page.locator('.note-item-title').getByText('保留的便签', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').filter(item => item.title === '保留的便签').first()
    return { folderId: note?.folderId, deletedAt: note?.deletedAt }
  })).toEqual({ folderId: null, deletedAt: null })
})

test('phone-width folder creation and inline rename follow the compact interaction', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '打开菜单' }).click()
  for (const name of ['甲', '乙', '丙']) await addFolder(page, name)
  await expect.poll(() => folderOrder(page)).toEqual(['丙', '乙', '甲'])
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '甲' }).getByTitle('重命名').click()
  await page.getByLabel('重命名文件夹').fill('手机分类')
  await page.getByLabel('重命名文件夹').press('Enter')
  await expect.poll(() => folderOrder(page)).toEqual(['丙', '乙', '手机分类'])
  await page.reload()
  await page.getByRole('button', { name: '打开菜单' }).click()
  await expect.poll(() => folderOrder(page)).toEqual(['丙', '乙', '手机分类'])
})
