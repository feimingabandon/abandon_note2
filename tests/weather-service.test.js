import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeatherService } from '../src/main/services/weather-service.js'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createService(fetchImpl) {
  const directory = await mkdtemp(join(tmpdir(), 'abandon-weather-test-'))
  temporaryDirectories.push(directory)
  const cachePath = join(directory, 'weather.json')
  return { service: new WeatherService({ cachePath, fetchImpl }), cachePath }
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

describe('WeatherService', () => {
  it('uses the injected application version in request headers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Tokyo',
        current: null,
        daily: { time: ['2026-08-12'], weather_code: [0] }
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

  it('uses current conditions for today instead of the daily most-severe code', async () => {
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
      weatherCode: 0,
      dailyWeatherCode: 95,
      label: '晴',
      icon: '☀️'
    })
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
        daily: { time: ['2026-08-12'], weather_code: [0] }
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
    const { service } = await createService(fetchImpl)
    await service.getForecast(beijing)

    const fallback = await service.getForecast(beijing, { refresh: true })

    expect(fallback.cache).toMatchObject({ hit: true, stale: true })
    expect(fallback.warning).toBe('断网')
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
        daily: { time: ['2026-08-12'], weather_code: [0] }
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
        daily: { time: ['2026-08-12'], weather_code: [0] }
      })
    )
    const { service } = await createService(fetchImpl)

    await service.getForecast(beijing, { shouldStore: () => false })
    const cached = await service.getForecast(beijing, { cacheOnly: true })

    expect(cached).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a forecast for a different district sharing the same coordinates', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: { time: ['2026-08-12'], weather_code: [0] }
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
        daily: { time: ['2026-08-12'], weather_code: [0] }
      })
    )
    const { service } = await createService(fetchImpl)

    await service.getForecast(beijing, { refresh: true })
    const current = await service.refreshForecastManually(beijing)

    expect(current.manualRefresh.status).toBe('current')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('uses CMA first, fills missing Chinese dates with Best Match, and hides zero placeholders', async () => {
    const fetchImpl = vi.fn(async (requestUrl) => {
      const isCma = new URL(requestUrl).searchParams.get('models') === 'cma_grapes_global'
      return jsonResponse({
        timezone: 'Asia/Shanghai',
        current: null,
        daily: {
          time: ['2026-08-12', '2026-08-13', '2026-08-14'],
          weather_code: isCma ? [80, null, null] : [1, 61, 0],
          temperature_2m_max: isCma ? [35, null, null] : [33, 32, 0],
          temperature_2m_min: isCma ? [27, null, null] : [26, 25, 0]
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
    expect(migrated.version).toBe(2)
    expect(Object.values(migrated.forecasts)[0].days.map((day) => day.date)).toEqual(['2026-08-12'])
  })
})
