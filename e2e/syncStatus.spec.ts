import { expect, test } from '@playwright/test'

test('folder repair names the rejected note and preserves its content', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const { createFolder, createNoteWithContent } = await import('/src/data/repository.ts')
    const folder = await createFolder('local-demo', '云端不可用分类')
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '需要保留的正文' }] }] }
    const note = await createNoteWithContent('local-demo', folder.id, '真正被拒绝的便签', doc, '需要保留的正文')
    await createNoteWithContent('local-demo', null, '另一条正常便签', doc, '需要保留的正文')
    const queued = await db.outbox.where('entityId').equals(note.id).first()
    await db.outbox.update(queued!.id, { state: 'rejected', error: '便签所选文件夹在云端已删除或不可用；请将便签移到“未分类”，再重试同步。' })
  })
  await page.getByRole('button', { name: '数据与同步，1 项需处理' }).click()
  const panel = page.getByRole('dialog', { name: '数据与同步' })
  await expect(panel).toContainText('便签：真正被拒绝的便签')
  await panel.getByRole('button', { name: '移到未分类并重试' }).click()
  await expect(panel).toContainText('需处理 0 项')
  const result = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const notes = await db.notes.toArray()
    const repaired = notes.find(n => n.title === '真正被拒绝的便签')!
    const queue = await db.outbox.where('entityId').equals(repaired.id).first()
    return { count: notes.length, repaired, queue }
  })
  expect(result.count).toBe(2)
  expect(result.repaired).toMatchObject({ folderId: null, plainText: '需要保留的正文', title: '真正被拒绝的便签' })
  expect(result.queue).toMatchObject({ state: 'pending', payload: { folderId: null, plainText: '需要保留的正文' } })
})

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

test('a cloud-rejected note is listed for repair without counting as pending upload', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('超长便签')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const note = await db.notes.toCollection().first()
    const queued = await db.outbox.toCollection().first()
    if (!note || !queued) throw new Error('expected a local note')
    await db.outbox.put({
      ...queued, state: 'rejected',
      error: '便签内容超过云端单次上传限制；内容仍保存在本机。请先导出备份，再拆分或缩短便签。'
    })
    await db.syncMeta.put({
      ownerId: 'local-demo', cursor: '0', lastSyncedAt: null,
      lastError: '1 项被云端拒绝：便签内容超过云端单次上传限制；内容仍保存在本机。请先导出备份，再拆分或缩短便签。'
    })
  })
  await expect(page.getByRole('button', { name: '数据与同步，1 项需处理' })).toBeVisible()
  await expect(page.locator('.note-item-badge')).toHaveText('需处理')
  await page.getByRole('button', { name: '查看同步问题' }).click()
  const panel = page.getByRole('dialog', { name: '数据与同步' })
  await expect(panel).toContainText('待同步 0 项 · 需处理 1 项')
  await expect(panel).toContainText('超过云端单次上传限制')
})
