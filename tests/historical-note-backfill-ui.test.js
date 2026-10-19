import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

describe('历史便签补录界面与业务边界', () => {
  it('列表新建允许过去时间，并仅为合规未来预约开放提醒', () => {
    const panel = readSource('src/renderer/src/components/list/NewNotePanel.vue')

    expect(panel).toContain('stateFields = submissionFields()')
    expect(panel).toContain('useNoteStateDraft({ effectiveTimestamp, statusChoice, finishedAt })')
    expect(panel).toContain("{ label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) }")
    expect(panel).toContain("{ label: '一周前', getValue: () => dateAtDefaultScheduleTime(-7) }")
    expect(panel).toContain('<NoteStateFields')
    expect(panel).not.toContain(':min-date="today"')
  })

  it('编辑器所有状态共用时间联动，并保留未修改时间的精度', () => {
    const editor = readSource('src/renderer/src/components/note/NoteEditor.vue')

    expect(editor).toContain('<NoteStateFields')
    expect(editor).toContain('stateFields = submissionFields({')
    expect(editor).toContain('finishedAt.value === initialSnapshot.value?.finishedAt')
    expect(editor).not.toContain(':disabled="!canEditSchedule"')
    expect(editor).not.toContain('进行中便签的生效时间只能修正为当前或过去时间')
    expect(editor).not.toContain(':min-date="today"')
  })

  it('共用状态表单提供时间约束说明和条件完成时间', () => {
    const fields = readSource('src/renderer/src/components/note/NoteStateFields.vue')
    const state = readSource('src/renderer/src/composables/useNoteStateDraft.js')
    expect(fields).toContain("status === 'completed'")
    expect(fields).toContain("finishedPlaceholder: { type: String, default: '保存时完成' }")
    expect(state).toContain('getAllowedNoteStatuses')
    expect(state).toContain('resolveNoteCreateSchedule(requested)')
    expect(state).toContain('resolveNoteDraftSchedule({')
    expect(state).toContain('未来生效仅支持未开始')
  })
})
