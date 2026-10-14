import { expect, test } from '@playwright/test'

test('offers an interrupted mobile edit as a separate note after reopening', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签' }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('原便签')
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.title
  })).toBe('原便签')
  const noteId = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())!.id
  })
  await page.evaluate(id => {
    localStorage.setItem(`sticky-notes-recovery:local-demo:${id}`, JSON.stringify({
      token: crypto.randomUUID(), title: '未完成的手机内容', plainText: '刚刚输入的正文',
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '刚刚输入的正文' }] }] }
    }))
  }, noteId)
  await page.reload()
  await page.locator('.note-item').filter({ hasText: '原便签' }).click()
  await expect(page.getByText('上次关闭时有一段内容尚未确认保存。')).toBeVisible()
  await page.getByRole('button', { name: '另存这段内容' }).click()
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('未完成的手机内容（找回副本）')
  expect(await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').toArray()).map(note => note.plainText)
  })).toContain('刚刚输入的正文')
})

test('restores a known same-note draft in place and saves it automatically', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '新建便签' }).click()
  await page.getByRole('textbox', { name: '便签标题' }).fill('原便签')
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const saved = await db.notes.where('ownerId').equals('local-demo').first()
    return saved ? { id: saved.id, localRev: saved.localRev } : null
  })).not.toBeNull()
  await page.reload()
  const savedNote = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    const saved = await db.notes.where('ownerId').equals('local-demo').first()
    return { id: saved!.id, localRev: saved!.localRev }
  })
  await page.evaluate(({ id, localRev }) => {
    localStorage.setItem(`sticky-notes-recovery:local-demo:${id}`, JSON.stringify({
      token: crypto.randomUUID(), title: '自动找回', plainText: '完整正文', baseLocalRev: localRev,
      savedAt: new Date().toISOString(),
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '完整正文' }] }] }
    }))
  }, savedNote)
  expect(await page.evaluate(async id => {
    const { db } = await import('/src/data/db.ts')
    const { readRecoveryDraft } = await import('/src/data/recoveryDraft.ts')
    return { noteRev: (await db.notes.get(id))?.localRev, draftRev: readRecoveryDraft('local-demo', id)?.baseLocalRev }
  }, savedNote.id)).toEqual({ noteRev: savedNote.localRev, draftRev: savedNote.localRev })
  await page.locator('.note-item').filter({ hasText: '原便签' }).click()
  await expect.poll(() => page.evaluate(async id => {
    const { db } = await import('/src/data/db.ts')
    const current = await db.notes.get(id)
    return current ? { plainText: current.plainText, title: current.title } : null
  }, savedNote.id)).toEqual({ plainText: '完整正文', title: '自动找回' })
  await expect(page.getByRole('textbox', { name: '便签标题' })).toHaveValue('自动找回')
  await expect(page.getByText('上次关闭时有一段内容尚未确认保存。')).toHaveCount(0)
  expect(await page.evaluate(id => localStorage.getItem(`sticky-notes-recovery:local-demo:${id}`), savedNote.id)).toBeNull()
})
