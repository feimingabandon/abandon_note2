import { weatherFreshness } from './weather-freshness.js'

export function weatherUpdateLabel(forecast, now = Date.now()) {
  if (!forecast?.fetchedAt) return '天气暂无获取时间'
  const updated = new Date(forecast.fetchedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  if (forecast.warning) return `更新失败 · 获取于 ${updated}`
  return `${weatherFreshness(forecast, now).stale ? '数据较旧 · ' : ''}获取于 ${updated}`
}

export function weatherValidTimeLabel(current, timezone) {
  if (!Number.isFinite(current?.dataAt)) return ''
  try {
    const time = new Date(current.dataAt).toLocaleString('zh-CN', {
      timeZone: timezone || 'UTC',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    return `天气时刻 ${time}（${timezone || 'UTC'}）`
  } catch {
    return ''
  }
}

export function weatherSourceLabel(source) {
  return [source?.name, source?.model?.name].filter(Boolean).join(' · ')
}

export function weatherSupplementLabel(day) {
  const labels = {
    precipitationProbability: '降水概率',
    precipitation: '降水量',
    windSpeedMax: '最大风速'
  }
  return Object.entries(day?.fieldSources || {})
    .filter(([field, source]) => labels[field] && weatherSourceLabel(source))
    .map(([field, source]) => `${labels[field]}由 ${weatherSourceLabel(source)} 补充`)
    .join('；')
}
