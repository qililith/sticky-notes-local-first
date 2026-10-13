import type { Revision } from './types'

export const HISTORY_PAGE_SIZE = 20

export function sortHistoryNewestFirst(items: Revision[]): Revision[] {
  return [...items].sort((left, right) => right.serverVersion - left.serverVersion || left.id.localeCompare(right.id))
}

export function pageHistory(items: Revision[], page = 0, pageSize = HISTORY_PAGE_SIZE): Revision[] {
  return sortHistoryNewestFirst(items).slice(page * pageSize, (page + 1) * pageSize)
}

export function historyCloudTime(item: Revision): string {
  return item.snapshot.updatedAt || item.createdAt
}

export function historyPreview(item: Revision, limit = 80): string {
  const text = item.snapshot.plainText.replace(/\s+/g, ' ').trim()
  if (!text) return item.snapshot.title.trim() || '无内容'
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
