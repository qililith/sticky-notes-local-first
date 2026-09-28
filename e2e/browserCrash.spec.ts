import { chromium, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('saved notes and pending mutations survive a browser-process crash', async ({ baseURL }) => {
  test.setTimeout(60_000)
  const prefix = join(tmpdir(), 'sticky-notes-crash-')
  const profile = await mkdtemp(prefix)
  let context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
  try {
    let page = context.pages()[0]
    await page.goto(baseURL!)
    await page.getByTitle('新建便签').first().click()
    await page.getByLabel('便签标题', { exact: true }).fill('异常退出恢复')
    await page.getByLabel('便签正文', { exact: true }).fill('已经提交到本地数据库的正文。')
    await expect(page.locator('.save-status')).toContainText('本地已保存')
    const before = await page.evaluate(async () => {
      const { db } = await import('/src/data/db.ts')
      return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
    })
    expect(before.notes).toHaveLength(1)
    expect(before.outbox).toHaveLength(1)
    const cdp = await context.browser()!.newBrowserCDPSession()
    const closed = context.waitForEvent('close', { timeout: 15_000 })
    // Crash only this disposable browser process, not the user's browser.
    void cdp.send('Browser.crash').catch(() => undefined)
    await closed
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
    page = context.pages()[0]
    await page.goto(baseURL!)
    await expect(page.getByLabel('便签标题', { exact: true })).toHaveValue('异常退出恢复')
    await expect(page.getByLabel('便签正文', { exact: true })).toHaveText('已经提交到本地数据库的正文。')
    expect(await page.evaluate(async () => {
      const { db } = await import('/src/data/db.ts')
      return { notes: await db.notes.toArray(), outbox: await db.outbox.toArray() }
    })).toEqual(before)
  } finally {
    await context.close().catch(() => undefined)
    if (!resolve(profile).startsWith(resolve(prefix))) throw new Error('Unexpected test profile path')
    await rm(profile, { recursive: true, force: true })
  }
})
