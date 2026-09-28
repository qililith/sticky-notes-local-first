import { expect, test } from '@playwright/test'

test('browser-enforced storage quota retains the saved note and recovers the draft', async ({ page, context }) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByLabel('便签标题', { exact: true }).fill('配额测试')
  await page.getByLabel('便签正文', { exact: true }).fill('已保存的原文')
  await expect(page.locator('.save-status')).toContainText('本地已保存')
  const before = await page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
  })
  const cdp = await context.newCDPSession(page)
  const origin = new URL(page.url()).origin
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 })
  const quota = await cdp.send('Storage.getUsageAndQuota', { origin })
  expect(quota.overrideActive).toBe(true)
  expect(quota.quota).toBe(1024)
  try {
    // Chromium caches available IndexedDB space for 30 seconds. Let that
    // reservation expire so this write reaches the real quota manager.
    await page.waitForTimeout(31_000)
    const draft = '空间不足时仍需保留的草稿。'.repeat(1000)
    await page.getByLabel('便签正文', { exact: true }).fill(draft)
    await expect(page.locator('.save-status')).toHaveText('本地未保存')
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /quota/i }).first()).toBeVisible()
    await expect(page.getByLabel('便签正文', { exact: true })).toHaveText(draft)
    expect(await page.evaluate(async () => {
      const { db } = await import('/src/data/db.ts')
      return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
    })).toEqual(before)
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page.getByLabel('便签正文', { exact: true })).toHaveText(draft)
    await cdp.send('Storage.overrideQuotaForOrigin', { origin })
    await page.getByRole('button', { name: '另存为新便签' }).click()
    await expect(page.locator('.save-status')).toContainText('本地已保存')
    await page.reload()
    await expect.poll(() => page.evaluate(async () => {
      const { db } = await import('/src/data/db.ts')
      return (await db.notes.toArray()).map(note => note.plainText).sort()
    })).toEqual(['已保存的原文', draft].sort())
  } finally {
    await cdp.send('Storage.overrideQuotaForOrigin', { origin })
    await cdp.detach()
  }
})
