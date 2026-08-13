import { describe, expect, it } from 'vitest'
import {
  calendarGridNavigationTarget,
  calendarGridTabKey
} from '../src/renderer/src/utils/calendar-grid-navigation.js'

const days = Array.from({ length: 14 }, (_, index) => ({
  key: `day-${index + 1}`,
  isActive: index >= 2 && index <= 11
}))

describe('日历网格键盘导航', () => {
  it('只给选中日期、今天或首个有效日期一个 Tab 入口', () => {
    expect(calendarGridTabKey(days, 'day-6', 'day-5')).toBe('day-6')
    expect(calendarGridTabKey(days, 'outside', 'day-5')).toBe('day-5')
    expect(calendarGridTabKey(days, 'outside', 'outside')).toBe('day-3')
  })

  it('按日、按周以及按行首尾移动，并阻止进入无效日期', () => {
    expect(calendarGridNavigationTarget(days, 'day-5', 'ArrowRight')?.key).toBe('day-6')
    expect(calendarGridNavigationTarget(days, 'day-5', 'ArrowDown')?.key).toBe('day-12')
    expect(calendarGridNavigationTarget(days, 'day-5', 'Home')?.key).toBe('day-3')
    expect(calendarGridNavigationTarget(days, 'day-5', 'End')?.key).toBe('day-7')
    expect(calendarGridNavigationTarget(days, 'day-3', 'ArrowLeft')).toBeNull()
    expect(calendarGridNavigationTarget(days, 'day-12', 'ArrowDown')).toBeNull()
  })
})
