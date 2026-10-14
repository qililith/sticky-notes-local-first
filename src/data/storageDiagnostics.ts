type StorageDiagnosticEvent = {
  at: string
  event: 'open-start' | 'open-ok' | 'open-timeout' | 'save-timeout' | 'save-retry-ok' | 'save-retry-failed'
  source: 'startup' | 'save' | 'manual'
  elapsedMs?: number
}

const STORAGE_KEY = 'sticky-notes-storage-diagnostics'
const MAX_EVENTS = 20

function readEvents(): StorageDiagnosticEvent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item === 'object' && typeof item.at === 'string' && typeof item.event === 'string').slice(-MAX_EVENTS) as StorageDiagnosticEvent[]
  } catch { return [] }
}

export function recordStorageDiagnostic(event: StorageDiagnosticEvent['event'], source: StorageDiagnosticEvent['source'], elapsedMs?: number): void {
  try {
    const events = [...readEvents(), { at: new Date().toISOString(), event, source, ...(elapsedMs === undefined ? {} : { elapsedMs: Math.round(elapsedMs) }) }].slice(-MAX_EVENTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  } catch { /* Diagnostics must never block notes. */ }
}

export function storageDiagnosticReport(): string {
  const eventLabels: Record<StorageDiagnosticEvent['event'], string> = {
    'open-start': '开始重连本机数据库',
    'open-ok': '本机数据库重连成功',
    'open-timeout': '本机数据库重连超时',
    'save-timeout': '本机保存超过 2 秒',
    'save-retry-ok': '重连后保存成功',
    'save-retry-failed': '重连后保存仍失败'
  }
  const lines = readEvents().map(item => `${item.at} | ${item.source} | ${eventLabels[item.event]}${item.elapsedMs === undefined ? '' : ` | ${item.elapsedMs}ms`}`)
  return [`页面：${location.href}`, `浏览器：${navigator.userAgent}`, ...lines].join('\n')
}
