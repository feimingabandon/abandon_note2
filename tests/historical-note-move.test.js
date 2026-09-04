import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
  HISTORICAL_NOTE_MOVE_SCOPES,
  normalizeHistoricalNoteMoveIds,
  normalizeHistoricalNoteMovePreviewPage,
  normalizeHistoricalNoteMoveSelection
} from '../src/shared/historical-note-move-rules.js'
import { localMidnightTimestamp } from '../src/shared/calendar/calendar-date-rules.js'

const readSource = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

function localTs(year, month, day, hour = 10) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

describe('historical note move rules', () => {
  const currentTime = localTs(2026, 9, 4)

  it('normalizes an inclusive historical date range to local timestamp boundaries', () => {
    expect(
      normalizeHistoricalNoteMoveSelection(
        {
          scope: HISTORICAL_NOTE_MOVE_SCOPES.RANGE,
          startDateKey: '2026-09-01',
          endDateKey: '2026-09-03'
        },
        currentTime
      )
    ).toEqual({
      scope: 'range',
      todayDateKey: '2026-09-04',
      yesterdayDateKey: '2026-09-03',
      todayStart: localMidnightTimestamp('2026-09-04'),
      rangeStart: localMidnightTimestamp('2026-09-01'),
      rangeEndExclusive: localMidnightTimestamp('2026-09-04'),
      startDateKey: '2026-09-01',
      endDateKey: '2026-09-03'
    })
  })

  it('represents all history as everything before the start of today', () => {
    const result = normalizeHistoricalNoteMoveSelection(
      { scope: HISTORICAL_NOTE_MOVE_SCOPES.ALL },
      currentTime
    )
    expect(result).toMatchObject({
      scope: 'all',
      todayDateKey: '2026-09-04',
      yesterdayDateKey: '2026-09-03',
      rangeStart: null,
      rangeEndExclusive: localMidnightTimestamp('2026-09-04'),
      startDateKey: null,
      endDateKey: '2026-09-03'
    })
  })

  it('rejects today, future, reversed, invalid, and unsupported custom ranges', () => {
    const normalize = (startDateKey, endDateKey) =>
      normalizeHistoricalNoteMoveSelection({ startDateKey, endDateKey }, currentTime)
    expect(() => normalize('2026-09-03', '2026-09-04')).toThrow(/今天以前/)
    expect(() => normalize('2026-09-03', '2026-09-05')).toThrow(/今天以前/)
    expect(() => normalize('2026-09-03', '2026-09-02')).toThrow(/不能早于/)
    expect(() => normalize('2026-02-30', '2026-09-03')).toThrow(/日期不存在/)
    expect(() => normalize('1899-12-31', '2026-09-03')).toThrow(/1900-01-01/)
  })

  it('normalizes and validates an explicit note selection', () => {
    expect(normalizeHistoricalNoteMoveIds(undefined)).toBeNull()
    expect(normalizeHistoricalNoteMoveIds([3, '2', 3])).toEqual([3, 2])
    expect(normalizeHistoricalNoteMoveIds([])).toEqual([])
    expect(() => normalizeHistoricalNoteMoveIds('3')).toThrow(/列表无效/)
    expect(() => normalizeHistoricalNoteMoveIds([0])).toThrow(/ID 无效/)
  })

  it('bounds each preview page while accepting a safe non-negative offset', () => {
    expect(normalizeHistoricalNoteMovePreviewPage()).toEqual({
      limit: HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
      offset: 0
    })
    expect(normalizeHistoricalNoteMovePreviewPage({ limit: 10_000, offset: 25 })).toEqual({
      limit: HISTORICAL_NOTE_MOVE_PREVIEW_PAGE_SIZE,
      offset: 25
    })
    expect(normalizeHistoricalNoteMovePreviewPage({ limit: 0, offset: -5 })).toEqual({
      limit: 1,
      offset: 0
    })
  })
})

