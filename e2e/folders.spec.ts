import { expect, test, type Page } from '@playwright/test'

async function addFolder(page: Page, name: string) {
  await page.getByTitle('新建文件夹').click()
  await page.getByLabel('新文件夹名称').fill(name)
  await page.locator('.folder-create-form button[type="submit"]').click()
  await expect(page.locator('.folder-item-name').getByText(name, { exact: true })).toBeVisible()
}

async function folderOrder(page: Page) {
  return page.locator('.folder-item:not(.system-folder) .folder-item-name').allTextContents()
}

test('desktop reorder, rename and folder deletion preserve the note', async ({ page }) => {
  await page.goto('/')
  for (const name of ['第一', '第二', '第三']) await addFolder(page, name)
  const third = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '第三' })
  await third.getByTitle('上移文件夹').click()
  await expect.poll(() => folderOrder(page)).toEqual(['第一', '第三', '第二'])
  await page.reload()
  await expect.poll(() => folderOrder(page)).toEqual(['第一', '第三', '第二'])

  const target = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '第三' })
  await target.getByTitle('重命名').click()
  await page.getByLabel('重命名文件夹').fill('项目资料')
  await page.getByTitle('保存文件夹名称').click()
  await expect.poll(() => folderOrder(page)).toEqual(['第一', '项目资料', '第二'])
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '项目资料' }).click()
  await page.getByTitle('新建便签').first().click()
  await page.getByLabel('便签标题', { exact: true }).fill('保留的便签')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '项目资料' }).getByTitle('删除文件夹').click()
  await expect.poll(() => folderOrder(page)).toEqual(['第一', '第二'])
  await expect(page.locator('.note-item-title').getByText('保留的便签', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').filter(item => item.title === '保留的便签').first()
    return { folderId: note?.folderId, deletedAt: note?.deletedAt }
  })).toEqual({ folderId: null, deletedAt: null })
})

test('phone-width menu offers visible reorder and rename controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '打开菜单' }).click()
  for (const name of ['甲', '乙', '丙']) await addFolder(page, name)
  const first = page.locator('.folder-item:not(.system-folder)').filter({ hasText: '甲' })
  await expect(first.getByTitle('上移文件夹')).toBeDisabled()
  await expect(first.getByTitle('下移文件夹')).toBeVisible()
  await first.getByTitle('下移文件夹').click()
  await expect.poll(() => folderOrder(page)).toEqual(['乙', '甲', '丙'])
  await page.locator('.folder-item:not(.system-folder)').filter({ hasText: '甲' }).getByTitle('重命名').click()
  await page.getByLabel('重命名文件夹').fill('手机分类')
  await page.getByTitle('保存文件夹名称').click()
  await expect.poll(() => folderOrder(page)).toEqual(['乙', '手机分类', '丙'])
  await page.reload()
  await page.getByRole('button', { name: '打开菜单' }).click()
  await expect.poll(() => folderOrder(page)).toEqual(['乙', '手机分类', '丙'])
})
