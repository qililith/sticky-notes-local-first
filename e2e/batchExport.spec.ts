import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { expect, test } from '@playwright/test'

test('cloud-sync panel downloads all five batch formats with account isolation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.evaluate(async () => {
    const { createFolder, createNoteWithContent, updateNote } = await import('/src/data/repository.ts')
    const folder = await createFolder('local-demo', '中文文件夹')
    const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] }] })
    await createNoteWithContent('local-demo', folder.id, '同名', doc('正文甲'), '正文甲')
    await createNoteWithContent('local-demo', folder.id, '同名', doc('正文乙'), '正文乙')
    await createNoteWithContent('local-demo', null, '未分类便签', doc('未分类正文'), '未分类正文')
    const deleted = await createNoteWithContent('local-demo', folder.id, '已删除', doc('回收站内容'), '回收站内容')
    await updateNote('local-demo', deleted.id, { deletedAt: new Date().toISOString() })
    await createNoteWithContent('foreign-test-owner', null, '他人便签', doc('另一个账号的内容'), '另一个账号的内容')
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: /云同步/ }).click()
  const exportSection = page.getByRole('heading', { name: '导出为文件' }).locator('..')
  await expect(exportSection).toContainText('共 3 条')
  const before = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
  })
  for (const kind of ['txt-zip', 'md-zip', 'html-zip', 'txt-merged', 'md-merged']) {
    await page.getByRole('combobox', { name: '批量导出类型' }).selectOption(kind)
    const pending = page.waitForEvent('download')
    await exportSection.getByRole('button', { name: '下载' }).click()
    const download = await pending
    expect(await download.failure()).toBeNull()
    const bytes = await readFile((await download.path())!)
    const content = kind.endsWith('zip') ? Object.values(unzipSync(bytes)).map(data => strFromU8(data)).join('\n') : bytes.toString('utf8')
    expect(content).toContain('正文甲')
    expect(content).toContain('正文乙')
    expect(content).toContain('未分类正文')
    expect(content).not.toContain('回收站内容')
    expect(content).not.toContain('另一个账号的内容')
    if (kind.endsWith('zip')) expect(Object.keys(unzipSync(bytes))).toHaveLength(3)
  }
  await page.getByRole('combobox', { name: '导出范围' }).selectOption({ label: '中文文件夹' })
  await expect(exportSection).toContainText('共 2 条')
  await page.getByRole('combobox', { name: '批量导出类型' }).selectOption('md-zip')
  const pending = page.waitForEvent('download')
  await exportSection.getByRole('button', { name: '下载' }).click()
  const file = await pending
  const paths = Object.keys(unzipSync(await readFile((await file.path())!)))
  expect(paths).toHaveLength(2)
  expect(paths.every(path => path.startsWith('中文文件夹/'))).toBe(true)
  expect(paths.some(path => path.includes('(2)'))).toBe(true)
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
  })).toEqual(before)
})
