import { expect, test } from '@playwright/test'

test('production shell reloads without network after service worker takes control', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '便签工具' })).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: '便签工具' })).toBeVisible()
})

