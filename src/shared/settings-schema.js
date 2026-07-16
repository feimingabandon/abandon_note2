/**
 * 持久化设置的唯一 schema。
 *
 * 该模块必须保持为纯 JavaScript：不能依赖 Electron、Node.js 或 DOM，
 * 以便主进程和渲染进程共同使用同一份默认值、解析规则和数据库映射。
 *
 * autoStart 刻意不在这里：开机自启以操作系统真实状态为准，不写入 app_settings。
 */

const VALID_NOTE_STATUSES = new Set(['initialized', 'in_progress', 'completed', 'cancelled'])

const DEFAULT_LIST_FILTER = {
  listMode: 'timeline',
  tagNames: [],
  statusFilter: ['initialized', 'in_progress', 'completed']
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]))
  }
  return value
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return fallback
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = clamp(parsed, min, max)
  return integer ? Math.round(normalized) : normalized
}

function parseNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function parseBoolean(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function parseRgbChannels(value, fallback) {
  const channels = String(value ?? '')
    .trim()
    .split(/\s+/)
    .map(Number)
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return fallback
  }
  return channels.map((channel) => clamp(Math.round(channel), 0, 255)).join(' ')
}

function parseHexColor(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return '#' + [...normalized.slice(1)].map((character) => character.repeat(2)).join('')
  }
  return fallback
}

function parseListFilter(value, fallback) {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return cloneValue(fallback)
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return cloneValue(fallback)
  }

  const listMode = candidate.listMode === 'custom' ? 'custom' : 'timeline'
  const tagNames = Array.isArray(candidate.tagNames)
    ? [...new Set(candidate.tagNames.filter((name) => typeof name === 'string' && name.trim()))]
    : []
  const hasStatusFilter = Array.isArray(candidate.statusFilter)
  const statuses = hasStatusFilter
    ? [...new Set(candidate.statusFilter.filter((status) => VALID_NOTE_STATUSES.has(status)))]
    : []

  return {
    listMode,
    tagNames,
    // 空数组是合法状态，表示“不额外筛选”；只有字段缺失/类型错误才回退默认值。
    statusFilter: hasStatusFilter ? statuses : cloneValue(fallback.statusFilter)
  }
}

