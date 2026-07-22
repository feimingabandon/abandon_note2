import { describe, expect, it } from 'vitest'
import {
  createTemplateFormSnapshot,
  filterAndSortTemplates,
  formatRuleSummary,
  formatTemplateNextRun,
  isTemplateEditTarget,
  normalizeYearDates,
  parseTemplateRule,
  templateState
} from '../src/renderer/src/utils/templateRules.js'

describe('template UI rule formatting', () => {
  it.each([
    [{ frequency: 'daily', interval: 3, time_of_day: '09:00' }, '每 3 天 · 09:00'],
    [
      { frequency: 'weekly', days_of_week: [1, 3, 5], time_of_day: '09:00' },
      '每周一、三、五 · 09:00'
    ],
    [
      { frequency: 'monthly', days_of_month: [15, 31], time_of_day: '09:00' },
      '每月 15、31 日 · 09:00'
    ],
    [
      { frequency: 'yearly', dates_of_year: [{ month: 2, day: 29 }], time_of_day: '09:00' },
      '每年 2月29日 · 09:00'
    ]
  ])('formats %j', (rule, expected) => expect(formatRuleSummary(rule)).toBe(expected))

  it('handles invalid JSON without throwing', () => {
    expect(parseTemplateRule('{bad')).toBeNull()
    expect(formatRuleSummary('{bad')).toBe('生成规则不可用')
  })

  it('deduplicates, validates and sorts yearly month-day selections', () => {
    expect(
      normalizeYearDates([
        { month: 12, day: 31 },
        { month: 2, day: 29 },
        { month: 2, day: 29 },
        { month: 4, day: 31 },
        { month: 0, day: 1 }
      ])
    ).toEqual([
      { month: 2, day: 29 },
      { month: 12, day: 31 }
    ])
  })

  it.each([
    [30 * 60_000, '30分钟后执行'],
    [2 * 60 * 60_000, '今天执行'],
    [24 * 60 * 60_000, '明天执行'],
    [2 * 24 * 60 * 60_000, '后天执行'],
    [3 * 24 * 60 * 60_000, '3天后执行'],
    [8 * 24 * 60 * 60_000, '8天后执行']
  ])('formats the next run hint for a %i ms offset', (offset, expected) => {
    const now = new Date(2026, 6, 22, 10, 0).getTime()
    expect(formatTemplateNextRun(now + offset, now)).toBe(expected)
  })

  it('handles due and invalid next-run times', () => {
    const now = new Date(2026, 6, 22, 10, 0).getTime()
    expect(formatTemplateNextRun(now, now)).toBe('即将执行')
    expect(formatTemplateNextRun(null, now)).toBe('')
    expect(formatTemplateNextRun('invalid', now)).toBe('')
  })
})

describe('template UI state and filtering', () => {
  const rows = [
    {
      id: 1,
      content: '早餐',
      recurrence_rule: JSON.stringify({ frequency: 'daily' }),
      is_paused: 0,
      is_deleted: 0,
      is_pinned: 1,
      notify_enabled: 0,
      next_run_at: 300,
      tags: [{ name: '生活' }]
    },
    {
      id: 2,
      content: '周报',
      recurrence_rule: JSON.stringify({ frequency: 'weekly' }),
      is_paused: 1,
      is_deleted: 0,
      pause_reason: 'error',
      is_pinned: 0,
      notify_enabled: 1,
      next_run_at: null,
      tags: [{ name: '工作' }]
    },
    {
      id: 3,
      content: '月末',
      recurrence_rule: JSON.stringify({ frequency: 'monthly' }),
      is_paused: 1,
      is_deleted: 1,
      next_run_at: 100,
      tags: []
    }
  ]

  it('maps running, error paused and deleted states', () => {
    expect(templateState(rows[0]).key).toBe('running')
    expect(templateState(rows[1]).key).toBe('error')
    expect(templateState(rows[2]).key).toBe('deleted')
  })

  it('combines text, frequency, tags and switches', () => {
    const result = filterAndSortTemplates(rows, {
      text: '早餐',
      frequency: 'daily',
      tags: ['生活'],
      pinned: true,
      notify: false,
      sort: 'next'
    })
    expect(result.map((row) => row.id)).toEqual([1])
  })

  it('sorts null next-run values last', () => {
    const result = filterAndSortTemplates(rows, { frequency: 'all', tags: [], sort: 'next' })
    expect(result.map((row) => row.id)).toEqual([3, 1, 2])
  })
})

describe('template editor state guards', () => {
  const basePayload = {
    content: '保留原始正文\n第二行',
    recurrenceRule: {
      frequency: 'weekly',
      interval: 1,
      days_of_week: [1, 3],
      days_of_month: [],
      dates_of_year: [],
      time_of_day: '09:00'
    },
    notifyEnabled: true,
    isPinned: false,
    tagNames: ['工作', '重要']
  }

  it('detects semantic form changes while ignoring tag order', () => {
    const initial = createTemplateFormSnapshot(basePayload)
    expect(createTemplateFormSnapshot({ ...basePayload, tagNames: ['重要', '工作'] })).toBe(initial)
    expect(createTemplateFormSnapshot({ ...basePayload, content: '修改后的正文' })).not.toBe(
      initial
    )
    expect(createTemplateFormSnapshot({ ...basePayload, notifyEnabled: false })).not.toBe(initial)
    expect(
      createTemplateFormSnapshot({
        ...basePayload,
        recurrenceRule: { ...basePayload.recurrenceRule, days_of_week: [2] }
      })
    ).not.toBe(initial)
  })

  it('only lets a completed save close the editor for the same template', () => {
    expect(isTemplateEditTarget({ id: 8 }, 8)).toBe(true)
    expect(isTemplateEditTarget({ id: '8' }, 8)).toBe(true)
    expect(isTemplateEditTarget({ id: 9 }, 8)).toBe(false)
    expect(isTemplateEditTarget(null, 8)).toBe(false)
  })
})
