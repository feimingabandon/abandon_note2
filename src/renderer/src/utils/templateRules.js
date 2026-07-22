export const FREQUENCY_OPTIONS = [
  { value: 'daily', label: '天' },
  { value: 'weekly', label: '周' },
  { value: 'monthly', label: '月' },
  { value: 'yearly', label: '年' }
]
export const MAX_DAILY_INTERVAL = 3650

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export function normalizeYearDates(values) {
  const unique = new Map()
  for (const value of values || []) {
    const month = Number(value?.month)
    const day = Number(value?.day)
    const maxDay =
      Number.isInteger(month) && month >= 1 && month <= 12 ? new Date(2024, month, 0).getDate() : 0
    if (!Number.isInteger(day) || day < 1 || day > maxDay) continue
    unique.set(`${month}-${day}`, { month, day })
  }
  return [...unique.values()].sort((a, b) => a.month - b.month || a.day - b.day)
}

export function parseTemplateRule(value) {
  try {
    const rule = typeof value === 'string' ? JSON.parse(value) : value
    return rule && typeof rule === 'object' ? rule : null
  } catch {
    return null
  }
}

export function formatRuleSummary(value) {
  const rule = parseTemplateRule(value)
  if (!rule) return '生成规则不可用'
  const time = rule.time_of_day || '--:--'
  if (rule.frequency === 'daily') return `每 ${Number(rule.interval) || 1} 天 · ${time}`
  if (rule.frequency === 'weekly') {
    const days = (rule.days_of_week || []).map((day) => WEEKDAYS[Number(day) - 1]).filter(Boolean)
    return `每周${days.join('、')} · ${time}`
  }
  if (rule.frequency === 'monthly')
    return `每月 ${(rule.days_of_month || []).join('、')} 日 · ${time}`
  if (rule.frequency === 'yearly') {
    const dates = (rule.dates_of_year || []).map(({ month, day }) => `${month}月${day}日`)
    return `每年 ${dates.join('、')} · ${time}`
  }
  return '生成规则不可用'
}

export function templateState(template) {
  if (Number(template?.is_deleted) === 1) return { key: 'deleted', label: '已删除' }
  if (Number(template?.is_paused) === 1 && template?.pause_reason === 'error')
    return { key: 'error', label: '错误暂停' }
  if (Number(template?.is_paused) === 1) return { key: 'paused', label: '已暂停' }
  return { key: 'running', label: '运行中' }
}

export function filterAndSortTemplates(templates, filters) {
  const text = String(filters.text || '').toLocaleLowerCase()
  const selectedTags = filters.tags || []
  const rows = (templates || []).filter((template) => {
    const rule = parseTemplateRule(template.recurrence_rule)
    if (
      text &&
      !String(template.content || '')
        .toLocaleLowerCase()
        .includes(text)
    )
      return false
    if (filters.frequency !== 'all' && rule?.frequency !== filters.frequency) return false
    const names = (template.tags || []).map((tag) => tag.name)
    if (selectedTags.length && !selectedTags.every((name) => names.includes(name))) return false
    if (filters.pinned && Number(template.is_pinned) !== 1) return false
    if (filters.notify && Number(template.notify_enabled) !== 1) return false
    return true
  })
  const field =
    filters.sort === 'created'
      ? 'created_at'
      : filters.sort === 'updated'
        ? 'updated_at'
        : 'next_run_at'
  return rows.sort((a, b) => {
    const av = a[field] === null || a[field] === undefined ? Number.NaN : Number(a[field])
    const bv = b[field] === null || b[field] === undefined ? Number.NaN : Number(b[field])
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return Number(b.id) - Number(a.id)
    if (!Number.isFinite(av)) return 1
    if (!Number.isFinite(bv)) return -1
    return field === 'next_run_at' ? av - bv : bv - av
  })
}

export function formatTemplateTime(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(Number(timestamp)))
}

export function formatTemplateNextRun(timestamp, now = Date.now()) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return ''
  const targetTime = Number(timestamp)
  const currentTime = Number(now)
  if (!Number.isFinite(targetTime) || !Number.isFinite(currentTime)) return ''

  const diff = targetTime - currentTime
  if (diff <= 0) return '即将执行'

  const target = new Date(targetTime)
  const current = new Date(currentTime)
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate())
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate())
  const dayDiff = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000)
  const minutes = Math.ceil(diff / 60_000)

  if (minutes < 60) return `${minutes}分钟后执行`
  if (dayDiff === 0) return '今天执行'
  if (dayDiff === 1) return '明天执行'
  if (dayDiff === 2) return '后天执行'
  return `${dayDiff}天后执行`
}

export function createTemplateFormSnapshot(payload = {}) {
  return JSON.stringify({
    content: String(payload.content ?? ''),
    recurrenceRule: payload.recurrenceRule || null,
    notifyEnabled: Boolean(payload.notifyEnabled),
    isPinned: Boolean(payload.isPinned),
    tagNames: [...(payload.tagNames || [])].map(String).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  })
}

export function isTemplateEditTarget(template, id) {
  if (!template || id === null || id === undefined) return false
  return String(template.id) === String(id)
}
