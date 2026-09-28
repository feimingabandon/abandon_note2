import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeatherService } from '../src/main/services/weather-service.js'

const temporaryDirectories = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createService(fetchImpl, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'abandon-weather-test-'))
  temporaryDirectories.push(directory)
  const cachePath = join(directory, 'weather.json')
  return { service: new WeatherService({ cachePath, fetchImpl, ...options }), cachePath }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const beijing = {
  name: '北京',
  admin1: '北京市',
  admin2: '',
  country: '中国',
  countryCode: 'CN',
  latitude: 39.9075,
  longitude: 116.39723,
  timezone: 'Asia/Shanghai'
}

const tokyo = {
  name: '东京',
  admin1: '东京都',
  admin2: '',
  country: '日本',
  countryCode: 'JP',
  latitude: 35.6762,
  longitude: 139.6503,
  timezone: 'Asia/Tokyo'
}

function validForecast() {
  return {
    timezone: 'Asia/Shanghai',
    utc_offset_seconds: 28800,
    current: {
      time: '2026-09-28T21:00',
      temperature_2m: 27,
      apparent_temperature: 32,
      weather_code: 0,
      is_day: 0
    },
    daily: {
      time: ['2026-09-28'],
      weather_code: [51],
      temperature_2m_min: [26],
      temperature_2m_max: [35],
      precipitation_sum: [1.7]
    }
  }
}

