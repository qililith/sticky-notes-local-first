import { chromium, expect } from '@playwright/test'
import { build, preview } from 'vite'

// Called only by the opt-in cloud test runner. Admin keys never enter the browser.
// All pages use temporary contexts; user browser profiles and the normal dev server are untouched.
export async function runCloudBrowserChecks({ accounts, readClient, runId, projectUrl, setTestAccountBBan, revokeTestSession, naturalExpiry = false, expiryDiagnostic = false }) {
  if (naturalExpiry && expiryDiagnostic) throw new Error('Natural expiry and simulated expiry are mutually exclusive')
  let server
  let browser
  let restoreBuild = false
  let step = 'Build production PWA and start isolated preview'
  const pages = []
  const transportFailures = new Map()
  const title = `网页联调-${runId.slice(0, 8)}`
  const textOne = '第一设备离线编辑，恢复联网后上传。'
  const textTwo = '第二设备独立修改，必须保留冲突双方。'
  const initialText = '真实网页登录后的第一段正文。\n\n<div>按原样保存</div> &amp;  **星号**'
  const check = (value, label) => { if (!value) throw new Error(label) }
  const pass = label => console.log(`PASS UI ${label}`)
  const wait = expect.configure({ timeout: 30_000 })
  const authStorageKey = `sb-${new URL(projectUrl).hostname.split('.')[0]}-auth-token`
  const diagnosingExpiry = naturalExpiry || expiryDiagnostic
  // Instrument only this test build. No tokens, IDs, payloads or raw SDK debug output.
  const diagnosticPlugin = {
    name: 'expiry-stage-diagnostics', enforce: 'pre',
    transform(code, id) {
      const path = id.replaceAll('\\', '/')
      if (path.endsWith('/src/auth.ts')) {
        return { code: code + `
          supabase!.auth.onAuthStateChange(event => {
            if (event === 'TOKEN_REFRESHED') window.dispatchEvent(new CustomEvent('expiry-stage', { detail: 'auth:refreshed' }))
          })
          ;(window as any).__expiryProbe = {
            refresh: () => supabase!.auth.getSession().then(result => ({ ok: !result.error })),
            state: () => {
              const auth = supabase!.auth as any
              return { refreshing: Boolean(auth.refreshingDeferred),
                cooldownMs: Math.max(0, (auth.lastRefreshFailure?.expiresAt ?? 0) - Date.now()) }
            }
          }
        `, map: null }
      }
      if (!path.endsWith('/src/sync/engine.ts')) return
      const marks = [
        ['const token = await tokenForAccount(ownerId)', "mark('session:start'); const token = await tokenForAccount(ownerId); mark('session:ready')"],
        ['const run = async (): Promise<boolean> => {', "const run = async (): Promise<boolean> => { mark('lock:acquired')"],
        ['await uploadOne(ownerId, item, token)', "{ mark('upload:start'); await uploadOne(ownerId, item, token); mark('upload:ack') }"],
        ['await pull(ownerId, token)', "mark('pull:start'); await pull(ownerId, token); mark('pull:confirmed')"],
        ['await setError(ownerId, describeError(cause))', "mark('sync:failed'); await setError(ownerId, describeError(cause))"],
        ['return withAccountSyncLock(ownerId, run)', "mark('lock:waiting'); return withAccountSyncLock(ownerId, run)"],
      ]
      for (const [from, to] of marks) {
        if (!code.includes(from)) throw new Error('Expiry diagnostic source marker missing')
        code = code.replace(from, to)
      }
      return { code: `const mark = (stage: string) => window.dispatchEvent(new CustomEvent('expiry-stage', { detail: stage }));\n${code}`, map: null }
    },
  }

  async function diagnosticSnapshot(page, label) {
    if (!diagnosingExpiry) return
    const state = await page.evaluate(async key => {
      const locks = await navigator.locks.query()
      const kind = lock => lock.name.startsWith('sticky-notes-sync:') ? 'sync' : lock.name.includes('auth-token') ? 'auth' : 'other'
      const session = JSON.parse(localStorage.getItem(key) ?? 'null')
      return { online: navigator.onLine, visibility: document.visibilityState,
        expiresInSeconds: session ? Math.round(session.expires_at - Date.now() / 1000) : null,
        ...window.__expiryProbe.state(),
        heldLocks: locks.held.map(kind), waitingLocks: locks.pending.map(kind),
        events: window.__expiryEvents }
    }, authStorageKey)
    const meta = (await rows(page, 'syncMeta'))[0]
    console.log(`DIAG ${label} ${JSON.stringify({ ...state, pending: (await rows(page, 'outbox')).length,
      confirmed: Boolean(meta?.lastSyncedAt), hasError: Boolean(meta?.lastError) })}`)
  }

  async function requireRefresh(page) {
    // Force the SDK's expiry branch, not a forged JWT or a project-wide expiry change.
    await page.evaluate(key => {
      const session = JSON.parse(localStorage.getItem(key))
      if (!session?.refresh_token) throw new Error('No test session to refresh')
      // Zero is treated as "expiry absent" by getSession(), not as expired.
      session.expires_at = Math.floor(Date.now() / 1000) - 1
      localStorage.setItem(key, JSON.stringify(session))
    }, authStorageKey)
  }

  async function rows(page, store, ownerId = accounts[0].id) {
    return page.evaluate(({ store, ownerId }) => new Promise((resolve, reject) => {
      const request = indexedDB.open('sticky-notes-v1')
      request.onerror = () => reject(new Error('Cannot open test database'))
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(store)
        const query = transaction.objectStore(store).getAll()
        query.onsuccess = () => resolve(query.result.filter(row => row.ownerId === ownerId))
        query.onerror = () => reject(new Error('Cannot read test database'))
        transaction.oncomplete = () => database.close()
      }
    }), { store, ownerId })
  }
  async function login(page, account) {
    await page.getByLabel('邮箱', { exact: true }).fill(account.email)
    await page.getByLabel('密码', { exact: true }).fill(account.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await wait(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  }
  async function openPanel(page) {
    const panel = page.getByRole('dialog', { name: '数据与同步' })
    if (!await panel.isVisible()) await page.getByRole('button', { name: /^数据与同步/ }).click()
    await wait(panel).toBeVisible()
    return panel
  }
  async function closePanel(page) {
    const panel = page.getByRole('dialog', { name: '数据与同步' })
    if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await wait(panel).not.toBeVisible()
  }
  async function sync(page, ownerId = accounts[0].id) {
    const panel = await openPanel(page)
    const before = (await rows(page, 'syncMeta', ownerId))[0]?.lastSyncedAt
    await panel.getByRole('button', { name: '立即重试同步' }).click()
    await wait.poll(async () => {
      const meta = (await rows(page, 'syncMeta', ownerId))[0]
      return Boolean(meta?.lastSyncedAt && meta.lastSyncedAt !== before && !meta.lastError)
    }).toBe(true)
    await wait(panel.getByRole('button', { name: '立即重试同步' })).toBeEnabled()
    await closePanel(page)
  }
  const item = (page, name = title) => page.locator('.note-item').filter({ has: page.getByRole('heading', { name, exact: true }) })
  async function note(page, id) { return (await rows(page, 'notes')).find(row => row.id === id) }
  async function download(page) {
    const panel = await openPanel(page)
    const downloaded = page.waitForEvent('download')
    await panel.getByRole('button', { name: '导出 JSON 备份' }).click()
    const stream = await (await downloaded).createReadStream()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  try {
    if (diagnosingExpiry) restoreBuild = true
    await build(diagnosingExpiry ? { plugins: [diagnosticPlugin] } : {})
    server = await preview({ preview: { host: '127.0.0.1', port: 4186, strictPort: true } })
    const address = 'http://127.0.0.1:4186'
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 960 } })))
    for (const context of contexts) {
      if (diagnosingExpiry) await context.addInitScript(({ origin }) => {
        const events = window.__expiryEvents = []
        const mark = (stage, status) => {
          events.push({ at: Date.now(), stage, ...(status === undefined ? {} : { status }) })
          if (events.length > 60) events.shift()
        }
        window.addEventListener('expiry-stage', event => mark(event.detail))
        window.addEventListener('online', () => mark('network:online'))
        window.addEventListener('offline', () => mark('network:offline'))
        const originalFetch = window.fetch.bind(window)
        window.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href)
          if (url.origin !== origin) return originalFetch(input, init)
          const service = url.pathname.includes('/token') ? 'auth:token' : url.pathname.startsWith('/auth/') ? 'auth:user' : 'data'
          mark(`${service}:request`)
          try { const response = await originalFetch(input, init); mark(`${service}:response`, response.status); return response }
          catch (error) { mark(`${service}:transport-failed`); throw error }
        }
      }, { origin: new URL(projectUrl).origin })
      const page = await context.newPage()
      transportFailures.set(page, [])
      page.on('requestfailed', request => {
        const url = new URL(request.url())
        if (url.origin !== projectUrl) return
        const failures = transportFailures.get(page)
        failures.push({ service: url.pathname.startsWith('/auth/') ? 'auth' : 'data', error: request.failure()?.errorText })
        if (failures.length > 5) failures.shift()
      })
      page.setDefaultTimeout(30_000)
      page.on('dialog', dialog => void dialog.accept())
      pages.push(page)
      await page.goto(address)
    }
    const [a1, a2, b] = pages
    step = 'Sign in via three real browser forms'
    await Promise.all([login(a1, accounts[0]), login(a2, accounts[0]), login(b, accounts[1])])
    await Promise.all([sync(a1), sync(a2), sync(b, accounts[1].id)])
    step = 'Wait for initial PWA install and reload into service-worker control'
    await a1.evaluate(() => navigator.serviceWorker.ready)
    await a1.reload()
    await a1.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    pass('Real email/password forms open isolated account workspaces')

    if (diagnosingExpiry) {
      step = naturalExpiry ? 'Wait for natural JWT expiry while retaining an offline note' : 'Retain offline note for simulated SDK expiry diagnostic'
      const originalExpiry = await a1.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.expires_at, authStorageKey)
      const jwtExpiry = await a1.evaluate(key => {
        const session = JSON.parse(localStorage.getItem(key))
        return JSON.parse(atob(session.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).exp
      }, authStorageKey)
      check(originalExpiry === jwtExpiry, 'Stored expiry differs from the real JWT expiry')
      const deadline = originalExpiry * 1000 + 3_000
      check(Number.isFinite(deadline) && deadline > Date.now() && deadline - Date.now() < 7_200_000, 'Expected a real session expiring within two hours')
      await contexts[0].setOffline(true)
      await a1.getByTitle('新建便签', { exact: true }).click()
      await a1.getByLabel('便签标题', { exact: true }).fill(title)
      await a1.getByLabel('便签正文', { exact: true }).fill('自然到期期间离线保存的正文。')
      await wait.poll(async () => (await rows(a1, 'notes')).find(row => row.title === title)?.plainText).toBe('自然到期期间离线保存的正文。')
      const pendingId = (await rows(a1, 'notes')).find(row => row.title === title).id
      if (expiryDiagnostic) {
        // Short reproduction of the SDK refresh-failure path; NOT natural JWT expiry.
        await requireRefresh(a1)
        step = 'Reproduce an offline SDK refresh failure (simulated expiry metadata)'
        check(!(await a1.evaluate(() => window.__expiryProbe.refresh())).ok, 'Offline refresh unexpectedly succeeded')
        await diagnosticSnapshot(a1, 'offline-refresh-failed')
      }
      if (naturalExpiry) {
      console.log(`WAIT Natural expiry until ${new Date(deadline).toISOString()}; no session values or credentials logged`)
      let nextReport = Date.now() + 300_000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, deadline - Date.now())))
        check(!a1.isClosed(), 'Natural-expiry browser closed unexpectedly')
        if (Date.now() >= nextReport) {
          console.log(`WAIT Natural expiry: ${Math.max(0, Math.ceil((deadline - Date.now()) / 60_000))} minutes remaining`)
          nextReport = Date.now() + 300_000
        }
      }
      }
      await wait(a1.getByLabel('便签正文', { exact: true })).toHaveText('自然到期期间离线保存的正文。')
      check((await rows(a1, 'outbox')).some(row => row.entityId === pendingId), 'Natural expiry removed the offline queue')
      step = 'Reconnect and verify a new session after the SDK refresh cooldown'
      transportFailures.set(a1, [])
      const beforeSync = (await rows(a1, 'syncMeta'))[0]?.lastSyncedAt
      const reconnectedAt = Date.now()
      await contexts[0].setOffline(false)
      await a1.evaluate(() => window.dispatchEvent(new Event('focus')))
      await diagnosticSnapshot(a1, 'reconnected')
      // auth-js 2.117.1 caches refresh failures for 60s and ticks every 30s.
      // Observe that separate phase, then require prompt AUTOMATIC upload; no manual retry.
      await expect.poll(() => a1.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.expires_at, authStorageKey), { timeout: 120_000 }).toBeGreaterThan(originalExpiry)
      const refreshedAt = Date.now()
      await diagnosticSnapshot(a1, 'session-refreshed')
      step = 'Verify automatic upload and status confirmation within 10s of the new session'
      await expect.poll(async () => {
        const meta = (await rows(a1, 'syncMeta'))[0]
        return (await rows(a1, 'outbox')).length === 0
          && Boolean(meta?.lastSyncedAt && meta.lastSyncedAt !== beforeSync && !meta.lastError)
      }, { timeout: 10_000 }).toBe(true)
      console.log(`DIAG recovery timing: refresh=${refreshedAt - reconnectedAt}ms; automatic upload/confirmation=${Date.now() - refreshedAt}ms`)
      await sync(a2)
      step = 'Verify naturally expired offline edit on the second browser'
      await wait.poll(async () => (await note(a2, pendingId))?.plainText).toBe('自然到期期间离线保存的正文。')
      pass(`${naturalExpiry ? 'Natural JWT expiry' : 'Simulated expiry metadata'} retains offline edits; reconnect refreshes the session and synchronizes to another browser`)
      await diagnosticSnapshot(a1, naturalExpiry ? 'natural-expiry-pass' : 'simulated-expiry-pass')
      return
    }

    step = 'Create through UI and exchange the note between browsers'
    await a1.getByTitle('新建便签', { exact: true }).click()
    await a1.getByLabel('便签标题', { exact: true }).fill(title)
    await a1.getByLabel('便签正文', { exact: true }).click()
    await a1.getByLabel('便签正文', { exact: true }).evaluate((element, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      clipboardData.setData('text/html', '<p>来自网页的排版</p>')
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, initialText)
    await wait.poll(async () => (await rows(a1, 'notes')).find(row => row.title === title)?.plainText).toBe(initialText)
    const noteId = (await rows(a1, 'notes')).find(row => row.title === title).id
    await sync(a1)
    await sync(a2)
    await item(a2).click()
    await wait(a2.getByLabel('便签正文', { exact: true })).toContainText('真实网页登录后的第一段正文。')
    await wait(a2.getByLabel('便签正文', { exact: true })).toContainText('<div>按原样保存</div> &amp;  **星号**')
    check((await note(a2, noteId))?.plainText === initialText, 'Pasted whitespace changed in the second browser')
    check(JSON.stringify((await note(a2, noteId))?.doc) === JSON.stringify((await note(a1, noteId))?.doc), 'Pasted document changed during synchronization')
    await sync(b, accounts[1].id)
    await wait(item(b)).toHaveCount(0)
    check((await rows(b, 'notes', accounts[0].id)).length === 0, 'Other account leaked into browser storage')
    pass('UI pasted text reaches the second browser unchanged; another account cannot see it')

    step = 'Reorder, rename, move and delete folders through the UI on a real account'
    for (const name of ['云端甲', '云端乙', '云端丙']) {
      await a1.getByTitle('新建文件夹').click()
      await a1.getByLabel('新文件夹名称').fill(name)
      await a1.locator('.folder-create-form button[type="submit"]').click()
      await wait.poll(async () => (await rows(a1, 'folders')).some(row => row.name === name)).toBe(true)
    }
    const folderRows = await rows(a1, 'folders')
    const firstFolder = folderRows.find(row => row.name === '云端甲')
    const thirdFolder = folderRows.find(row => row.name === '云端丙')
    check(firstFolder && thirdFolder, 'Created folders missing locally')
    await a1.locator('.folder-item:not(.system-folder)').filter({ hasText: '云端丙' }).getByTitle('上移文件夹').click()
    await wait.poll(async () => (await rows(a1, 'folders')).find(row => row.id === thirdFolder.id)?.sortOrder).toBe(1)
    const renamed = a1.locator('.folder-item:not(.system-folder)').filter({ hasText: '云端丙' })
    await renamed.getByTitle('重命名').click()
    await a1.getByLabel('重命名文件夹').fill('云端新分类')
    await a1.getByTitle('保存文件夹名称').click()
    await wait.poll(async () => (await rows(a1, 'folders')).find(row => row.id === thirdFolder.id)?.name).toBe('云端新分类')
    await item(a1).getByRole('combobox', { name: `移动便签 ${title} 到文件夹` }).selectOption(thirdFolder.id)
    await wait.poll(async () => (await note(a1, noteId))?.folderId).toBe(thirdFolder.id)
    await sync(a1)
    await sync(a2)
    check((await rows(a2, 'folders')).filter(row => !row.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder).map(row => row.name).join(',') === '云端甲,云端新分类,云端乙', 'Folder order or name did not reach the second browser')
    check((await note(a2, noteId))?.folderId === thirdFolder.id, 'Moved note did not reach the second browser')
    await a1.locator('.folder-item:not(.system-folder)').filter({ hasText: '云端新分类' }).getByTitle('删除文件夹').click()
    await wait.poll(async () => (await note(a1, noteId))?.folderId).toBeNull()
    await sync(a1)
    await sync(a2)
    check((await rows(a2, 'folders')).find(row => row.id === thirdFolder.id)?.deletedAt, 'Folder deletion did not reach the second browser')
    check((await note(a2, noteId))?.folderId === null && (await note(a2, noteId))?.deletedAt === null, 'Deleting a folder lost or hid its note')
    pass('Folder reorder, rename and deletion synchronize while keeping the note in All Notes')

    step = 'Move an older offline edit into a newer offline folder and synchronize both'
    await contexts[0].setOffline(true)
    const moveNote = page => item(page).getByRole('combobox', { name: `移动便签 ${title} 到文件夹` })
    await moveNote(a1).selectOption(firstFolder.id)
    await wait.poll(async () => (await rows(a1, 'outbox')).some(row => row.entityId === noteId)).toBe(true)
    await a1.getByTitle('新建文件夹').click()
    await a1.getByLabel('新文件夹名称').fill('离线新分类')
    await a1.locator('.folder-create-form button[type="submit"]').click()
    await wait.poll(async () => (await rows(a1, 'folders')).some(row => row.name === '离线新分类')).toBe(true)
    const offlineFolder = (await rows(a1, 'folders')).find(row => row.name === '离线新分类')
    await moveNote(a1).selectOption(offlineFolder.id)
    await wait.poll(async () => (await note(a1, noteId))?.folderId).toBe(offlineFolder.id)
    await contexts[0].setOffline(false)
    await sync(a1)
    await sync(a2)
    check((await rows(a1, 'outbox')).length === 0, 'New folder dependency left a rejected or pending note')
    check((await note(a2, noteId))?.folderId === offlineFolder.id && (await note(a2, noteId))?.plainText === initialText, 'New folder move did not preserve and synchronize the note')
    pass('An older queued note waits for its newly selected folder and reaches the second browser')

    step = 'Recover an unsynced note after another device deletes its folder'
    await contexts[0].setOffline(true)
    const repairTitle = `受阻便签-${runId.slice(0, 8)}`
    const repairText = '这条尚无云端历史的便签，修复后正文必须保留。'
    await a1.getByTitle('新建便签', { exact: true }).click()
    await a1.getByLabel('便签标题', { exact: true }).fill(repairTitle)
    await a1.getByLabel('便签正文', { exact: true }).fill(repairText)
    await wait.poll(async () => (await rows(a1, 'notes')).find(row => row.title === repairTitle)?.plainText).toBe(repairText)
    const repairId = (await rows(a1, 'notes')).find(row => row.title === repairTitle).id
    await item(a1, repairTitle).getByRole('combobox', { name: `移动便签 ${repairTitle} 到文件夹` }).selectOption(offlineFolder.id)
    await wait.poll(async () => (await note(a1, repairId))?.folderId).toBe(offlineFolder.id)
    await a2.locator('.folder-item:not(.system-folder)').filter({ hasText: '离线新分类' }).getByTitle('删除文件夹').click()
    await sync(a2)
    await contexts[0].setOffline(false)
    await wait.poll(async () => (await rows(a1, 'outbox')).length).toBe(0)
    await sync(a2)
    check((await note(a1, repairId))?.folderId === null && (await note(a2, repairId))?.folderId === null, 'Folder repair did not reach both browsers')
    check((await note(a1, repairId))?.plainText === repairText && (await note(a2, repairId))?.plainText === repairText, 'Folder repair changed the note body')
    await item(a1).click()
    pass('Deleted-folder recovery keeps the body, clears the queue and reaches the second browser')

    step = 'Reload and edit while online but Auth returns 503'
    const authApi = `${projectUrl}/auth/v1/**`
    const blockedDataApi = `${projectUrl}/rest/v1/**`
    let authFailures = 0
    await contexts[0].route(authApi, route => {
      authFailures += 1
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Temporary test outage"}' })
    })
    await contexts[0].route(blockedDataApi, route => route.abort())
    await a1.reload()
    // The folder-repair scenario added a newer note; reload selects it by default.
    await item(a1).click()
    check(await a1.evaluate(() => navigator.onLine), 'Outage check must leave browser online')
    await wait(a1.getByLabel('便签正文', { exact: true })).toContainText('真实网页登录后的第一段正文。')
    await wait(a1.getByLabel('便签正文', { exact: true })).toContainText('<div>按原样保存</div> &amp;  **星号**')
    await wait.poll(() => authFailures).toBeGreaterThan(0)
    await a1.getByLabel('便签正文', { exact: true }).fill('认证服务临时不可达，本机仍能保存。')
    await wait.poll(async () => (await note(a1, noteId))?.plainText).toBe('认证服务临时不可达，本机仍能保存。')
    check((await rows(a1, 'outbox')).some(row => row.entityId === noteId), 'Auth outage lost the upload queue')
    await a1.reload()
    await wait(a1.getByLabel('便签正文', { exact: true })).toHaveText('认证服务临时不可达，本机仍能保存。')
    await a1.getByLabel('便签正文', { exact: true }).fill(initialText)
    await wait.poll(async () => (await note(a1, noteId))?.plainText).toBe(initialText)
    await contexts[0].unroute(authApi)
    await contexts[0].unroute(blockedDataApi)
    await a1.evaluate(() => window.dispatchEvent(new Event('focus')))
    await sync(a1)
    await sync(a2)
    pass('Online Auth outage permits local edits/reload, keeps the queue and recovers synchronization')

    step = 'Refresh a real browser session through the SDK expiry branch'
    await requireRefresh(b)
    const refreshed = b.waitForResponse(response => response.url().startsWith(`${projectUrl}/auth/v1/token?`) && response.status() === 200)
    await b.reload()
    await refreshed
    await wait(b.getByRole('button', { name: '退出登录' })).toBeVisible()
    await sync(b, accounts[1].id)
    pass('SDK expiry branch obtains a fresh real session and resumes sync (not a wall-clock JWT expiry test)')

    step = 'Edit both copies offline and reload the production PWA'
    await item(a2).click()
    await Promise.all([contexts[0].setOffline(true), contexts[1].setOffline(true)])
    await a1.getByLabel('便签正文', { exact: true }).fill(textOne)
    await a2.getByLabel('便签正文', { exact: true }).fill(textTwo)
    await wait.poll(async () => (await note(a1, noteId))?.plainText).toBe(textOne)
    await wait.poll(async () => (await note(a2, noteId))?.plainText).toBe(textTwo)
    await a1.reload()
    await wait(a1.getByLabel('便签正文', { exact: true })).toHaveText(textOne)
    check((await rows(a1, 'outbox')).some(row => row.entityId === noteId), 'Offline upload queue disappeared')
    pass('Offline edit survives production-PWA reload with its pending upload')

    step = 'Reconnect independently and inspect both conflict versions'
    await contexts[0].setOffline(false)
    await sync(a1)
    await contexts[1].setOffline(false)
    await sync(a2)
    await wait.poll(async () => (await rows(a2, 'conflicts')).filter(row => row.entityId === noteId).length).toBe(1)
    const conflictPanel = await openPanel(a2)
    await conflictPanel.getByText('查看本机版本', { exact: true }).click()
    await conflictPanel.getByText('查看云端版本', { exact: true }).click()
    await wait(conflictPanel.locator('pre').filter({ hasText: textTwo })).toBeVisible()
    await wait(conflictPanel.locator('pre').filter({ hasText: textOne })).toBeVisible()
    await wait(conflictPanel.getByRole('button', { name: '清除本机数据并退出' })).toBeDisabled()
    const backup = await download(a2)
    const archive = JSON.parse(backup.toString('utf8'))
    check(archive.notes.some(row => row.id === noteId && row.plainText === textTwo), 'Backup omitted local conflict content')
    check(archive.conflicts.some(row => row.entityId === noteId && row.remote.plainText === textOne), 'Backup omitted remote conflict content')
    pass('Conflict UI and downloaded backup retain both edits; clearing is blocked')

    step = 'Choose local conflict version and propagate the explicit resolution'
    await conflictPanel.getByRole('button', { name: '保留本机版本' }).click()
    await wait.poll(async () => (await rows(a2, 'conflicts')).length).toBe(0)
    await wait.poll(async () => (await rows(a2, 'outbox')).length).toBe(0)
    await closePanel(a2)
    await sync(a1)
    await wait.poll(async () => (await note(a1, noteId))?.plainText).toBe(textTwo)
    await wait(a1.getByLabel('便签正文', { exact: true })).toHaveText(textTwo)
    pass('Explicit conflict choice synchronizes without silently discarding the other version')

    step = 'Restore a confirmed historical version through UI'
    const history = (await rows(a2, 'history')).find(row => row.noteId === noteId && row.snapshot.plainText === initialText)
    check(history, 'Initial confirmed history missing')
    const historyPanel = await openPanel(a2)
    await historyPanel.locator('.panel-card').filter({ hasText: new RegExp(`版本 ${history.serverVersion}(?!\\d)`) }).getByRole('button', { name: '恢复', exact: true }).click()
    await wait.poll(async () => (await note(a2, noteId))?.plainText).toBe(initialText)
    await closePanel(a2)
    await sync(a2)
    await sync(a1)
    await wait.poll(async () => (await note(a1, noteId))?.plainText).toBe(initialText)
    pass('History restore creates and synchronizes a new current version')

    step = 'Delete and restore through the real recycle-bin UI'
    await item(a1).getByTitle('移入回收站', { exact: true }).click()
    await wait.poll(async () => Boolean((await note(a1, noteId))?.deletedAt)).toBe(true)
    await sync(a1)
    await sync(a2)
    await wait(item(a2)).toHaveCount(0)
    await a2.locator('.folder-item').filter({ hasText: /^回收站$/ }).click()
    await item(a2).getByTitle('恢复', { exact: true }).click()
    await wait.poll(async () => (await note(a2, noteId))?.deletedAt).toBe(null)
    await sync(a2)
    await sync(a1)
    await wait(item(a1)).toBeVisible()
    pass('Recycle-bin delete and restore propagate to the other browser')

    step = 'Sign out while offline with a saved but unsynced note'
    await contexts[0].setOffline(true)
    const draftTitle = `尚未上传-${runId.slice(0, 8)}`
    await a1.getByTitle('新建便签', { exact: true }).click()
    await a1.getByLabel('便签标题', { exact: true }).fill(draftTitle)
    await a1.getByLabel('便签正文', { exact: true }).fill('普通退出必须保留这条本地草稿。')
    await wait.poll(async () => (await rows(a1, 'notes')).find(row => row.title === draftTitle)?.plainText).toBe('普通退出必须保留这条本地草稿。')
    const draftId = (await rows(a1, 'notes')).find(row => row.title === draftTitle).id
    await a1.getByRole('button', { name: '退出登录' }).click()
    await wait(a1.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await a1.reload()
    await wait(a1.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    check((await rows(a1, 'outbox')).some(row => row.entityId === draftId), 'Sign-out removed the upload queue')
    await contexts[0].setOffline(false)
    await a1.reload()
    await wait(a1.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await login(a1, accounts[1])
    await sync(a1, accounts[1].id)
    await wait(item(a1, draftTitle)).toHaveCount(0)
    check((await note(a1, draftId))?.title === draftTitle, 'Account switch removed previous local data')
    const unsynced = await readClient.from('notes').select('id').eq('id', draftId)
    check(!unsynced.error && unsynced.data.length === 0, 'Previous account queue uploaded while signed in as another account')
    await a1.getByRole('button', { name: '退出登录' }).click()
    await login(a1, accounts[0])
    await sync(a1)
    await sync(a2)
    await a2.locator('.folder-item').filter({ hasText: /^全部便签$/ }).click()
    await wait(item(a2, draftTitle)).toBeVisible()
    pass('Offline logout stays locked across reloads; account switching preserves and isolates pending data')

    step = 'Clear one browser and verify sibling tabs stay locked while cloud data survives'
    const sibling = await contexts[0].newPage()
    pages.push(sibling)
    await sibling.goto(address)
    step = 'New sibling tab opens cached workspace before device clear'
    await wait(sibling.getByRole('button', { name: '退出登录' })).toBeVisible()
    const clearPanel = await openPanel(a1)
    await clearPanel.getByRole('button', { name: '清除本机数据并退出' }).click()
    step = 'Device clear locks its initiating tab'
    await wait(a1.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    step = 'Device clear locks its sibling tab'
    await wait(sibling.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    check((await rows(a1, 'notes')).length === 0 && (await rows(a1, 'outbox')).length === 0, 'Device clear left account rows behind')
    await sibling.reload()
    step = 'Cleared sibling stays locked after reload'
    await wait(sibling.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await sync(a2)
    await wait(item(a2, draftTitle)).toBeVisible()
    step = 'Explicit sign-in after device clear restores workspace'
    await login(a1, accounts[0])
    await sync(a1)
    await wait(item(a1, draftTitle)).toBeVisible()
    pass('Device clear locks same-origin tabs; explicit login restores the unchanged cloud copy')

    step = 'Restore the conflict backup into a fresh browser while cloud data requests are unavailable'
    const recoveryContext = await browser.newContext({ viewport: { width: 1440, height: 960 } })
    const dataApi = `${projectUrl}/rest/v1/**`
    // Authentication remains real and available; only data requests simulate an outage.
    await recoveryContext.route(dataApi, route => route.abort('internetdisconnected'))
    const recovery = await recoveryContext.newPage()
    pages.push(recovery)
    recovery.setDefaultTimeout(30_000)
    recovery.on('dialog', dialog => void dialog.accept())
    await recovery.goto(address)
    await login(recovery, accounts[0])
    check((await rows(recovery, 'notes')).length === 0, 'Recovery browser did not start empty')
    const recoveryPanel = await openPanel(recovery)
    const upload = { name: 'temporary-conflict-backup.json', mimeType: 'application/json', buffer: backup }
    await recoveryPanel.locator('input[type="file"]').setInputFiles(upload)
    await wait(recoveryPanel.getByText(new RegExp(`^预览：${archive.notes.length} 条便签`))).toBeVisible()
    await recoveryPanel.getByRole('button', { name: '确认导入', exact: true }).click()
    await wait.poll(async () => (await note(recovery, noteId))?.plainText).toBe(textTwo)
    await wait(recoveryPanel.getByRole('button', { name: '确认导入', exact: true })).not.toBeVisible()
    const restoredNotes = await rows(recovery, 'notes')
    check(restoredNotes.some(row => row.title.endsWith('（冲突副本）') && row.plainText === textOne), 'Remote conflict snapshot missing after recovery')
    check((await rows(recovery, 'history')).some(row => row.noteId === noteId), 'History missing after recovery')
    await recoveryPanel.locator('input[type="file"]').setInputFiles(upload)
    await recoveryPanel.getByRole('button', { name: '确认导入', exact: true }).click()
    await wait(recoveryPanel.getByRole('button', { name: '确认导入', exact: true })).not.toBeVisible()
    check((await rows(recovery, 'notes')).length === restoredNotes.length, 'Repeated restore duplicated notes')
    await recoveryContext.unroute(dataApi)
    await closePanel(recovery)
    await sync(recovery)
    await wait.poll(async () => (await rows(recovery, 'conflicts')).some(row => row.entityId === noteId)).toBe(true)
    check((await note(recovery, noteId))?.plainText === textTwo, 'Reconnection silently overwrote the imported draft')
    const unchanged = await readClient.from('notes').select('plain_text').eq('id', noteId).single()
    check(!unchanged.error && unchanged.data.plain_text === initialText, 'Restore overwrote the newer cloud state without conflict resolution')
    pass('Fresh-browser backup restore preserves IDs, both conflict texts and history; reimport deduplicates and reconnection conflicts safely')

    step = 'Revoke only test-account B browser session while it has an unsynced note'
    await contexts[2].route(blockedDataApi, route => route.abort())
    await b.getByTitle('新建便签', { exact: true }).click()
    const pendingTitle = `失效会话保留-${runId.slice(0, 8)}`
    await b.getByLabel('便签标题', { exact: true }).fill(pendingTitle)
    await b.getByLabel('便签正文', { exact: true }).fill('会话失效及账号禁用都不能删除这段未上传内容。')
    await wait.poll(async () => (await rows(b, 'notes', accounts[1].id)).some(row => row.title === pendingTitle && row.plainText.includes('未上传内容'))).toBe(true)
    const pendingNoteId = (await rows(b, 'notes', accounts[1].id)).find(row => row.title === pendingTitle).id
    // Only this disposable context's token moves between test processes; never log/store it.
    await revokeTestSession(await b.evaluate(key => JSON.parse(localStorage.getItem(key)).access_token, authStorageKey))
    await requireRefresh(b)
    await b.reload()
    await wait(b.getByRole('heading', { name: '欢迎使用' })).toBeVisible()
    check((await rows(b, 'outbox', accounts[1].id)).some(row => row.entityId === pendingNoteId), 'Revoked session lost the local queue')
    await contexts[2].setOffline(true)
    await b.reload()
    await wait(b.getByRole('heading', { name: '欢迎使用' })).toBeVisible()
    await contexts[2].setOffline(false)
    await login(b, accounts[1])
    await wait(b.getByLabel('便签正文', { exact: true })).toHaveText('会话失效及账号禁用都不能删除这段未上传内容。')
    pass('Server-revoked session locks the app, stays locked offline and preserves unsynced content for re-login')

    step = 'Ban temporary account B and verify live background account check'
    await setTestAccountBBan(true)
    await b.evaluate(() => window.dispatchEvent(new Event('focus')))
    await wait(b.getByRole('heading', { name: '欢迎使用' })).toBeVisible()
    check((await rows(b, 'outbox', accounts[1].id)).some(row => row.entityId === pendingNoteId), 'Banned account lost the local queue')
    await b.getByLabel('邮箱', { exact: true }).fill(accounts[1].email)
    await b.getByLabel('密码', { exact: true }).fill(accounts[1].password)
    await b.getByRole('button', { name: '登录', exact: true }).click()
    await wait(b.getByRole('alert')).toContainText(/banned/i)
    await setTestAccountBBan(false)
    await login(b, accounts[1])
    await contexts[2].unroute(blockedDataApi)
    await sync(b, accounts[1].id)
    await wait.poll(async () => (await rows(b, 'outbox', accounts[1].id)).length).toBe(0)
    pass('Banned account is locked and cannot sign in; after unbanning, its untouched local queue synchronizes')

    step = 'Prepare two same-origin tabs with an unsynced note and a failed editor draft'
    await contexts[0].route(dataApi, route => route.abort())
    await closePanel(a1)
    // This tab was intentionally locked by the earlier device-clear test.
    await sibling.reload()
    await wait.poll(async () => await sibling.getByRole('heading', { name: '欢迎使用' }).isVisible() ||
      await sibling.getByRole('button', { name: '退出登录' }).isVisible()).toBe(true)
    if (await sibling.getByRole('heading', { name: '欢迎使用' }).isVisible()) await login(sibling, accounts[0])
    await wait(sibling.getByRole('button', { name: '退出登录' })).toBeVisible()
    await sibling.evaluate(() => navigator.serviceWorker.ready)
    await sibling.reload()
    await sibling.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    const upgradeTitle = `升级待上传-${runId.slice(0, 8)}`
    const upgradeText = '应用更新后，这条尚未上传的正文仍需完整保留。'
    await a1.getByTitle('新建便签', { exact: true }).click()
    await a1.getByLabel('便签标题', { exact: true }).fill(upgradeTitle)
    await a1.getByLabel('便签正文', { exact: true }).fill(upgradeText)
    await wait.poll(async () => (await rows(a1, 'notes')).find(row => row.title === upgradeTitle)?.plainText).toBe(upgradeText)
    const upgradeId = (await rows(a1, 'notes')).find(row => row.title === upgradeTitle).id
    await sibling.getByTitle('新建便签', { exact: true }).click()
    await sibling.getByLabel('便签标题', { exact: true }).fill(`升级失败草稿-${runId.slice(0, 8)}`)
    await sibling.getByLabel('便签正文', { exact: true }).fill('尚未发生错误时的原文。')
    await wait(sibling.locator('.save-status')).toContainText('本地已保存')
    // Fail one actual IndexedDB write in this disposable browser, not a mocked React guard.
    await sibling.evaluate(() => {
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'notes') {
          IDBObjectStore.prototype.put = original
          throw new DOMException('Test storage failure', 'QuotaExceededError')
        }
        return original.apply(this, args)
      }
    })
    const failedDraft = '另一窗口更新时，不能丢失这段尚未保存的草稿。'
    await sibling.getByLabel('便签正文', { exact: true }).fill(failedDraft)
    await wait(sibling.locator('.save-status')).toHaveText('本地未保存')
    const beforeOtherAccount = await rows(a1, 'notes', accounts[1].id)
    check(beforeOtherAccount.length > 0, 'Upgrade check needs another account cache')
    const beforeHistory = await rows(a1, 'history')
    check(beforeHistory.length > 0, 'Upgrade check needs confirmed history')
    const beforeQueue = (await rows(a1, 'outbox')).filter(row => row.entityId === upgradeId)
    check(beforeQueue.length > 0, 'Upgrade check needs a pending note')
    const oldScript = await a1.locator('script[type="module"]').first().getAttribute('src')

    step = 'Install a new PWA build without changing real authentication or database schema'
    // Change only a test-only bundle marker. Auth and application code stay identical;
    // this checks real SW replacement, not compatibility with a future schema migration.
    restoreBuild = true
    await build({ plugins: [{ name: 'cloud-upgrade-test-marker', enforce: 'pre',
      transform(code, id) {
        if (id.replaceAll('\\', '/').endsWith('/src/main.tsx')) {
          return { code: `document.documentElement.dataset.testBuild = ${JSON.stringify(runId)};\n${code}`, map: null }
        }
      }
    }] })
    await a1.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration) throw new Error('Missing test service worker')
      await registration.update()
    })
    const update = page => page.getByRole('button', { name: '更新并刷新', exact: true })
    await wait(update(a1)).toBeVisible()
    await wait(update(sibling)).toBeVisible()
    await update(sibling).click()
    await wait(sibling.getByText('便签有未保存草稿，请先另存或复制草稿文本', { exact: true })).toBeVisible()

    step = 'Update one tab while the other retains its failed draft without a reload dialog'
    let forcedDraftReloads = 0
    sibling.removeAllListeners('dialog')
    sibling.on('dialog', dialog => { if (dialog.type() === 'beforeunload') forcedDraftReloads++; void dialog.accept() })
    step = 'Wait for the initiating tab to load the updated PWA'
    await Promise.all([a1.waitForEvent('load'), update(a1).click()])
    await wait.poll(() => a1.evaluate(() => document.documentElement.dataset.testBuild)).toBe(runId)
    check(await a1.locator('script[type="module"]').first().getAttribute('src') !== oldScript, 'PWA kept its old entry bundle')
    step = 'Verify the other tab did not refresh away its failed draft'
    await wait(sibling.getByLabel('便签正文', { exact: true })).toHaveText(failedDraft)
    await wait(sibling.locator('.save-status')).toHaveText('本地未保存')
    check(forcedDraftReloads === 0, 'Other-tab activation tried to reload an unsaved draft')
    await sibling.getByRole('button', { name: '另存为新便签', exact: true }).click()
    await wait(sibling.locator('.save-status')).toContainText('本地已保存')
    step = 'Explicitly refresh the previously deferred tab after saving its draft copy'
    await Promise.all([sibling.waitForEvent('load'), update(sibling).click()])
    await wait.poll(() => sibling.evaluate(() => document.documentElement.dataset.testBuild)).toBe(runId)
    pass('Cross-tab PWA activation preserves a failed draft; explicit recovery then permits updating')

    step = 'Check offline storage and real synchronization after the PWA upgrade'
    await contexts[0].setOffline(true)
    await Promise.all([a1.reload(), sibling.reload()])
    await wait(a1.getByRole('button', { name: '退出登录' })).toBeVisible()
    await wait(sibling.getByRole('button', { name: '退出登录' })).toBeVisible()
    check((await note(a1, upgradeId))?.plainText === upgradeText, 'PWA upgrade lost the unsynced note')
    check((await rows(a1, 'notes')).some(row => row.plainText === failedDraft), 'PWA upgrade lost the recovered draft')
    const afterQueue = await rows(a1, 'outbox')
    check(beforeQueue.every(row => afterQueue.some(next => next.id === row.id && JSON.stringify(next.payload) === JSON.stringify(row.payload))), 'PWA upgrade changed a pending mutation')
    check(JSON.stringify(await rows(a1, 'notes', accounts[1].id)) === JSON.stringify(beforeOtherAccount), 'PWA upgrade altered another account cache')
    const afterHistory = await rows(a1, 'history')
    check(beforeHistory.every(row => afterHistory.some(next => next.id === row.id && JSON.stringify(next.snapshot) === JSON.stringify(row.snapshot))), 'PWA upgrade lost confirmed history')
    await contexts[0].unroute(dataApi)
    await contexts[0].setOffline(false)
    await sync(a1)
    await sync(a2)
    await wait(item(a2, upgradeTitle)).toBeVisible()
    const upgradedCloud = await readClient.from('notes').select('plain_text').eq('id', upgradeId).single()
    check(!upgradedCloud.error && upgradedCloud.data.plain_text === upgradeText, 'Upgraded queue did not reach the real cloud')
    pass('Real-account PWA upgrade retains offline notes, queue, history and account caches, then synchronizes')
  } catch (error) {
    console.error(`FAIL UI ${step} (${error instanceof Error ? error.name : 'unknown'}). No credentials or request details logged.`)
    if (error instanceof Error) {
      let summary = error.message.split('\n')[0]
      for (const account of accounts) summary = summary.replaceAll(account.password, '[redacted]').replaceAll(account.email, '[test account]')
      console.error(summary.slice(0, 250))
    }
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]
      if (!page.isClosed()) {
        const state = await page.evaluate(() => ({ ready: document.readyState, upgraded: Boolean(document.documentElement.dataset.testBuild),
          save: document.querySelector('.save-status')?.textContent ?? null })).catch(() => null)
        console.error(`UI ${index}: workspace=${await page.locator('.app-layout').isVisible().catch(() => false)} login=${await page.getByRole('heading', { name: '欢迎使用' }).isVisible().catch(() => false)} state=${JSON.stringify(state)}`)
        console.error(`UI ${index} transport failures: ${JSON.stringify(transportFailures.get(page) ?? [])}`)
        await diagnosticSnapshot(page, `failure-browser-${index}`).catch(() => {})
      }
      if (!page.isClosed() && await page.locator('.app-layout').isVisible().catch(() => false)) {
        await page.screenshot({ path: `test-results/cloud-ui-failure-${index}.png`, fullPage: true }).catch(() => {})
      }
    }
    throw new Error('Cloud browser checks failed; see the named UI step')
  } finally {
    try {
      await browser?.close()
      if (server) await new Promise(resolve => server.httpServer.close(resolve))
    } finally {
      if (restoreBuild) await build()
    }
  }
}
