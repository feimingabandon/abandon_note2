import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TOKENS_PATH = new URL('../src/renderer/src/assets/tokens.css', import.meta.url)
const MONTH_DAY_PANEL_PATH = new URL(
  '../src/renderer/src/components/month/MonthDayPanel.vue',
  import.meta.url
)
const UI_STANDARD_PATH = new URL('../docs/UI_DESIGN_STANDARD.md', import.meta.url)
const NOTE_CARD_PATH = new URL('../src/renderer/src/components/list/NoteCard.vue', import.meta.url)
const DAILY_REPORT_PATH = new URL(
  '../src/renderer/src/components/report/DailyReportDialog.vue',
  import.meta.url
)
const LIST_APP_PATH = new URL('../src/renderer/src/App.vue', import.meta.url)
const MONTH_APP_PATH = new URL('../src/renderer/src/MonthApp.vue', import.meta.url)

describe('UI interaction standard', () => {
  it('does not scale controls whose popup already provides click feedback', () => {
    const tokens = readFileSync(TOKENS_PATH, 'utf8')
    const standard = readFileSync(UI_STANDARD_PATH, 'utf8')

    expect(tokens).toMatch(/button\[aria-haspopup\][^{]*\{\s*transform: none;/)
    expect(standard).toContain('面板展开与收起本身就是反馈')
  })

  it('keeps the month sidebar create action as a neutral icon button', () => {
    const source = readFileSync(MONTH_DAY_PANEL_PATH, 'utf8')
    const markup = source.match(
      /<button[\s\S]*?class="month-day-panel__create"[\s\S]*?<\/button>/
    )?.[0]
    const baseStyle = source.match(/\.month-day-panel__create \{([\s\S]*?)\}/)?.[1]
    const hoverStyle = source.match(
      /\.month-day-panel__create:hover:not\(:disabled\) \{([\s\S]*?)\}/
    )?.[1]

    expect(markup).toContain('<svg')
    expect(markup).not.toContain('+ 新建')
    expect(markup).toContain(':aria-label=')
    expect(baseStyle).toContain('background: transparent')
    expect(baseStyle).toContain('color: var(--text-color-secondary)')
    expect(baseStyle).not.toContain('#0a84ff')
    expect(hoverStyle).toContain('color: var(--text-color)')
  })

  it('reuses the full list note card in the month day panel without drag sorting', () => {
    const panel = readFileSync(MONTH_DAY_PANEL_PATH, 'utf8')
    const card = readFileSync(NOTE_CARD_PATH, 'utf8')

    expect(panel).toContain("import NoteCard from '../list/NoteCard.vue'")
    expect(panel).toContain('<NoteCard')
    expect(panel).not.toContain(':draggable=')
    expect(panel).toContain('month-day-panel__weather-slot')
    expect(panel).toContain('grid-template-rows 260ms')
    expect(panel).toContain('animateRetainedCards(before')
    expect(card).toContain("onContextMenuAction('pin')")
    expect(card).toContain("note.is_pinned ? '取消置顶' : '置顶'")
  })

  it('keeps shared note metadata on one line and truncates the complete timing text', () => {
    const card = readFileSync(NOTE_CARD_PATH, 'utf8')
    const metadataStyle = card.match(/\.nl-card-meta \{([\s\S]*?)\}/)?.[1]
    const timingStyle = card.match(/\.nl-card-timing \{([\s\S]*?)\}/)?.[1]
    const utilitiesStyle = card.match(/\.nl-card-utilities \{([\s\S]*?)\}/)?.[1]

    expect(card).toContain('class="nl-card-timing" :title="timingTitle"')
    expect(metadataStyle).toContain('flex-wrap: nowrap')
    expect(timingStyle).toContain('text-overflow: ellipsis')
    expect(timingStyle).toContain('white-space: nowrap')
    expect(utilitiesStyle).toContain('flex: 0 0 auto')
  })

  it('uses a transparent month sidebar collapse button with the month-arrow-sized icon', () => {
    const panel = readFileSync(MONTH_DAY_PANEL_PATH, 'utf8')
    const markup = panel.match(
      /<button[\s\S]*?class="month-day-panel__collapse"[\s\S]*?<\/button>/
    )?.[0]
    const baseStyle = panel.match(/\.month-day-panel__header button \{([\s\S]*?)\}/)?.[1]
    const iconStyle = panel.match(/\.month-day-panel__collapse svg \{([\s\S]*?)\}/)?.[1]

    expect(markup).toContain('<svg viewBox="0 0 12 18"')
    expect(baseStyle).toContain('background: transparent')
    expect(iconStyle).toContain('width: 12rem')
    expect(iconStyle).toContain('height: 18rem')
  })

  it('shares the daily report dialog across list and month views', () => {
    const dialog = readFileSync(DAILY_REPORT_PATH, 'utf8')
    const listApp = readFileSync(LIST_APP_PATH, 'utf8')
    const monthApp = readFileSync(MONTH_APP_PATH, 'utf8')

    expect(dialog).toContain("import AppModalShell from '../ui/AppModalShell.vue'")
    expect(dialog).toContain("import BaseButton from '../ui/BaseButton.vue'")
    expect(dialog).toContain("import ConfirmDialog from '../ui/ConfirmDialog.vue'")
    expect(dialog).toContain("import DatePicker from '../ui/DatePicker.vue'")
    expect(dialog).not.toContain('TagSelector')
    expect(dialog).toContain('statuses: [...statuses.value]')
    expect(dialog).not.toContain('statuses: statuses.value')
    expect(dialog).toContain('confirm-text="打开文件夹"')
    expect(dialog).toContain('window.api.openDailyReportExportFolder()')
    expect(dialog).toContain("window.api.exportDailyReport({ action: 'open-folder' })")
    expect(listApp).toContain(
      "import DailyReportDialog from './components/report/DailyReportDialog.vue'"
    )
    expect(monthApp).toContain(
      "import DailyReportDialog from './components/report/DailyReportDialog.vue'"
    )
    expect(listApp).toContain('<DailyReportButton')
    expect(monthApp).toContain('<DailyReportButton')
  })
})
