import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

const mocks = vi.hoisted(() => ({
  queryCalendarNotes: vi.fn()
}))

vi.mock('../src/main/db/db-notes.js', () => ({
  queryCalendarNotes: mocks.queryCalendarNotes
}))

import { registerDailyReportIpcHandlers } from '../src/main/ipc/register-daily-report-ipc.js'

const temporaryDirectories = []

function createHarness(filePath) {
  const handlers = new Map()
  const webContents = {}
  registerDailyReportIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath })
    },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
    getMainWindow: () => ({ isDestroyed: () => false, webContents })
  })
  return { handlers, event: { sender: webContents } }
}

afterEach(async () => {
  mocks.queryCalendarNotes.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('daily report IPC', () => {
  it('writes the selected range as a readable XLSX file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-report-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'report.xlsx')
    const note = {
      id: 7,
      content: '导出到 Excel',
      status: 'completed',
      is_pinned: 0,
      effective_at: new Date(2026, 7, 12, 9).getTime(),
      duration_days: 2,
      finished_at: new Date(2026, 7, 13, 10).getTime()
    }
    mocks.queryCalendarNotes.mockReturnValue([note])
    const harness = createHarness(filePath)

    const result = await harness.handlers.get('daily-report:export')(harness.event, {
      startDateKey: '2026-08-12',
      endDateKey: '2026-08-13',
      statuses: ['completed'],
      noteIds: [note.id],
      format: 'xlsx'
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await readFile(filePath))
    const sheet = workbook.getWorksheet('便签报表')

    expect(result).toMatchObject({
      canceled: false,
      fileName: 'report.xlsx',
      format: 'xlsx',
      truncatedCount: 0
    })
    expect(sheet.rowCount).toBe(2)
    expect(sheet.getRow(2).getCell(1).value).toBe('导出到 Excel')
    expect(sheet.getRow(2).getCell(3).value).toBe('是')
  })
})
