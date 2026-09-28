import { expect, test, type Page } from '@playwright/test'

async function paste(page: Page, text: string, html?: string) {
  await page.getByLabel('便签正文', { exact: true }).evaluate((element, data) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', data.text)
    if (data.html !== undefined) clipboardData.setData('text/html', data.html)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, { text, html })
}

async function savedText(page: Page) {
  return page.evaluate(async () => {
    const { db } = await import('/src/data/db.ts')
    return (await db.notes.where('ownerId').equals('local-demo').first())?.plainText
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('新建便签').first().click()
  await page.getByLabel('便签标题', { exact: true }).fill('粘贴保真')
  await page.getByLabel('便签正文', { exact: true }).click()
})

for (const rich of [false, true]) {
  test(`${rich ? 'HTML-backed' : 'plain'} clipboard keeps literal markup and whitespace after reload`, async ({ page }) => {
    const text = '  <div>中文</div> &amp; &#65;\t字\r\n\r\n**保留星号**  \r结尾\n'
    const normalized = text.replace(/\r\n?/g, '\n')
    await paste(page, text, rich ? '<p>网页中的格式化内容</p>' : undefined)
    await expect.poll(() => savedText(page)).toBe(normalized)
    await expect(page.getByLabel('便签正文', { exact: true }).locator('div, script, img, strong')).toHaveCount(0)
    await expect(page.locator('.save-status')).toContainText('本地已保存')
    await page.reload()
    expect(await savedText(page)).toBe(normalized)
    await expect(page.getByLabel('便签正文', { exact: true })).toContainText('<div>中文</div> &amp; &#65;')
    expect(await page.evaluate(async () => {
      const { makeBackup, parseBackup } = await import('/src/data/backup.ts')
      return parseBackup(JSON.stringify(await makeBackup('local-demo'))).notes[0].plainText
    })).toBe(normalized)
  })
}

test('multiline rich clipboard replaces only the selection and remains undoable', async ({ page }) => {
  const body = page.getByLabel('便签正文', { exact: true })
  await body.fill('前缀被选中后缀')
  await expect.poll(() => savedText(page)).toBe('前缀被选中后缀')
  await body.evaluate(element => {
    const text = element.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await paste(page, '<标签>\n第二行', '<div>格式化内容</div>')
  await expect.poll(() => savedText(page)).toBe('前缀<标签>\n第二行后缀')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => savedText(page)).toBe('前缀被选中后缀')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => savedText(page)).toBe('前缀<标签>\n第二行后缀')
})

test('HTML without a plain-text alternative does not delete selected text', async ({ page }) => {
  const body = page.getByLabel('便签正文', { exact: true })
  await body.fill('这段已保存内容不能被空粘贴删除')
  await expect.poll(() => savedText(page)).toBe('这段已保存内容不能被空粘贴删除')
  await page.keyboard.press('ControlOrMeta+A')
  await paste(page, '', '<img src="https://example.invalid/image.png">')
  await expect(page.getByText('剪贴板没有可粘贴的纯文本')).toBeVisible()
  expect(await savedText(page)).toBe('这段已保存内容不能被空粘贴删除')
  await expect(body).toHaveText('这段已保存内容不能被空粘贴删除')
})

for (const format of [
  { name: '中标题', selector: 'h2' },
  { name: '无序列表', selector: 'ul:not([data-type]) li p' },
  { name: '待办清单', selector: 'ul[data-type="taskList"] li p' }
]) {
  test(`multiline plain text fits ${format.name} without losing lines`, async ({ page }) => {
    await page.getByRole('button', { name: format.name, exact: true }).click()
    await paste(page, '<保留>\n\n第二行', '<p>网页内容</p>')
    const body = page.getByLabel('便签正文', { exact: true })
    // List wrappers add plain-text separators, and StarterKit already adds a
    // trailing paragraph. Inspect leaf lines to distinguish those from paste loss.
    await expect(body.locator('p,h2')).toHaveText(['<保留>', '', '第二行', ''])
    await expect(body.locator(format.selector).first()).toHaveText('<保留>')
    await expect(page.locator('.save-status')).toContainText('本地已保存')
    const beforeReload = await savedText(page)
    await page.reload()
    await expect(body.locator('p,h2')).toHaveText(['<保留>', '', '第二行', ''])
    expect(await savedText(page)).toBe(beforeReload)
  })
}
