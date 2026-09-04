import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

describe('历史便签补录界面与业务边界', () => {
  it('列表新建允许过去时间，并仅为合规未来预约开放提醒', () => {
    const panel = readSource('src/renderer/src/components/list/NewNotePanel.vue')

    expect(panel).toContain('assertCreatableNoteEffectiveTime(effectiveTimestamp.value, now)')
    expect(panel).toContain('canScheduleNoteNotification(effectiveTimestamp.value, Date.now())')
    expect(panel).toContain("{ label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) }")
    expect(panel).toContain("{ label: '一周前', getValue: () => dateAtDefaultScheduleTime(-7) }")
    expect(panel).toContain('历史补录将直接进入进行中，不发送系统提醒。')
    expect(panel).not.toContain(':min-date="today"')
  })

  it('编辑器允许初始化和进行中便签修正时间，但保持已完成只读', () => {
    const editor = readSource('src/renderer/src/components/note/NoteEditor.vue')

    expect(editor).toContain("['initialized', 'in_progress'].includes(status.value)")
    expect(editor).toContain('进行中便签的生效时间只能修正为当前或过去时间')
    expect(editor).toContain("return '已完成便签的生效时间不可修改。'")
    expect(editor).toContain(':disabled="!canEditSchedule"')
    expect(editor).not.toContain(':min-date="today"')
  })

  it('主进程派生状态和提醒，不接受 renderer 直接改变状态', () => {
    const businessIpc = readSource('src/main/ipc/register-business-ipc.js')

    expect(businessIpc).toContain('assertCreatableNoteEffectiveTime(options.effectiveAt)')
    expect(businessIpc).toContain('const schedule = resolveNoteDraftSchedule({')
    expect(businessIpc).toContain('if (requestedStatus !== original.status)')
    expect(businessIpc).toContain('schedule.status')
    expect(businessIpc).toContain('schedule.notifyEnabled')
    expect(businessIpc).toContain('schedule.finishedAt')
  })
})
