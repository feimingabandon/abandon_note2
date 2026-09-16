import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const GRID_PATH = new URL(
  '../src/renderer/src/components/month/MonthCalendarGrid.vue',
  import.meta.url
)
const EVENT_BAR_PATH = new URL(
  '../src/renderer/src/components/month/MonthEventBar.vue',
  import.meta.url
)
const WORKSPACE_PATH = new URL(
  '../src/renderer/src/components/month/MonthWorkspace.vue',
  import.meta.url
)
const STANDARD_PATH = new URL('../docs/UI_DESIGN_STANDARD.md', import.meta.url)

describe('月历日期格右键菜单', () => {
  it('区分便签横条、日期格和正在编辑的快速输入框', () => {
    const grid = readFileSync(GRID_PATH, 'utf8')
    const eventBar = readFileSync(EVENT_BAR_PATH, 'utf8')

    expect(eventBar).toContain("const emit = defineEmits(['open-context-menu'])")
    expect(eventBar).toContain('@contextmenu.prevent.stop="openContextMenu"')
    expect(eventBar).toContain("emit('open-context-menu', { event, note: props.note })")
    expect(grid).toContain('@contextmenu="openDayContextMenu($event, day)"')
    expect(grid).toContain('@open-context-menu="openNoteContextMenu"')
    expect(grid).toContain('@contextmenu.stop')
    expect(grid).toContain("event.target.closest?.('.month-day-cell__quick-create input')")
    expect(grid).toContain('if (!event || !note || note.read_only) return')
    expect(grid).toContain('noteId: note.id')
    expect(grid).toContain('const contextMenuNote = computed(')
    expect(grid).toContain('noteById.value.get(String(contextMenuTarget.value.noteId))')
    expect(grid).toContain('if (dayPreviewRef.value?.contains(event.target)) return')
  })

  it('允许任意有效日期新建，并提供完整的便签操作菜单', () => {
    const grid = readFileSync(GRID_PATH, 'utf8')

    expect(grid).not.toContain(':disabled="contextMenuTarget?.day?.key < todayKey"')
    expect(grid).not.toContain('if (target.day.key < props.todayKey) return')
    expect(grid).not.toMatch(/contextMenuTarget\?\.day\?\.inCurrentMonth/)
    expect(grid).toContain('新建便签…')
    expect(grid).toContain('预览当日全部便签')
    expect(grid).toContain("if (note?.status === 'initialized') return '切换为进行中'")
    expect(grid).toContain("if (note?.status === 'in_progress') return '切换为已完成'")
    expect(grid).toContain("if (note?.status === 'completed') return '重新进行'")
    expect(grid).toContain('contextStatusLabel(contextMenuNote)')
    expect(grid).toContain('修改便签')
    expect(grid).toContain('删除便签')
    expect(grid).toContain('class="month-cell-context-menu__delete"')
  })

  it('复用月视图已有的新建、修改、状态和逻辑删除链路', () => {
    const workspace = readFileSync(WORKSPACE_PATH, 'utf8')
    const standard = readFileSync(STANDARD_PATH, 'utf8')

    expect(workspace).toContain('@context-create="openCreator"')
    expect(workspace).toContain('@context-edit="openEditor"')
    expect(workspace).toContain('@context-status-action="onCardStatusAction"')
    expect(workspace).toContain('@context-delete="requestDeleteNote"')
    expect(workspace).toContain('@preview-open-day-panel="openPreviewDayPanel"')
    expect(workspace).toContain(':status-transitions="statusTransitions"')
    expect(workspace).toContain('@context-status-action="onCardStatusAction"')
    const grid = readFileSync(GRID_PATH, 'utf8')
    expect(grid).toContain('class="month-day-preview__status-action"')
    expect(grid).toContain("emit('context-status-action', note)")
    expect(grid).toContain(':disabled="statusTransitions.has(note.id)"')
    expect(workspace).toContain('window.api.deleteNote(note.id)')
    expect(workspace).toContain('v-model:visible="deleteConfirmVisible"')
    expect(standard).toContain('首尾跨月日期与本月日期使用相同规则')
    expect(standard).toContain('正在编辑的快速输入框以外的任意区域')
    expect(standard).toContain('预览使用无蒙层浮动窗完整列出当天全部便签正文')
  })
})
