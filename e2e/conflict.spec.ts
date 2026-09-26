import { expect, test } from '@playwright/test'

test('an unresolved conflict is visible from the note and app header', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('本机便签')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.where('ownerId').equals('local-demo').first()
    if (!note) throw new Error('测试便签不存在')
    await db.conflicts.put({
      id: crypto.randomUUID(), ownerId: 'local-demo', entity: 'note', entityId: note.id,
      local: note, remote: { ...note, title: '云端便签', serverVersion: 1 },
      createdAt: new Date().toISOString()
    })
  })
  await expect(page.getByRole('button', { name: '数据与同步，1 项冲突' })).toBeVisible()
  await expect(page.locator('.save-status')).toContainText('同步冲突')
  await page.locator('.ProseMirror').click()
  await page.keyboard.insertText('冲突后新增')
  await expect(page.locator('.save-status')).toContainText('本地已保存 · 同步冲突')
  await page.getByRole('button', { name: '处理冲突' }).click()
  const panel = page.getByRole('dialog', { name: '数据与同步' })
  await expect(panel).toContainText('另一台设备也改动了这项')
  await panel.getByText('查看本机版本').click()
  await expect(panel.locator('pre').first()).toContainText('冲突后新增')
})

