import { expect, test } from '@playwright/test'

test('informational toasts do not block the data and sync toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('/')
  await page.getByTitle('新建文件夹', { exact: true }).click()
  await page.getByLabel('新文件夹名称').fill('提示遮挡回归')
  await page.getByTitle('创建', { exact: true }).click()
  const toast = page.getByText('文件夹已创建', { exact: true })
  await expect(toast).toBeVisible()
  const notification = page.locator('[data-sonner-toast]').filter({ hasText: '文件夹已创建' })
  await expect(notification).toHaveCSS('pointer-events', 'none')
  const box = await notification.boundingBox()
  if (!box) throw new Error('Notification has no visible box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  // Click while the toast is still showing, not after its auto-dismiss timer.
  await page.getByRole('button', { name: '数据与同步', exact: true }).click({ timeout: 2000 })
  await expect(page.getByRole('dialog', { name: '数据与同步' })).toBeVisible()
})
