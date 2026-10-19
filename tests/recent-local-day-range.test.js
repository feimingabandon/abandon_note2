import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local search and timeline boundaries', () => {
  it.each([
    ['America/New_York', '2026-03-08', 1, '2026-03-08', 23, '2026-03-06'],
    ['America/New_York', '2026-11-01', 1, '2026-11-01', 25, '2026-10-30'],
    ['America/New_York', '2026-03-10', 3, '2026-03-08', 71, '2026-03-08'],
    ['America/New_York', '2026-11-03', 3, '2026-11-01', 73, '2026-11-01'],
    ['Asia/Shanghai', '2026-03-08', 1, '2026-03-08', 24, '2026-03-06'],
    ['Asia/Shanghai', '2026-01-01', 3, '2025-12-30', 72, '2025-12-30'],
    ['UTC', '2024-03-01', 3, '2024-02-28', 72, '2024-02-28']
  ])('%s %s covers %i local days', (tz, today, days, expectedStart, hours, timelineStart) => {
    // 单独进程设置 TZ，不修改宿主时区；执行搜索函数和重构后的时间线实际查询入口。
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        String.raw`
      import { readFileSync } from 'node:fs'
      import { recentLocalDayRange, localDateKey } from './src/shared/calendar/calendar-date-rules.js'
      import { useTimelineListModel } from './src/renderer/src/composables/useTimelineListModel.js'
      const now = new Date('${today}T12:00:00').getTime()
      class Clock extends Date { static now() { return now } }
      globalThis.Date = Clock
      const search = readFileSync('src/renderer/src/components/list/SearchBox.vue', 'utf8')
      const begin = search.indexOf('function selectedTimeRange(')
      const end = search.indexOf('function searchOptions(', begin)
      const range = new Function('Date', 'timePreset', 'recentLocalDayRange', search.slice(begin,end) + ';return selectedTimeRange()')
        (Clock, {value: ${days} === 3 ? '3days' : 'today'}, recentLocalDayRange)
      const calls = []
      const model = useTimelineListModel({
        session: {
          begin: () => 1,
          filters: () => ({}),
          isCurrent: sequence => sequence === 1,
          setTotal() {}, markRefreshed() {}, finish() {}, onInvalidate() {},
          fail: () => { throw new Error('Timeline did not complete the fixture load') }
        },
        api: {
          queryPinnedNotes: async () => [],
          queryRecentNotes: async options => { calls.push({ query: 'recent', cutoff: options.cutoffTime }); return [] },
          queryEarlierNotes: async options => { calls.push({ query: 'earlier', cutoff: options.cutoffTime }); return { notes: [], total: 0 } },
          countActiveNotes: async () => 0
        },
        presentation: { restoreAnchor: async () => {} }
      })
      const load = await model.load()
      const at = value => { const d = new Date(value); return [localDateKey(value),d.getHours(),d.getMinutes(),d.getSeconds(),d.getMilliseconds()] }
      console.log(JSON.stringify({start:at(range.timeFrom),end:at(range.timeTo),hours:(range.timeTo-range.timeFrom+1)/3600000,
        loadStatus: load.status, timelineQueries: calls.map(call => ({ query: call.query, start: at(call.cutoff + 1) })) }))
    `
      ],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8', windowsHide: true }
    )
    const result = JSON.parse(output)
    expect(result.start).toEqual([expectedStart, 0, 0, 0, 0])
    expect(result.end).toEqual([today, 23, 59, 59, 999])
    expect(result.hours).toBe(hours)
    expect(result.loadStatus).toBe('success')
    expect(result.timelineQueries).toEqual([
      { query: 'recent', start: [timelineStart, 0, 0, 0, 0] },
      { query: 'earlier', start: [timelineStart, 0, 0, 0, 0] }
    ])
  })
})
