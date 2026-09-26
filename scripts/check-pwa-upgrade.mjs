import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vite = resolve(root, 'node_modules/vite/bin/vite.js')
const originalEnv = { ...process.env }

function runVite(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [vite, ...args], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', rejectRun)
    child.on('close', code => code === 0 ? resolveRun(output) : rejectRun(new Error(`vite ${args.join(' ')} failed (${code})\n${output}`)))
  })
}

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口')
  probe.close()
  await once(probe, 'close')
  return address.port
}

async function waitForServer(url, server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`预览服务提前退出：${server.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* Wait until Vite starts. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error('预览服务未能启动')
}

async function putProbe(page) {
  await page.evaluate(async () => {
    localStorage.setItem('pwa-upgrade-probe', 'kept')
    await new Promise((resolveProbe, rejectProbe) => {
      const request = indexedDB.open('pwa-upgrade-probe', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('items')
      request.onerror = () => rejectProbe(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('items', 'readwrite')
        transaction.objectStore('items').put('kept', 'marker')
        transaction.oncomplete = () => { database.close(); resolveProbe() }
        transaction.onerror = () => { database.close(); rejectProbe(transaction.error) }
      }
    })
  })
}

async function getProbe(page) {
  return page.evaluate(async () => {
    const indexed = await new Promise((resolveProbe, rejectProbe) => {
      const request = indexedDB.open('pwa-upgrade-probe', 1)
      request.onerror = () => rejectProbe(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('items', 'readonly')
        const item = transaction.objectStore('items').get('marker')
        item.onsuccess = () => { database.close(); resolveProbe(item.result) }
        item.onerror = () => { database.close(); rejectProbe(item.error) }
      }
    })
    return { local: localStorage.getItem('pwa-upgrade-probe'), indexed }
  })
}

async function main() {
  let server
  let browser
  try {
    await runVite(['build'], {
      ...originalEnv,
      VITE_SUPABASE_URL: 'https://old-build.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_upgrade_old',
      VITE_DEMO_MODE: 'false'
    })
    const port = await freePort()
    const url = `http://127.0.0.1:${port}/`
    server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: originalEnv, windowsHide: true, stdio: 'ignore'
    })
    await waitForServer(url, server)
    browser = await chromium.launch({ channel: 'chrome' })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(url)
    await page.getByRole('heading', { name: '便签工具' }).waitFor()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    const oldScript = await page.locator('script[type="module"]').first().getAttribute('src')
    assert.ok(oldScript, '旧版脚本未加载')
    await putProbe(page)
    const noteTitle = '升级前便签'
    const noteBody = '升级前正文'
    await page.evaluate(() => {
      localStorage.setItem('sticky-notes-last-account', JSON.stringify({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', email: 'offline-upgrade@example.invalid'
      }))
    })
    await context.setOffline(true)
    await page.reload()
    await page.getByTitle('新建便签').first().click()
    await page.getByRole('textbox', { name: '便签标题' }).fill(noteTitle)
    await page.locator('.ProseMirror').click()
    await page.keyboard.insertText(noteBody)
    await page.locator('.note-item-title').filter({ hasText: noteTitle }).waitFor()
    await page.locator('.note-item-summary').filter({ hasText: noteBody }).waitFor()
    await context.setOffline(false)

    await runVite(['build'], {
      ...originalEnv,
      VITE_SUPABASE_URL: 'https://new-build.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_upgrade_new',
      VITE_DEMO_MODE: 'false'
    })
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) throw new Error('Service Worker 未注册')
      await registration.update()
    })
    const update = page.getByRole('button', { name: '更新并刷新' })
    await update.waitFor({ timeout: 20_000 })
    await Promise.all([page.waitForEvent('load'), update.click()])
    await page.getByRole('heading', { name: '便签工具' }).waitFor()
    const newScript = await page.locator('script[type="module"]').first().getAttribute('src')
    assert.ok(newScript && newScript !== oldScript, '更新后仍加载旧版脚本')
    assert.deepEqual(await getProbe(page), { local: 'kept', indexed: 'kept' })
    await context.setOffline(true)
    await page.reload()
    await page.getByRole('heading', { name: '便签工具' }).waitFor()
    assert.deepEqual(await getProbe(page), { local: 'kept', indexed: 'kept' })
    const restoredTitle = page.getByRole('textbox', { name: '便签标题' })
    await restoredTitle.waitFor()
    assert.equal(await restoredTitle.inputValue(), noteTitle)
    assert.match(await page.locator('.ProseMirror').textContent(), /升级前正文/)
    await page.locator('.data-status-button').click()
    await page.getByRole('dialog', { name: '数据与同步' }).getByText(/待同步 1 项/).waitFor({ timeout: 10_000 })
    console.log('PWA 跨版本更新、离线便签与浏览器存储保留：通过')
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        if (server && server.exitCode === null) {
          server.kill()
          await once(server, 'exit')
        }
      } finally {
        await runVite(['build'], originalEnv)
      }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