const definitions = [
  {
    id: 'css.bgColor',
    path: ['css', 'bgColor'],
    db: { type: 'css', key: 'bg_color' },
    defaultValue: '255 255 255',
    parse: parseRgbChannels,
    serialize: String,
    remark: '背景颜色（RGB 三通道，如 255 255 255）'
  },
  {
    id: 'css.popupOpacity',
    path: ['css', 'popupOpacity'],
    db: { type: 'css', key: 'win_opacity' },
    defaultValue: 0.5,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 1 }),
    serialize: String,
    remark: '组件透明度（0~1 浮点数）'
  },
  {
    id: 'css.bgBlur',
    path: ['css', 'bgBlur'],
    db: { type: 'css', key: 'bg_blur' },
    defaultValue: 5,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 30 }),
    serialize: String,
    remark: 'CSS 背景模糊半径（像素）'
  },
  {
    id: 'css.bgSaturation',
    path: ['css', 'bgSaturation'],
    db: { type: 'css', key: 'bg_saturation' },
    defaultValue: 1.8,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 2 }),
    serialize: String,
    remark: 'CSS 饱和度（0~2 浮点数）'
  },
  {
    id: 'css.windowOpacity',
    path: ['css', 'windowOpacity'],
    db: { type: 'css', key: 'window_opacity' },
    defaultValue: 0.5,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 1 }),
    serialize: String,
    remark: '窗口透明度（0~1 浮点数）'
  },
  {
    id: 'css.bgBorder',
    path: ['css', 'bgBorder'],
    db: { type: 'css', key: 'bg_border' },
    defaultValue: true,
    parse: parseBoolean,
    serialize: (value) => (value ? '1' : '0'),
    remark: '边框显示开关（1=显示, 0=隐藏）'
  },
  {
    id: 'css.fontSizeBase',
    path: ['css', 'fontSizeBase'],
    db: { type: 'css', key: 'font_size_base' },
    defaultValue: 18,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 14, max: 22, integer: true }),
    serialize: String,
    remark: '基准字号（rem 单位数值）'
  },
  {
    id: 'css.textColor',
    path: ['css', 'textColor'],
    db: { type: 'css', key: 'text_color' },
    defaultValue: '#000000',
    parse: parseHexColor,
    serialize: String,
    remark: '文字颜色（十六进制）'
  },
  {
    id: 'blur.enabled',
    path: ['blur', 'enabled'],
    db: { type: 'system', key: 'blur_enabled' },
    defaultValue: true,
    parse: parseBoolean,
    serialize: String,
    remark: '系统级毛玻璃效果开关'
  },
  {
    id: 'blur.radius',
    path: ['blur', 'radius'],
    db: { type: 'system', key: 'blur_radius' },
    defaultValue: 15,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 100 }),
    serialize: String,
    remark: '系统模糊半径（0~100 DIP）'
  },
  {
    id: 'blur.opacity',
    path: ['blur', 'opacity'],
    db: { type: 'system', key: 'blur_opacity' },
    defaultValue: 1,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 1 }),
    serialize: String,
    remark: '系统模糊层透明度（0~1 浮点数）'
  },
  {
    id: 'blur.tint.r',
    path: ['blur', 'tint', 'r'],
    db: { type: 'system', key: 'blur_tint_r' },
    defaultValue: 255,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 255, integer: true }),
    serialize: String,
    remark: '系统模糊着色红色通道'
  },
  {
    id: 'blur.tint.g',
    path: ['blur', 'tint', 'g'],
    db: { type: 'system', key: 'blur_tint_g' },
    defaultValue: 255,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 255, integer: true }),
    serialize: String,
    remark: '系统模糊着色绿色通道'
  },
  {
    id: 'blur.tint.b',
    path: ['blur', 'tint', 'b'],
    db: { type: 'system', key: 'blur_tint_b' },
    defaultValue: 255,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 255, integer: true }),
    serialize: String,
    remark: '系统模糊着色蓝色通道'
  },
  {
    id: 'blur.saturation',
    path: ['blur', 'saturation'],
    db: { type: 'system', key: 'blur_saturation' },
    defaultValue: 1.8,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 2 }),
    serialize: String,
    remark: '系统模糊饱和度（0~2 浮点数）'
  },
  {
    id: 'blur.cornerRadius',
    path: ['blur', 'cornerRadius'],
    db: { type: 'system', key: 'blur_corner_radius' },
    defaultValue: 12,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 30 }),
    serialize: String,
    remark: '窗口圆角半径（0~30 DIP）'
  },
  {
    id: 'window.lockState',
    path: ['window', 'lockState'],
    db: { type: 'system', key: 'lock_state' },
    defaultValue: false,
    parse: parseBoolean,
    serialize: String,
    remark: '窗口锁定状态'
  },
  {
    id: 'window.alwaysOnTop',
    path: ['window', 'alwaysOnTop'],
    db: { type: 'system', key: 'always_on_top' },
    defaultValue: true,
    parse: parseBoolean,
    serialize: String,
    remark: '窗口置顶状态'
  },
  {
    id: 'listFilter',
    path: ['listFilter'],
    db: { type: 'filter', key: 'list_filter' },
    defaultValue: DEFAULT_LIST_FILTER,
    parse: parseListFilter,
    serialize: JSON.stringify,
    remark: '便签列表模式、标签及状态筛选'
  },
  {
    id: 'geometry.posX',
    path: ['geometry', 'posX'],
    db: { type: 'geometry', key: 'pos_x' },
    defaultValue: null,
    parse: parseNullableInteger,
    serialize: String,
    remark: '窗口左上角 X 坐标（像素）'
  },
  {
    id: 'geometry.posY',
    path: ['geometry', 'posY'],
    db: { type: 'geometry', key: 'pos_y' },
    defaultValue: null,
    parse: parseNullableInteger,
    serialize: String,
    remark: '窗口左上角 Y 坐标（像素）'
  },
  {
    id: 'geometry.width',
    path: ['geometry', 'width'],
    db: { type: 'geometry', key: 'width' },
    defaultValue: null,
    parse: parseNullableInteger,
    serialize: String,
    remark: '窗口宽度（像素）'
  },
  {
    id: 'geometry.height',
    path: ['geometry', 'height'],
    db: { type: 'geometry', key: 'height' },
    defaultValue: null,
    parse: parseNullableInteger,
    serialize: String,
    remark: '窗口高度（像素）'
  },
  {
    id: 'geometry.widthRatio',
    path: ['geometry', 'widthRatio'],
    db: null,
    defaultValue: 0.25,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0.1, max: 1 }),
    serialize: String,
    remark: '无持久化窗口宽度时使用的屏幕比例'
  },
  {
    id: 'geometry.heightRatio',
    path: ['geometry', 'heightRatio'],
    db: null,
    defaultValue: 0.9,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0.1, max: 1 }),
    serialize: String,
    remark: '无持久化窗口高度时使用的屏幕比例'
  }
]

