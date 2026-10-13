import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function exportFile(page: Page, label: string) {
  await page.getByRole('button', { name: '更多便签操作', exact: true }).click()
  await page.getByRole('button', { name: '导出便签', exact: true }).click()
  const pendingDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: label, exact: true }).click()
  const download = await pendingDownload
  expect(await download.failure()).toBeNull()
  return { filename: download.suggestedFilename(), content: await readFile((await download.path())!, 'utf8') }
}

test('exports only the open note as TXT and formatted Markdown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签', exact: true }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('别的便签不要导出')
  await page.getByRole('button', { name: '收起键盘和字体面板' }).click()
  await expect(page.locator('.mobile-sync-status')).toContainText('本地已保存')
  await page.getByRole('button', { name: '返回列表' }).click()
  await page.getByRole('button', { name: '新建便签', exact: true }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('导出/中文')
  const body = page.locator('.ProseMirror')
  await body.fill('正文内容')
  await body.press('ControlOrMeta+a')
  await page.getByRole('button', { name: '字体', exact: true }).click()
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  await expect(body.locator('strong')).toHaveText('正文内容')
  const txt = await exportFile(page, '导出 TXT')
  expect(txt).toEqual({ filename: '导出_中文.txt', content: '导出/中文\n\n正文内容\n' })
  const md = await exportFile(page, '导出 Markdown')
  expect(md).toEqual({ filename: '导出_中文.md', content: '# 导出/中文\n\n**正文内容**\n' })
  await expect(body.locator('strong')).toHaveText('正文内容')
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('导出/中文')
})

test('exports the visible failed draft without pretending it was saved', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签', exact: true }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('恢复草稿')
  await page.getByRole('button', { name: '收起键盘和字体面板' }).click()
  await expect(page.locator('.mobile-sync-status')).toContainText('本地已保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    db.notes.hook('updating', () => { throw new DOMException('export draft test', 'QuotaExceededError') })
  })
  await page.locator('.ProseMirror').fill('尚未保存的草稿')
  await expect(page.locator('.mobile-sync-status')).toContainText('本地未保存')
  expect((await exportFile(page, '导出 TXT')).content).toBe('恢复草稿\n\n尚未保存的草稿\n')
  await expect(page.locator('.mobile-sync-status')).toContainText('本地未保存')
  await expect(page.locator('.ProseMirror')).toHaveText('尚未保存的草稿')
})
