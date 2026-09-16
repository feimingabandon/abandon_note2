import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TOKENS_PATH = new URL('../src/renderer/src/assets/tokens.css', import.meta.url)
const MONTH_DAY_PANEL_PATH = new URL(
  '../src/renderer/src/components/month/MonthDayPanel.vue',
  import.meta.url
)
const MONTH_TOOLBAR_PATH = new URL(
  '../src/renderer/src/components/month/MonthCalendarToolbar.vue',
  import.meta.url
)
const MONTH_WORKSPACE_PATH = new URL(
  '../src/renderer/src/components/month/MonthWorkspace.vue',
  import.meta.url
)
const MONTH_GRID_PATH = new URL(
  '../src/renderer/src/components/month/MonthCalendarGrid.vue',
  import.meta.url
)
const MONTH_EVENT_BAR_PATH = new URL(
  '../src/renderer/src/components/month/MonthEventBar.vue',
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
    expect(markup).toContain('aria-label=')
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

  it('uses explicit month and week toolbar controls instead of date cells to toggle the day panel', () => {
    const toolbar = readFileSync(MONTH_TOOLBAR_PATH, 'utf8')
    const workspace = readFileSync(MONTH_WORKSPACE_PATH, 'utf8')
    const standard = readFileSync(UI_STANDARD_PATH, 'utf8')
    const leadingMarkup = toolbar.match(
      /<div class="month-toolbar__leading">([\s\S]*?)<div class="month-toolbar__navigation"/
    )?.[1]
    const trailingMarkup = toolbar.match(
      /<div class="month-toolbar__trailing">([\s\S]*?)<\/div>\s*<\/header>/
    )?.[1]
    const selectDate = workspace.match(/async function selectDate\([\s\S]*?\n\}/)?.[0]
    const toggleDayPanel = workspace.match(/function toggleDayPanel\([\s\S]*?\n\}/)?.[0]

    expect(toolbar).toContain('class="month-toolbar__day-panel-toggle"')
    expect(toolbar).toContain('aria-controls="month-day-panel"')
    expect(toolbar).toContain('@click="emit(\'toggle-day-panel\')"')
    expect(leadingMarkup).toContain('class="month-toolbar__today"')
    expect(leadingMarkup).toContain('name="locate-current"')
    expect(leadingMarkup).toContain('class="month-toolbar__refresh"')
    expect(trailingMarkup).toContain('class="month-toolbar__day-panel-toggle"')
    expect(trailingMarkup).not.toContain('v-else')
    expect(toolbar).toContain('@media (max-width: 520px)')
    expect(toolbar).toContain('@media (max-width: 420px)')
    expect(toolbar).toContain("'leading trailing'")
    expect(toolbar).toContain("'navigation navigation'")
    expect(workspace).toContain('@toggle-day-panel="toggleDayPanel"')
    expect(selectDate).not.toContain('panelOpen.value')
    expect(toggleDayPanel).not.toContain('isWeekView.value')
    expect(standard).toContain('月视图与周视图工具栏左侧统一放置“定位到今天”图标和刷新操作')
    expect(standard).toContain('右侧固定提供独立的日期列表开关')
    expect(standard).toContain('月视图与周视图日期格只负责选择日期')
  })

  it('uses an inline quick creator and note-level presence motion in calendar cells', () => {
    const grid = readFileSync(MONTH_GRID_PATH, 'utf8')
    const eventBar = readFileSync(MONTH_EVENT_BAR_PATH, 'utf8')
    const standard = readFileSync(UI_STANDARD_PATH, 'utf8')

    expect(grid).toContain('class="month-day-cell__quick-activate"')
    expect(grid).toContain('class="month-day-cell__quick-create"')
    expect(grid).toContain('placeholder="新建便签"')
    expect(grid).toContain('window.api.createNote(options)')
    expect(grid).toContain("showMessage('warning', '请输入便签内容')")
    expect(grid).toContain("day.key < props.todayKey ? '历史便签补录成功' : '便签创建成功'")
    expect(grid).toContain("emit('quick-created', created)")
    expect(grid).toContain('@pointerdown.prevent.stop')
    expect(grid).not.toContain('resettingQuickCreateKey')
    expect(grid).toMatch(/\.month-day-cell__quick-create \{[\s\S]*?opacity: 1;/)
    expect(grid).toMatch(
      /\.month-day-cell__quick-create \{[\s\S]*?width 280ms var\(--ease-standard\)/
    )
    expect(grid).not.toContain('.month-day-cell__quick-create.is-snap-reset')
    expect(grid).toContain('animateEventBarChanges(before)')
    expect(grid).toContain('visibleEventLayoutSignature(nextNotes)')
    expect(grid).toContain('nextDayRange !== previousDayRange')
    expect(grid).not.toContain('class="month-day-cell__overflow"')
    expect(grid).not.toContain('点击日期查看全部')
    expect(grid).toContain('点击预览全部')
    expect(eventBar).toContain(':data-segment-key="`${note.id}:${segment.weekIndex}`"')
    expect(standard).toContain('日期格底部整体作为快速新建入口')
    expect(standard).toContain('左下角常显的“+”')
    expect(standard).toContain('由右向左平滑回到左下角方形')
    expect(standard).toContain('便签创建、删除及排序变化不得驱动整月统一模糊')
  })

  it('shares the daily report dialog across list and month views', () => {
    const dialog = readFileSync(DAILY_REPORT_PATH, 'utf8')
    const listApp = readFileSync(LIST_APP_PATH, 'utf8')
    const monthApp = readFileSync(MONTH_APP_PATH, 'utf8')

    expect(dialog).toContain("import AppModalShell from '../ui/AppModalShell.vue'")
    expect(dialog).toContain("import BaseButton from '../ui/BaseButton.vue'")
    expect(dialog).toContain("import ConfirmDialog from '../ui/ConfirmDialog.vue'")
    expect(dialog).toContain("import DatePicker from '../ui/DatePicker.vue'")
    expect(dialog).toContain('v-model="startDateKey"')
    expect(dialog).toContain('v-model="endDateKey"')
    expect(dialog).toContain('const MAX_RANGE_DAYS = 366')
    expect(dialog).toContain("{ value: 'xlsx', label: 'Excel' }")
    expect(dialog).toContain('format: exportFormat.value')
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
