import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MONTH_EVENT_BAR_PATH = new URL(
  '../src/renderer/src/components/month/MonthEventBar.vue',
  import.meta.url
)

describe('月历便签横条完成态', () => {
  it('完成态始终使用灰色背景，不被标签颜色覆盖', () => {
    const source = readFileSync(MONTH_EVENT_BAR_PATH, 'utf8')
    const completedGuard = source.indexOf("if (props.note.status === 'completed') return '#8e8e93'")
    const tagColorLookup = source.indexOf('const tagColor = props.note.tags?.[0]?.color')

    expect(completedGuard).toBeGreaterThan(-1)
    expect(tagColorLookup).toBeGreaterThan(completedGuard)
    expect(source).toContain('color: #fff;')
  })

  it('横条只显示便签正文，不额外拼接已完成文字', () => {
    const source = readFileSync(MONTH_EVENT_BAR_PATH, 'utf8')

    expect(source).toContain('<span class="month-event-bar__text">{{ previewText }}</span>')
    expect(source).toContain(':aria-label="fullTitle"')
    expect(source).not.toMatch(/已完成[：·]/)
  })
})
