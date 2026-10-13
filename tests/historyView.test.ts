import { expect, it } from 'vitest'
import { HISTORY_PAGE_SIZE, historyCloudTime, historyPreview, pageHistory, sortHistoryNewestFirst } from '../src/data/historyView'
import { emptyDocument, type Note, type Revision } from '../src/data/types'

function revision(version: number, receivedAt: string): Revision {
  const snapshot: Note = {
    id: 'note-a', ownerId: 'account-a', title: `第 ${version} 版`, doc: emptyDocument, docVersion: 1,
    plainText: `正文 ${version}`, folderId: null, isPinned: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-09-${String(version).padStart(2, '0')}T12:00:00.000Z`,
    deletedAt: null, localRev: version, serverVersion: version, confirmedRev: version
  }
  return {
    id: `account-a:note-a:${version}`, ownerId: 'account-a', noteId: 'note-a',
    serverVersion: version, snapshot, createdAt: receivedAt
  }
}

it('shows the newest 20 versions first when 25 exist', () => {
  const items = Array.from({ length: 25 }, (_, index) => revision(index + 1, '2026-10-13T00:00:00.000Z'))
  const firstPage = pageHistory(items, 0)
  const secondPage = pageHistory(items, 1)
  expect(firstPage.map(item => item.serverVersion)).toEqual(Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => 25 - index))
  expect(secondPage.map(item => item.serverVersion)).toEqual([5, 4, 3, 2, 1])
  expect(firstPage.some(item => item.serverVersion <= 5)).toBe(false)
  expect(sortHistoryNewestFirst(items)[0].serverVersion).toBe(25)
})

it('uses the cloud snapshot time, not the local receive time', () => {
  const item = revision(25, '2026-10-13T08:00:00.000Z')
  expect(historyCloudTime(item)).toBe('2026-09-25T12:00:00.000Z')
  expect(historyPreview(item)).toBe('正文 25')
})
