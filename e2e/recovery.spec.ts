import { expect, test } from '@playwright/test'

test('choosing a damaged backup clears the previous valid import preview', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('不能被错误导入覆盖')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  const archive = await page.evaluate(async () => (await import('/src/data/backup.ts')).makeBackup('local-demo'))
  await page.getByRole('button', { name: '数据与同步' }).click()
  const panel = page.getByRole('dialog', { name: '数据与同步' })
  const chooser = panel.locator('input[type="file"]')
  await chooser.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) })
  await expect(panel.getByRole('button', { name: '确认导入', exact: true })).toBeVisible()
  await chooser.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...archive, history: [{}] })) })
  await expect(page.getByText(/历史记录或账号归属无效/)).toBeVisible()
  await expect(panel.getByRole('button', { name: '确认导入', exact: true })).not.toBeVisible()
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.toArray()).map(note => note.title)
  })).toEqual(['不能被错误导入覆盖'])
})

test('same-account UI backup recovery keeps the original note ID', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('要恢复的便签')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  const originalId = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.id
  })
  expect(originalId).toBeTruthy()

  await page.getByRole('button', { name: '数据与同步' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON 备份' }).click()
  const backupPath = await (await downloadPromise).path()
  expect(backupPath).toBeTruthy()
  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: '清除本机数据并退出' }).click()
  await page.getByRole('button', { name: '进入本地演示' }).click()

  await page.getByRole('button', { name: '数据与同步' }).click()
  const chooser = page.locator('input[type="file"]')
  await chooser.setInputFiles(backupPath!)
  await expect(page.getByText('预览：1 条便签')).toBeVisible()
  await page.getByRole('button', { name: '确认导入' }).click()
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').toArray()).map(note => ({ id: note.id, title: note.title }))
  })).toEqual([{ id: originalId, title: '要恢复的便签' }])

  await chooser.setInputFiles(backupPath!)
  await page.getByRole('button', { name: '确认导入' }).click()
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return db.notes.where('ownerId').equals('local-demo').count()
  })).toBe(1)
})
