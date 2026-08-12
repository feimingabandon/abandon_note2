import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.ABANDON_HOLIDAY_TEST_USER_DATA,
    getVersion: () => 'test-version'
  }
}))

let service
let testRoot

function createYearData(year) {
  return {
    holidays: {
      [`${year}-01-01`]: "New Year's Day,元旦,1",
      [`${year}-01-02`]: "New Year's Day,元旦,1"
    },
    workdays: {
      [`${year}-01-03`]: "New Year's Day,元旦,1"
    },
    inLieuDays: {
      [`${year}-01-02`]: "New Year's Day,元旦,1"
    }
  }
}

beforeAll(async () => {
  service = await import('../src/main/calendar/holiday-data-service.js')
})

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'abandon-holiday-test-'))
  process.env.ABANDON_HOLIDAY_TEST_USER_DATA = testRoot
  service.resetHolidayDataCachesForTests()
})

afterEach(() => {
  service.resetHolidayDataCachesForTests()
  rmSync(testRoot, { recursive: true, force: true })
  delete process.env.ABANDON_HOLIDAY_TEST_USER_DATA
})

describe('holiday data service', () => {
  it('以内置 chinese-days 数据作为默认来源', () => {
    expect(service.getHolidayDataStatus(2026)).toMatchObject({
      year: 2026,
      available: true,
      source: 'built-in'
    })
    expect(service.getHolidayMetadata('2026-10-01')).toMatchObject({
      type: 'off',
      name: '国庆节'
    })
  })

  it('只为缺失年份生成一次提醒', async () => {
    expect(service.getMissingHolidayDataNotice(2027)).toMatchObject({
      required: true,
      year: 2027
    })

    await service.dismissMissingHolidayDataNotice(2027)
    expect(service.getMissingHolidayDataNotice(2027).required).toBe(false)
  })

  it('手动导入的数据覆盖对应年份并保留来源', async () => {
    const importPath = join(testRoot, '2027.json')
    writeFileSync(importPath, JSON.stringify(createYearData(2027)), 'utf8')

    const result = await service.importHolidayDataFile(importPath)

    expect(result.importedYears).toEqual([2027])
    expect(service.getHolidayDataStatus(2027)).toMatchObject({
      available: true,
      source: 'import',
      sourceName: '2027.json'
    })
    expect(service.getHolidayMetadata('2027-01-03')).toEqual({
      type: 'work',
      name: '元旦',
      inLieu: false
    })
  })

  it('下载内容校验成功后才写入用户数据', async () => {
    const text = JSON.stringify(createYearData(2028))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(Buffer.byteLength(text)) },
      arrayBuffer: async () => Buffer.from(text)
    }))

    await service.downloadHolidayData(2028, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/npm/chinese-days/dist/years/2028.json',
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(service.getHolidayDataStatus(2028)).toMatchObject({
      available: true,
      source: 'download'
    })
  })
})
