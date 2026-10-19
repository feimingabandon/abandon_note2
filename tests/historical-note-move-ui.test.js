import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createHistoricalMoveSelection,
  historicalMoveSelectionCount,
  historicalMoveSelectionPayload,
  isHistoricalMoveSelected,
  toggleHistoricalMoveSelection
} from '../src/renderer/src/components/month/historical-note-move-selection.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const control = read('src/renderer/src/components/month/HistoricalNoteMoveControl.vue')
const toolbar = read('src/renderer/src/components/month/MonthCalendarToolbar.vue')
const firstPage = [
  { id: 1, canMove: true, durationKind: 'single_day' },
  { id: 2, canMove: false, durationKind: 'fixed_days' },
  { id: 3, canMove: false, durationKind: 'until_completed' }
]

describe('historical move selection across pages', () => {
  it('defaults to every movable note in the range, including unloaded pages', () => {
    const selection = createHistoricalMoveSelection()
    expect(historicalMoveSelectionCount(selection, 150, firstPage)).toBe(150)
    expect(historicalMoveSelectionPayload(selection, firstPage)).toEqual({ excludedNoteIds: [] })
    expect(isHistoricalMoveSelected(selection, firstPage[0])).toBe(true)
    expect(isHistoricalMoveSelected(selection, firstPage[1])).toBe(false)
    expect(isHistoricalMoveSelected(selection, firstPage[2])).toBe(false)
  })

  it('excludes a deselected eligible row without losing the other pages', () => {
    const selection = toggleHistoricalMoveSelection(createHistoricalMoveSelection(), firstPage[0])
    const pages = [...firstPage, { id: 50, canMove: true }]
    expect(historicalMoveSelectionCount(selection, 150, pages)).toBe(149)
    expect(historicalMoveSelectionPayload(selection, pages)).toEqual({ excludedNoteIds: [1] })
    expect(isHistoricalMoveSelected(selection, pages.at(-1))).toBe(true)
    expect(isHistoricalMoveSelected(selection, firstPage[0])).toBe(false)
  })

  it('cannot select disabled rows through toggling or range-wide select-all', () => {
    const cleared = createHistoricalMoveSelection(false)
    expect(toggleHistoricalMoveSelection(cleared, firstPage[1])).toBe(cleared)
    expect(toggleHistoricalMoveSelection(cleared, firstPage[2])).toBe(cleared)
    expect(historicalMoveSelectionPayload(cleared, firstPage)).toEqual({ noteIds: [] })
    expect(historicalMoveSelectionCount(cleared, 150, firstPage)).toBe(0)
  })

  it('manual selections contain only explicitly checked valid notes', () => {
    const pages = [...firstPage, { id: 50, canMove: true }]
    let selection = toggleHistoricalMoveSelection(createHistoricalMoveSelection(false), pages[0])
    selection = toggleHistoricalMoveSelection(selection, pages.at(-1))
    expect(historicalMoveSelectionCount(selection, 150, pages)).toBe(2)
    expect(historicalMoveSelectionPayload(selection, pages)).toEqual({ noteIds: [1, 50] })
    selection = toggleHistoricalMoveSelection(selection, pages[0])
    expect(historicalMoveSelectionPayload(selection, pages)).toEqual({ noteIds: [50] })
  })

  it('drops stale or disabled ids and never subtracts them from movable totals', () => {
    const invalid = { all: false, ids: new Set([1, 2, 3, 999]) }
    expect(historicalMoveSelectionPayload(invalid, firstPage)).toEqual({ noteIds: [1] })
    expect(historicalMoveSelectionCount(invalid, 1, firstPage)).toBe(1)
    const exclusion = { ...invalid, all: true }
    expect(historicalMoveSelectionCount(exclusion, 1, firstPage)).toBe(0)
    expect(historicalMoveSelectionPayload(exclusion, firstPage)).toEqual({ excludedNoteIds: [1] })
    expect(historicalMoveSelectionPayload(invalid, firstPage.slice(1))).toEqual({ noteIds: [] })
  })
})

describe('historical move UI boundaries', () => {
  it('keeps the empty-state entry usable and provides modal focus/queue handling', () => {
    const trigger = control.slice(control.indexOf('<template>'), control.indexOf('<AppModalShell'))
    expect(trigger).toContain(':disabled="disabled || moving"')
    expect(trigger).not.toContain('movableCount')
    expect(control).toContain('const modalQueue = useModalRequest()')
    expect(control).toContain(':queue="modalShellQueue"')
    expect(toolbar).toContain('<HistoricalNoteMoveControl')
    expect(toolbar).toContain('@moved="emit(\'historical-notes-moved\', $event)"')
  })

  it('renders persistent disabled explanations while disabling only selection', () => {
    expect(control).toContain(':disabled="moving || resultsUnavailable || !note.canMove"')
    expect(control).toContain('data-move-disabled-reason')
    expect(control).toContain('disabledReason(note)')
    expect(control).not.toContain('pointer-events: none')
    expect(control).toContain('自选日期区间')
    expect(control).toContain(':max-date="yesterdayKey"')
    expect(control).toContain('data-move-load-more')
    expect(control).toContain('全选包含当前日期范围内尚未加载的可移动便签')
  })

  it('submits the preview date and stores the shared automatic preference', () => {
    expect(control).toContain('targetDateKey: preview.value.targetDateKey')
    expect(control).toContain("setSettingValue('notes.autoMoveToToday', Boolean(value))")
    expect(control).toContain('window.api.onSettingsChanged?.(applySettings)')
    expect(control).toContain('window.api.onNotesChanged?.(onPreviewChanged)')
    expect(control).toContain('每天自动移动昨天未完成的仅当天便签，开启后立即检查')
    expect(control).not.toContain('recurrence_id')
    expect(control).not.toContain('template_id')
  })
})