describe('WeatherService', () => {
  it.each([
    {},
    null,
    { daily: {} },
    { current: validForecast().current },
    {
      daily: {
        time: ['2026-09-28'],
        weather_code: [0],
        temperature_2m_min: [null],
        temperature_2m_max: [null]
      }
    }
  ])('preserves useful cache after an unusable HTTP 200 response: %j', async (invalid) => {
    let body = validForecast()
    const { service, cachePath } = await createService(async () => jsonResponse(body))
    const first = await service.getForecast(beijing)
    const saved = await readFile(cachePath, 'utf8')
    body = invalid
    const result = await service.getForecast(beijing, { refresh: true })
    expect(result.days).toEqual(first.days)
    expect(result.fetchedAt).toBe(first.fetchedAt)
    expect(result.cache).toMatchObject({ hit: true, stale: true })
    expect(result.warning).toContain('未返回有效日预报')
    expect(await readFile(cachePath, 'utf8')).toBe(saved)
  })

  it('uses valid automatic data when the primary model returns an empty success', async () => {
    const { service } = await createService(async (url) =>
      jsonResponse(new URL(url).searchParams.has('models') ? {} : validForecast())
    )
    const result = await service.getForecast(beijing)
    expect(result.days).toHaveLength(1)
    expect(result.source.model.id).toBe('auto')
    expect(result.cache.stale).toBe(false)
  })

  it('rejects empty or malformed data without a cache, and does not coerce invalid numbers', async () => {
    const body = validForecast()
    body.daily = {
      time: ['2026-02-30', '2026-09-28', '2026-09-29', '2026-09-30'],
      weather_code: [0, 0, 0.1, 0],
      temperature_2m_min: [20, false, 20, 20.4],
      temperature_2m_max: [30, 30, 30, 20.3]
    }
    const { service } = await createService(async () => jsonResponse(body))
    await expect(service.getForecast(beijing)).rejects.toThrow('未返回有效日预报')
    expect(await service.getForecast(beijing, { cacheOnly: true })).toBeNull()
  })

  it('retains real sub-zero rounded ranges through a v4 cache reload', async () => {
    const body = validForecast()
    body.daily.temperature_2m_min = [-0.4]
    body.daily.temperature_2m_max = [0.4]
    const { service, cachePath } = await createService(async () => jsonResponse(body))
    const result = await service.getForecast(beijing)
    expect(result.days).toHaveLength(1)
    expect(Math.abs(result.days[0].temperatureMin)).toBe(0)
    expect(result.days[0].temperatureMax).toBe(0)
    const fetchImpl = vi.fn()
    const reloaded = new WeatherService({ cachePath, fetchImpl })
    expect((await reloaded.getForecast(beijing, { cacheOnly: true })).days).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['2026-09-28T14:00', '2026-09-28T18:30', '2026-09-28T20:45'])(
    'prefers fresh current data over an older primary reading at %s',
    async (primaryTime) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-28T13:05:00Z'))
      const { service } = await createService(async (url) => {
        const body = validForecast()
        if (new URL(url).searchParams.has('models')) {
          body.current.time = primaryTime
          body.current.weather_code = 51
        }
        return jsonResponse(body)
      })
      const result = await service.getForecast(beijing)
      expect(result.current).toMatchObject({
        time: '2026-09-28T21:00',
        label: '晴',
        icon: '🌙',
        isDay: false,
        dataAt: Date.parse('2026-09-28T13:00:00Z'),
        source: { model: { id: 'auto' } }
      })
      expect(result.days[0].source.model.id).toBe('cma_grapes_global')
      expect(result.source.model.id).toBe('cma_grapes_global+auto')
    }
  )

  it('keeps coherent primary daily conditions while filling missing optional fields with provenance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-28T13:05:00Z'))
    const fetchImpl = vi.fn(async (url) => {
      const body = validForecast()
      const primary = new URL(url).searchParams.has('models')
      body.daily.precipitation_probability_max = [primary ? null : 80]
      body.daily.precipitation_sum = [primary ? 0 : 4]
      body.daily.wind_speed_10m_max = [primary ? null : 18]
      if (!primary) {
        body.daily.weather_code = [95]
        body.daily.temperature_2m_max = [30]
      }
      return jsonResponse(body)
    })
    const { service } = await createService(fetchImpl)
    const result = await service.getForecast(beijing)
    expect(result.days[0]).toMatchObject({
      label: '毛毛雨',
      temperatureMax: 35,
      precipitation: 0,
      precipitationProbability: 80,
      windSpeedMax: 18,
      source: { model: { id: 'cma_grapes_global' } },
      fieldSources: {
        precipitationProbability: { model: { id: 'auto' } },
        windSpeedMax: { model: { id: 'auto' } }
      }
    })
    expect(result.days[0].fieldSources).not.toHaveProperty('precipitation')
    expect(result.current.source.model.id).toBe('cma_grapes_global')
    expect(result.source.model.id).toBe('cma_grapes_global+auto')
    for (const [url] of fetchImpl.mock.calls)
      expect(new URL(url).searchParams.get('current').split(',')).toContain('is_day')
  })
  it('uses the injected application version in request headers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Tokyo',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const directory = await mkdtemp(join(tmpdir(), 'abandon-weather-agent-test-'))
    temporaryDirectories.push(directory)
    const service = new WeatherService({
      cachePath: join(directory, 'weather.json'),
      fetchImpl,
      userAgent: 'Abandon-Note/1.0.0'
    })

    await service.getForecast(tokyo)

    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe('Abandon-Note/1.0.0')
  })

  it('normalizes and caches the minimum daily forecast fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: {
          time: '2026-08-12T10:00',
          temperature_2m: 26.2,
          apparent_temperature: 30.1,
          weather_code: 80,
          wind_speed_10m: 4.2
        },
        daily: {
          time: ['2026-08-12'],
          weather_code: [80],
          temperature_2m_max: [31.4],
          temperature_2m_min: [23.6],
          precipitation_probability_max: [65],
          precipitation_sum: [3.2],
          wind_speed_10m_max: [17.8]
        }
      })
    )
    const { service, cachePath } = await createService(fetchImpl)

    const first = await service.getForecast(beijing)
    const second = await service.getForecast(beijing)

    expect(first.days[0]).toMatchObject({
      date: '2026-08-12',
      label: '局部阵雨',
      dailyWeatherCode: 80,
      temperatureMax: 31,
      temperatureMin: 24,
      precipitationProbability: 65,
      windSpeedMax: 18
    })
    expect(second.cache).toMatchObject({ hit: true, stale: false })
    expect(first.source.model).toMatchObject({
      id: 'cma_grapes_global',
      name: 'CMA GRAPES',
      provider: '中国气象局'
    })
    expect(
      fetchImpl.mock.calls.some(
        ([url]) => new URL(url).searchParams.get('models') === 'cma_grapes_global'
      )
    ).toBe(true)
    expect(fetchImpl.mock.calls.some(([url]) => !new URL(url).searchParams.has('models'))).toBe(
      true
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).forecasts).toBeTruthy()
  })

  it('keeps current conditions separate from the daily most-severe code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: {
          time: '2026-08-12T14:45',
          temperature_2m: 37.6,
          apparent_temperature: 41.6,
          weather_code: 0
        },
        daily: {
          time: ['2026-08-12', '2026-08-13'],
          weather_code: [95, 80],
          temperature_2m_max: [38, 35],
          temperature_2m_min: [27, 26]
        }
      })
    )
    const { service } = await createService(fetchImpl)

    const forecast = await service.getForecast(beijing)

    expect(forecast.days[0]).toMatchObject({
      weatherCode: 95,
      dailyWeatherCode: 95,
      label: '雷阵雨',
      icon: '⛈️'
    })
    expect(forecast.current).toMatchObject({ weatherCode: 0, label: '晴', temperature: 38 })
    expect(forecast.days[1]).toMatchObject({
      weatherCode: 80,
      dailyWeatherCode: 80,
      label: '局部阵雨'
    })
  })

  it('keeps Open-Meteo automatic model selection outside China', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Tokyo',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)

    const forecast = await service.getForecast(tokyo)

    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has('models')).toBe(false)
    expect(forecast.source.model).toMatchObject({ id: 'auto', name: '自动模型' })
  })

  it('falls back to stale cache when a refresh fails', async () => {
    const response = {
      timezone: 'Asia/Shanghai',
      current: null,
      daily: {
        time: ['2026-08-12'],
        weather_code: [0],
        temperature_2m_max: [30],
        temperature_2m_min: [20]
      }
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(response))
      .mockResolvedValueOnce(jsonResponse(response))
      .mockRejectedValueOnce(new Error('断网'))
      .mockRejectedValueOnce(new Error('断网'))
    const diagnosticLog = vi.fn()
    const { service } = await createService(fetchImpl, { diagnosticLog })
    await service.getForecast(beijing)

    const fallback = await service.getForecast(beijing, { refresh: true })

    expect(fallback.cache).toMatchObject({ hit: true, stale: true })
    expect(fallback.warning).toBe('断网')
    expect(diagnosticLog).toHaveBeenCalledWith(
      'warn',
      'weather.stale-cache',
      '天气更新失败，已返回旧缓存',
      expect.objectContaining({ reason: '断网' })
    )
  })

  it('records provider fallback and the actual model used by a network refresh', async () => {
    const diagnosticLog = vi.fn()
    const fetchImpl = vi.fn(async (requestUrl) => {
      const model = new URL(requestUrl).searchParams.get('models')
      if (model === 'cma_grapes_global') throw new Error('CMA unavailable')
      return jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_max: [30],
          temperature_2m_min: [20]
        }
      })
    })
    const { service } = await createService(fetchImpl, { diagnosticLog })

    const forecast = await service.getForecast(beijing, { trigger: 'test-refresh' })

    expect(forecast.source.model.id).toBe('auto')
    expect(diagnosticLog).toHaveBeenCalledWith(
      'warn',
      'weather.provider-fallback',
      '中国气象局天气模型失败，已使用自动模型',
      expect.objectContaining({
        trigger: 'test-refresh',
        failedModel: 'cma_grapes_global',
        actualModel: 'auto',
        reason: 'CMA unavailable'
      })
    )
    expect(diagnosticLog).toHaveBeenCalledWith(
      'info',
      'weather.network-refresh',
      '天气网络更新完成',
      expect.objectContaining({ trigger: 'test-refresh', actualModel: 'auto', dayCount: 1 })
    )
  })

  it('matches a Chinese district locally before resolving its district center', async () => {
    const fetchImpl = vi.fn()
    const { service } = await createService(fetchImpl)

    const guangdong = service.getChinaDivisionTree().find((item) => item.name === '广东省')
    const guangzhou = guangdong.children.find((item) => item.name === '广州市')
    const suggestion = guangzhou.children.find((item) => item.name === '增城区').candidate
    expect(suggestion).toMatchObject({
      name: '增城区',
      admin1: '广东省',
      admin2: '广州市',
      latitude: null,
      longitude: null
    })
    await expect(service.resolveLocation(suggestion)).resolves.toMatchObject({
      name: '增城区',
      admin1: '广东省',
      admin2: '广州市',
      latitude: 23.2905,
      longitude: 113.82958
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('provides a local province-city-district cascade without a network request', async () => {
    const fetchImpl = vi.fn()
    const { service } = await createService(fetchImpl)

    const tree = service.getChinaDivisionTree()
    const guangdong = tree.find((item) => item.name === '广东省')
    const guangzhou = guangdong.children.find((item) => item.name === '广州市')
    const zengcheng = guangzhou.children.find((item) => item.name === '增城区')
    const beijing = tree.find((item) => item.name === '北京市')
    const hongKong = tree.find((item) => item.name === '香港特别行政区')

    expect(zengcheng.candidate).toMatchObject({
      name: '增城区',
      admin1: '广东省',
      admin2: '广州市'
    })
    expect(beijing.children[0].name).toBe('北京市')
    expect(beijing.children[0].children.length).toBeGreaterThan(0)
    expect(hongKong.children[0].children[0]).toMatchObject({ name: '中西区' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reuses the saved forecast until a scheduled refresh is requested', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)

    await service.getForecast(beijing, { refresh: true })
    await service.getForecast(beijing)
    await service.getForecast(beijing, { refresh: true })

    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('does not let an obsolete location request replace the persisted cache', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)

    await service.getForecast(beijing, { shouldStore: () => false })
    const cached = await service.getForecast(beijing, { cacheOnly: true })

    expect(cached).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps successful network data when cache persistence fails without making another request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        daily: {
          time: ['2026-09-28'],
          weather_code: [95],
          temperature_2m_min: [18],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(service, 'saveCache').mockRejectedValue(new Error('disk full'))
    try {
      const result = await service.getForecast(beijing, { refresh: true })
      expect(result.cache.stale).toBe(false)
      expect(result.days[0].weatherCode).toBe(95)
      expect((await service.getForecast(beijing, { cacheOnly: true })).days).toEqual(result.days)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('does not reuse a forecast for a different district sharing the same coordinates', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)
    const sameCenterDistrict = { ...beijing, name: '同坐标地区', id: 123456 }

    await service.getForecast(beijing)
    await service.getForecast(sameCenterDistrict)

    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('avoids duplicate manual requests for five minutes and reports freshness', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_min: [20],
          temperature_2m_max: [30]
        }
      })
    )
    const { service } = await createService(fetchImpl)

    await service.getForecast(beijing, { refresh: true })
    const current = await service.refreshForecastManually(beijing)

    expect(current.manualRefresh.status).toBe('current')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('uses CMA first, fills missing Chinese dates with Best Match, and ignores null placeholders', async () => {
    const fetchImpl = vi.fn(async (requestUrl) => {
      const isCma = new URL(requestUrl).searchParams.get('models') === 'cma_grapes_global'
      return jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12', '2026-08-13', '2026-08-14'],
          weather_code: isCma ? [80, null, null] : [1, 61, null],
          temperature_2m_max: isCma ? [35, null, null] : [33, 32, null],
          temperature_2m_min: isCma ? [27, null, null] : [26, 25, null]
        }
      })
    })
    const { service } = await createService(fetchImpl)

    const forecast = await service.getForecast(beijing)

    expect(forecast.days).toHaveLength(2)
    expect(forecast.days[0]).toMatchObject({
      date: '2026-08-12',
      weatherCode: 80,
      temperatureMin: 27,
      temperatureMax: 35
    })
    expect(forecast.days[1]).toMatchObject({
      date: '2026-08-13',
      weatherCode: 61,
      temperatureMin: 25,
      temperatureMax: 32
    })
    expect(forecast.days.some((day) => day.temperatureMin === 0 && day.temperatureMax === 0)).toBe(
      false
    )
    expect(forecast.source.model).toMatchObject({
      id: 'cma_grapes_global+auto',
      name: 'CMA GRAPES + 自动补齐'
    })
  })

  it('migrates old caches and removes previously saved 0°–0° weather days', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12'],
          weather_code: [0],
          temperature_2m_max: [30],
          temperature_2m_min: [20]
        }
      })
    )
    const { service, cachePath } = await createService(fetchImpl)
    await service.getForecast(beijing)

    const oldCache = JSON.parse(await readFile(cachePath, 'utf8'))
    oldCache.version = 1
    const [forecast] = Object.values(oldCache.forecasts)
    forecast.days[0].dailyWeatherCode = 95
    forecast.days.push({
      date: '2026-08-20',
      weatherCode: 0,
      dailyWeatherCode: 0,
      label: '晴',
      icon: '☀️',
      temperatureMin: 0,
      temperatureMax: 0
    })
    await writeFile(cachePath, JSON.stringify(oldCache), 'utf8')

    const reloaded = new WeatherService({ cachePath, fetchImpl: vi.fn() })
    const cached = await reloaded.getForecast(beijing, { cacheOnly: true })
    const migrated = JSON.parse(await readFile(cachePath, 'utf8'))

    expect(cached.days.map((day) => day.date)).toEqual(['2026-08-12'])
    expect(cached.days[0]).toMatchObject({ weatherCode: 95, label: '雷阵雨' })
    expect(migrated.version).toBe(4)
    expect(Object.values(migrated.forecasts)[0].days.map((day) => day.date)).toEqual(['2026-08-12'])
  })
})