describe('historical note move UI wiring', () => {
  it('adds the shared control before the date-list toggle with the agreed copy', () => {
    const toolbar = readSource('src/renderer/src/components/month/MonthCalendarToolbar.vue')
    const control = readSource('src/renderer/src/components/month/HistoricalNoteMoveControl.vue')

    expect(toolbar.indexOf('<HistoricalNoteMoveControl')).toBeGreaterThan(-1)
    expect(toolbar.indexOf('<HistoricalNoteMoveControl')).toBeLessThan(
      toolbar.indexOf('class="month-toolbar__day-panel-toggle"')
    )
    expect(control).toContain('未完成移至今天')
    expect(control).toContain("{ value: 'yesterday', label: '昨天' }")
    expect(control).toContain("{ value: 'recent3', label: '最近3天' }")
    expect(control).toContain("{ value: 'all', label: '全部历史' }")
    expect(control).toContain("selectedPreset.value = 'yesterday'")
    expect(control).toContain(':max-date="maxDateKey"')
    expect(control).toContain('previewHistoricalNoteMove({')
    expect(control).toContain('moveHistoricalNotesToToday({')
    expect(control).toContain('data-move-note-list')
    expect(control).toContain('{{ group.dateKey }}')
    expect(control).toContain('{{ note.content }}')
    expect(control).toContain('previewContentRef.value?.offsetHeight')
    expect(control).toContain('new ResizeObserver(measurePreviewContent)')
    expect(control).toContain('transition: height 240ms var(--ease-emphasized)')
    expect(control).toContain("enterPopover(element, done, 'dropdown')")
    expect(control).toContain('data-move-preset-indicator')
    expect(control).toContain('transform 260ms cubic-bezier(0.32, 0.72, 0, 1)')
    expect(control).toContain(':value-transition-direction="selectionDirection"')
    expect(control).toContain('data-move-preview-page')
    expect(control).toContain('allMatchingSelected.value = true')
    expect(control).toContain('excludedNoteIds: [...deselectedNoteIds.value]')
    expect(control).toContain('data-move-load-more')
    expect(control).toContain('data-move-select-all')
    expect(control).toContain('data-move-clear-selection')
    expect(control).toContain('{ noteIds: [...selectedNoteIds.value] }')
    expect(control).toMatch(
      /\.historical-note-move__selection-bar\s*\{[\s\S]*?background: var\(--surface-float\)/
    )
  })

  it('keeps the batch mutation behind authorized IPC and refreshes the shared workspace', () => {
    const preload = readSource('src/preload/index.js')
    const businessIpc = readSource('src/main/ipc/register-business-ipc.js')
    const workspace = readSource('src/renderer/src/components/month/MonthWorkspace.vue')

    expect(preload).toContain("ipcRenderer.invoke('notes:preview-historical-move', selection)")
    expect(preload).toContain("ipcRenderer.invoke('notes:move-historical-to-today', selection)")
    expect(businessIpc).toContain("ipcMain.handle('notes:preview-historical-move'")
    expect(businessIpc).toContain("ipcMain.handle('notes:move-historical-to-today'")
    expect(workspace).toContain('@historical-notes-moved="onHistoricalNotesMoved"')
    expect(workspace).toContain('await goToday()')
    expect(workspace).toContain('await refreshCalendarContent()')
  })

  it('constrains the reusable date range picker without changing unbounded callers', () => {
    const picker = readSource('src/renderer/src/components/ui/DateRangePicker.vue')
    expect(picker).toContain("minDate: { type: String, default: '' }")
    expect(picker).toContain("maxDate: { type: String, default: '' }")
    expect(picker).toContain('valueTransitionDirection:')
    expect(picker).toContain("enterPopover(element, done, 'dropdown')")
    expect(picker).toContain('data-date-range-value')
    expect(picker).toContain(':disabled="cell.disabled"')
    expect(picker).toContain(':aria-label="cell.key"')
    expect(picker).toContain('if (cell.disabled) return')
  })
})
