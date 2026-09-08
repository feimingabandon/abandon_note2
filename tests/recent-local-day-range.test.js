import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local search and timeline boundaries', () => {
  it.each([
    ['America/New_York', '2026-03-08', 1, '2026-03-08', 23],
    ['America/New_York', '2026-11-01', 1, '2026-11-01', 25],
    ['America/New_York', '2026-03-10', 3, '2026-03-08', 71],
    ['America/New_York', '2026-11-03', 3, '2026-11-01', 73],
    ['Asia/Shanghai', '2026-03-08', 1, '2026-03-08', 24],
    ['Asia/Shanghai', '2026-01-01', 3, '2025-12-30', 72],
    ['UTC', '2024-03-01', 3, '2024-02-28', 72]
  ])('%s %s covers %i local days', (tz, today, days, expectedStart, hours) => {
    // 单独进程设置 TZ，不修改测试宿主或系统时区；执行两个 Vue 文件的实际入口。
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        String.raw`
      import { readFileSync } from 'node:fs'
      import { recentLocalDayRange, localDateKey } from './src/shared/calendar/calendar-date-rules.js'
      const now = new Date('${today}T12:00:00').getTime()
      class Clock extends Date { static now() { return now } }
      const search = readFileSync('src/renderer/src/components/list/SearchBox.vue', 'utf8')
      const begin = search.indexOf('function selectedTimeRange(')
      const end = search.indexOf('function searchOptions(', begin)
      const range = new Function('Date', 'timePreset', 'recentLocalDayRange', search.slice(begin,end) + ';return selectedTimeRange()')
        (Clock, {value: ${days} === 3 ? '3days' : 'today'}, recentLocalDayRange)
      const list = readFileSync('src/renderer/src/components/list/NoteList.vue', 'utf8')
      const cutoffBody = list.match(/function threeDayCutoff\(\) \{([\s\S]*?)\n\}/)[1]
      const cutoff = new Function('Date', 'recentLocalDayRange', cutoffBody)(Clock, recentLocalDayRange)
      const at = value => { const d = new Date(value); return [localDateKey(value),d.getHours(),d.getMinutes(),d.getSeconds(),d.getMilliseconds()] }
      console.log(JSON.stringify({start:at(range.timeFrom),end:at(range.timeTo),hours:(range.timeTo-range.timeFrom+1)/3600000,
        cutoff:at(cutoff+1),threeDayStart:at(recentLocalDayRange(now,3).timeFrom)}))
    `
      ],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8', windowsHide: true }
    )
    const result = JSON.parse(output)
    expect(result.start).toEqual([expectedStart, 0, 0, 0, 0])
    expect(result.end).toEqual([today, 23, 59, 59, 999])
    expect(result.hours).toBe(hours)
    expect(result.cutoff).toEqual(result.threeDayStart)
  })
})
