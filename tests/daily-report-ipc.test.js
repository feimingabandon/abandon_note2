import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

const mocks = vi.hoisted(() => ({
  queryCalendarNotes: vi.fn(),
  getDb: vi.fn(),
  tagRows: [],
  access: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('../src/main/db/db-notes.js', () => ({
  queryCalendarNotes: mocks.queryCalendarNotes
}))

vi.mock('../src/main/db/db-connection.js', () => ({ getDb: mocks.getDb }))

// Record filesystem side effects without replacing actual reads/writes or errors.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    access: mocks.access.mockImplementation(actual.access),
    writeFile: mocks.writeFile.mockImplementation(actual.writeFile)
  }
})

import { registerDailyReportIpcHandlers } from '../src/main/ipc/register-daily-report-ipc.js'

const temporaryDirectories = []

function createHarness(filePath) {
  mocks.getDb.mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: (...noteIds) => mocks.tagRows.filter((row) => noteIds.flat().includes(row.note_id))
    })
  })
  const handlers = new Map()
  const webContents = {}
  const dialog = {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath })
  }
  const shell = { showItemInFolder: vi.fn(), openPath: vi.fn() }
  registerDailyReportIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog,
    shell,
    getMainWindow: () => ({ isDestroyed: () => false, webContents })
  })
  return { handlers, event: { sender: webContents }, dialog, shell }
}

