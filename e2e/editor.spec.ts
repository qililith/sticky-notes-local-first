import { expect, test } from '@playwright/test'

for (const format of [
  { button: '加粗', selector: 'strong' },
  { button: '斜体', selector: 'em' },
  { button: '高亮', selector: 'mark' },
  { button: '大标题', selector: 'h1' },
  { button: '中标题', selector: 'h2' },
  { button: '小标题', selector: 'h3' },
  { button: '无序列表', selector: 'ul:not([data-type]) li' },
  { button: '有序列表', selector: 'ol li' },
  { button: '待办清单', selector: 'ul[data-type="taskList"] li' }
]) {
  test(`${format.button} with Chinese text persists after reload`, async ({ page }) => {
    await page.goto('/')
    await page.getByTitle('新建便签').first().click()
    await page.getByRole('textbox', { name: '便签标题' }).fill(format.button)
    const body = page.locator('.ProseMirror')
    await body.click()
    await page.getByRole('button', { name: format.button }).click()
    await page.keyboard.insertText('中文内容')
    await expect(body.locator(format.selector)).toContainText('中文内容')
    await expect(page.locator('.save-status')).toContainText('本地已保存')
    await page.reload()
    await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue(format.button)
    await expect(page.locator(`.ProseMirror ${format.selector}`)).toContainText('中文内容')
  })
}

test('Chromium IME composition commits in title and body without losing text', async ({ page, context }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  const cdp = await context.newCDPSession(page)
  const title = page.getByRole('textbox', { name: '便签标题' })
  await title.focus()
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '你' })
  await expect(title).toHaveValue('你')

  const body = page.locator('.ProseMirror')
  await body.click()
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await cdp.send('Input.insertText', { text: '中' })
  await expect(body).toHaveText('中')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  await page.reload()
  await expect(title).toHaveValue('你')
  await expect(page.locator('.ProseMirror')).toHaveText('中')
})

test('title and folder inputs stop at the cloud name limit', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  const title = page.getByRole('textbox', { name: '便签标题' })
  await title.fill('字'.repeat(256))
  await expect(title).toHaveValue('字'.repeat(255))
  await expect(page.locator('.save-status')).toContainText('本地已保存')

  await page.getByTitle('新建文件夹').click()
  const folder = page.getByRole('textbox', { name: '新文件夹名称' })
  await folder.fill('夹'.repeat(256))
  await expect(folder).toHaveValue('夹'.repeat(255))
  await page.locator('.folder-create-form button[type="submit"]').click()
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.folders.where('ownerId').equals('local-demo').first())?.name.length
  })).toBe(255)
})