export const SETTING_DEFINITIONS = deepFreeze(definitions)

const definitionById = new Map(SETTING_DEFINITIONS.map((definition) => [definition.id, definition]))

function setAtPath(target, path, value) {
  let cursor = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]
    if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = {}
    cursor = cursor[segment]
  }
  cursor[path[path.length - 1]] = value
}

function getAtPath(target, path) {
  return path.reduce((cursor, segment) => cursor?.[segment], target)
}

function buildDefaults() {
  const defaults = {}
  SETTING_DEFINITIONS.forEach((definition) => {
    setAtPath(defaults, definition.path, cloneValue(definition.defaultValue))
  })
  return defaults
}

export const DEFAULT_SETTINGS = deepFreeze(buildDefaults())

/** 返回一份可安全修改的默认设置。 */
export function createDefaultSettings() {
  return cloneValue(DEFAULT_SETTINGS)
}

/**
 * 将 app_settings 查询结果解析为完整设置。数据库值优先；缺失或非法时回退默认。
 * @param {Array<{type: string, key: string, value: unknown}>} rows
 */
export function resolveSettingsRows(rows = []) {
  const resolved = createDefaultSettings()
  const rowByDbKey = new Map(rows.map((row) => [`${row.type}:${row.key}`, row]))

  SETTING_DEFINITIONS.forEach((definition) => {
    if (!definition.db) return
    const row = rowByDbKey.get(`${definition.db.type}:${definition.db.key}`)
    if (!row) return
    const fallback = cloneValue(definition.defaultValue)
    setAtPath(resolved, definition.path, definition.parse(row.value, fallback))
  })

  return resolved
}

/** 将一个逻辑设置值规范化并转换为可写入 app_settings 的记录。 */
export function serializeSetting(id, value) {
  const definition = definitionById.get(id)
  if (!definition) throw new Error(`未知设置项: ${id}`)
  if (!definition.db) throw new Error(`设置项不持久化: ${id}`)

  const normalized = definition.parse(value, cloneValue(definition.defaultValue))
  return {
    id,
    type: definition.db.type,
    key: definition.db.key,
    // nullable 设置使用真正的 SQL NULL；绝不能序列化成字符串 "null"。
    value: normalized === null ? null : definition.serialize(normalized),
    remark: definition.remark
  }
}

/** 将完整设置对象中的所有持久化字段序列化为数据库记录。 */
export function serializeSettings(values) {
  return SETTING_DEFINITIONS.filter(
    (definition) => definition.db && getAtPath(values, definition.path) != null
  ).map((definition) => serializeSetting(definition.id, getAtPath(values, definition.path)))
}