afterEach(async () => {
  mocks.queryCalendarNotes.mockReset()
  mocks.getDb.mockReset()
  mocks.tagRows = []
  mocks.access.mockClear()
  mocks.writeFile.mockClear()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const reportOptions = {
  startDateKey: '2026-08-12',
  endDateKey: '2026-08-13',
  statuses: ['completed'],
  noteIds: [7],
  format: 'txt'
}

function reportNote() {
  return {
    id: 7,
    content: '上次成功的报表内容',
    status: 'completed',
    is_pinned: 0,
    effective_at: new Date(2026, 7, 12, 9).getTime(),
    duration_days: 2,
    finished_at: new Date(2026, 7, 13, 10).getTime()
  }
}

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
    mocks.tagRows = [{ note_id: note.id, id: 41, name: '=工作计划', color: '#3478f6' }]
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
    expect(sheet.getRow(1).getCell(2).value).toBe('标签')
    expect(sheet.getRow(2).getCell(1).value).toBe('导出到 Excel')
    expect(sheet.getRow(2).getCell(2).value).toBe('=工作计划')
    expect(sheet.getRow(2).getCell(4).value).toBe('是')
  })

  it.each([
    { label: 'omitted filters', expected: [7, 8, 9, 10] },
    { label: 'an empty selection', tagIds: [], expected: [7, 8, 9, 10] },
    { label: 'one tag', tagIds: [41], expected: [7] },
    { label: 'multiple tags with OR', tagIds: [41, 42], expected: [7, 8] },
    { label: 'uncategorized notes', tagIds: [-1], expected: [9] },
    { label: 'a tag or uncategorized', tagIds: [41, -1], expected: [7, 9] },
    { label: 'a missing tag', tagIds: [999], expected: [] }
  ])('previews $label through the authorized IPC boundary', ({ tagIds, expected }) => {
    mocks.queryCalendarNotes.mockReturnValue([7, 8, 9, 10].map((id) => ({ ...reportNote(), id })))
    mocks.tagRows = [
      { note_id: 7, id: 41, name: '工作', color: '#3478f6' },
      { note_id: 8, id: 42, name: '生活', color: null },
      { note_id: 10, id: 43, name: '其他', color: null }
    ]
    const harness = createHarness('unused-preview-target.txt')
    const options = {
      ...reportOptions,
      ...(tagIds === undefined ? {} : { tagIds })
    }

    const result = harness.handlers.get('daily-report:preview')(harness.event, options)

    expect(result.notes.map((note) => note.id)).toEqual(expected)
    for (const note of result.notes) {
      expect(note.tags).toEqual(
        mocks.tagRows
          .filter((row) => row.note_id === note.id)
          .map(({ id, name, color }) => ({ id, name, color }))
      )
    }
    expect(harness.dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it.each(['txt', 'xlsx'])(
    'rechecks current tags and intersects manual selections before writing a real %s file',
    async (format) => {
      const directory = await mkdtemp(join(tmpdir(), 'abandon-report-current-tags-'))
      temporaryDirectories.push(directory)
      const filePath = join(directory, `current-tags.${format}`)
      const contents = new Map([
        [7, '保留并读取最新标签名'],
        [8, '手动取消的同标签便签'],
        [9, '预览后移出筛选的便签'],
        [10, '伪造勾选的其他标签便签'],
        [11, '保留的未分类便签']
      ])
      mocks.queryCalendarNotes.mockReturnValue(
        [...contents].map(([id, content]) => ({ ...reportNote(), id, content }))
      )
      mocks.tagRows = [
        { note_id: 7, id: 41, name: '原标签名', color: '#3478f6' },
        { note_id: 8, id: 41, name: '原标签名', color: '#3478f6' },
        { note_id: 10, id: 42, name: '其他标签', color: null }
      ]
      const harness = createHarness(filePath)
      const options = { ...reportOptions, tagIds: [41, -1], format }
      const preview = harness.handlers.get('daily-report:preview')(harness.event, options)
      expect(preview.notes.map((note) => note.id)).toEqual([7, 8, 9, 11])
      expect(preview.notes[0].tags[0].name).toBe('原标签名')

      // The preview is intentionally stale: labels and membership change before export.
      mocks.tagRows = [
        { note_id: 7, id: 41, name: '=最新标签名', color: '#3478f6' },
        { note_id: 8, id: 41, name: '=最新标签名', color: '#3478f6' },
        { note_id: 9, id: 42, name: '其他标签', color: null },
        { note_id: 10, id: 42, name: '其他标签', color: null }
      ]
      const result = await harness.handlers.get('daily-report:export')(harness.event, {
        ...options,
        noteIds: [7, 9, 10, 11]
      })
      const bytes = await readFile(filePath)

      expect(result).toMatchObject({ canceled: false, format, filePath })
      expect(mocks.queryCalendarNotes).toHaveBeenCalledTimes(2)
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(bytes)
        const sheet = workbook.getWorksheet('便签报表')
        expect(sheet.getRow(1).getCell(2).value).toBe('标签')
        expect(sheet.rowCount).toBe(3)
        expect([2, 3].map((row) => sheet.getRow(row).values.slice(1, 3))).toEqual([
          [contents.get(7), '=最新标签名'],
          [contents.get(11), '未分类']
        ])
      } else {
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
        const text = bytes.toString('utf8')
        expect(text).toContain(contents.get(7))
        expect(text).toContain(contents.get(11))
        expect(text).toContain('标签：=最新标签名')
        expect(text).toContain('标签：未分类')
        for (const id of [8, 9, 10]) expect(text).not.toContain(contents.get(id))
        expect(text).not.toContain('原标签名')
      }
    }
  )

  it.each(['daily-report:preview', 'daily-report:export', 'daily-report:open-export-folder'])(
    'rejects outsider senders before side effects on %s',
    async (channel) => {
      const directory = await mkdtemp(join(tmpdir(), 'abandon-report-outsider-'))
      temporaryDirectories.push(directory)
      const harness = createHarness(join(directory, 'outsider.txt'))
      mocks.queryCalendarNotes.mockReturnValue([reportNote()])

      await expect(
        Promise.resolve().then(() => harness.handlers.get(channel)({ sender: {} }, reportOptions))
      ).rejects.toThrow('无权访问报表导出功能')

      expect(mocks.queryCalendarNotes).not.toHaveBeenCalled()
      expect(mocks.getDb).not.toHaveBeenCalled()
      expect(harness.dialog.showSaveDialog).not.toHaveBeenCalled()
      expect(mocks.writeFile).not.toHaveBeenCalled()
      expect(mocks.access).not.toHaveBeenCalled()
      expect(harness.shell.showItemInFolder).not.toHaveBeenCalled()
      expect(harness.shell.openPath).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual([])
    }
  )

  it('does not write a canceled save target or remember it as a successful export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-report-canceled-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'canceled.txt')
    const harness = createHarness(filePath)
    harness.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath })
    mocks.queryCalendarNotes.mockReturnValue([reportNote()])

    const result = await harness.handlers.get('daily-report:export')(harness.event, reportOptions)

    expect(result).toEqual({ canceled: true })
    expect(mocks.queryCalendarNotes).toHaveBeenCalledTimes(1)
    expect(harness.dialog.showSaveDialog).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
    await expect(
      harness.handlers.get('daily-report:open-export-folder')(harness.event)
    ).rejects.toThrow('没有可打开的报表导出位置')
    expect(mocks.access).not.toHaveBeenCalled()
    expect(harness.shell.showItemInFolder).not.toHaveBeenCalled()
    expect(harness.shell.openPath).not.toHaveBeenCalled()
  })

  it('preserves the last successful export after an actual filesystem write rejects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'abandon-report-write-failure-'))
    temporaryDirectories.push(directory)
    const successDirectory = join(directory, 'successful')
    const blockedPath = join(directory, 'blocked.txt')
    await mkdir(successDirectory)
    await mkdir(blockedPath)
    const successPath = join(successDirectory, 'report.txt')
    const harness = createHarness(successPath)
    mocks.queryCalendarNotes.mockReturnValue([reportNote()])
    const successful = await harness.handlers.get('daily-report:export')(
      harness.event,
      reportOptions
    )
    expect(successful).toMatchObject({ canceled: false, filePath: successPath, format: 'txt' })
    const originalContent = await readFile(successPath, 'utf8')
    expect(originalContent).toContain('上次成功的报表内容')
    harness.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: blockedPath })

    // The target is a real owned directory: writeFile must reject on Windows.
    await expect(
      harness.handlers.get('daily-report:export')(harness.event, reportOptions)
    ).rejects.toThrow()
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    expect(mocks.writeFile.mock.calls[1][0]).toBe(blockedPath)
    expect(await readdir(blockedPath)).toEqual([])
    expect(await readFile(successPath, 'utf8')).toBe(originalContent)

    const opened = await harness.handlers.get('daily-report:open-export-folder')(harness.event)
    expect(opened).toBe(true)
    expect(mocks.access).toHaveBeenCalledWith(successPath)
    expect(harness.shell.showItemInFolder).toHaveBeenCalledTimes(1)
    expect(harness.shell.showItemInFolder).toHaveBeenCalledWith(successPath)
    expect(harness.shell.openPath).not.toHaveBeenCalled()
    expect(harness.dialog.showSaveDialog).toHaveBeenCalledTimes(2)
    expect(mocks.queryCalendarNotes).toHaveBeenCalledTimes(2)
  })
})
