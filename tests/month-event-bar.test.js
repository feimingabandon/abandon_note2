import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MONTH_EVENT_BAR_PATH = new URL(
  '../src/renderer/src/components/month/MonthEventBar.vue',
  import.meta.url
)

describe('月历便签横条完成态', () => {
  it('完成态始终使用灰色背景，不被标签颜色覆盖', () => {
    const source = readFileSync(MONTH_EVENT_BAR_PATH, 'utf8')

    expect(source).toContain('getCalendarNoteAccent(props.note')
    expect(source).toContain('tagColorEnabled: tagColorEnabled.value')
    expect(source).toContain('color: #fff;')
  })

  it('横条只显示便签正文，不额外拼接已完成文字', () => {
    const source = readFileSync(MONTH_EVENT_BAR_PATH, 'utf8')

    expect(source).toContain('v-for="(colorSegment, index) in previewSegments"')
    expect(source).toContain('colorSegment.color ? { color: colorSegment.color } : undefined')
    expect(source).toContain(':aria-label="fullTitle"')
    expect(source).not.toMatch(/已完成[：·]/)
  })
})
