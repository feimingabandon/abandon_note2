import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const toolbar = readFileSync(
  new URL('../src/renderer/src/components/month/MonthCalendarToolbar.vue', import.meta.url),
  'utf8'
)
const workspace = readFileSync(
  new URL('../src/renderer/src/components/month/MonthWorkspace.vue', import.meta.url),
  'utf8'
)
const eventBar = readFileSync(
  new URL('../src/renderer/src/components/month/MonthEventBar.vue', import.meta.url),
  'utf8'
)

describe('calendar recurring preview UI wiring', () => {
  it('uses the requested Apple-style switch label and accessible switch semantics', () => {
    expect(toolbar).toContain('<span id="calendar-recurring-preview-label">循环便签预览</span>')
    expect(toolbar).toContain('class="month-toolbar__recurring-preview-toggle"')
    expect(toolbar).toContain('role="switch"')
    expect(toolbar).toContain(':aria-checked="recurringPreviewEnabled"')
    expect(toolbar).toContain('width: 36rem;')
    expect(toolbar).toContain('height: 20rem;')
    expect(toolbar).toContain('border-radius: 10rem;')
    expect(toolbar).toContain('top: 2rem;')
    expect(toolbar).toContain('transform: translateX(16rem);')
    expect(toolbar).toContain('background-color: var(--ui-accent);')
  })

  it('persists one shared setting and requests previews for every calendar reload path', () => {
    expect(workspace).toContain("setSettingValue('calendar.recurringPreviewEnabled', next)")
    expect(workspace).toContain('includeRecurringPreviews: recurringPreviewEnabled.value')
    expect(workspace).toContain('window.api.onTemplatesChanged?.(queueNotesRefresh)')
    expect(workspace).toContain(':recurring-previews="calendarData.recurringPreviews || []"')
  })

  it('keeps preview bars muted and outside quick-edit and context-menu actions', () => {
    expect(eventBar).toContain("props.note.preview_kind === 'recurrence'")
    expect(eventBar).toContain('if (isRecurringPreview.value) return')
    expect(eventBar).toContain(
      'v-if="!isRecurringPreview && quickEditorVisible && quickEditorAnchor"'
    )
    expect(eventBar).toContain('box-shadow: none;')
    expect(eventBar).toContain('opacity: 0.72;')
  })
})
