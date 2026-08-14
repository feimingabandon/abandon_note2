/**
 * 持久化设置的唯一 schema。
 *
 * 该模块必须保持为纯 JavaScript：不能依赖 Electron、Node.js 或 DOM，
 * 以便主进程和渲染进程共同使用同一份默认值、解析规则和数据库映射。
 *
 * autoStart 刻意不在这里：开机自启以操作系统真实状态为准，不写入 app_settings。
 */

const VALID_NOTE_STATUSES = new Set(['initialized', 'in_progress', 'completed'])
export const DOCK_EDGES = Object.freeze(['top', 'left', 'right'])
const MAX_DOCK_EDGE_ENTRIES = 12

const DEFAULT_LIST_FILTER = {
  listMode: 'timeline',
  tagIds: [],
  statusFilter: ['initialized', 'in_progress', 'completed']
}

export const VIEW_MODES = Object.freeze({
  LIST: 'list',
  MONTH: 'month',
  WEEK: 'week'
})

/** 当前首次使用须知版本；以后正文发生重大变化时递增即可重新提示一次。 */
export const FIRST_USE_NOTICE_VERSION = 1

const VALID_VIEW_MODES = new Set(Object.values(VIEW_MODES))

export function normalizeViewMode(value) {
  return VALID_VIEW_MODES.has(value) ? value : VIEW_MODES.LIST
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

function parseWeatherLocation(value) {
  if (value === null || value === undefined || value === '') return null
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return null
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  if (
    candidate.latitude === null ||
    candidate.latitude === undefined ||
    candidate.latitude === '' ||
    candidate.longitude === null ||
    candidate.longitude === undefined ||
    candidate.longitude === ''
  ) {
    return null
  }
  const latitude = Number(candidate.latitude)
  const longitude = Number(candidate.longitude)
  const name = String(candidate.name || '')
    .trim()
    .slice(0, 80)
  if (!name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  const locationId =
    candidate.id === null || candidate.id === undefined || candidate.id === ''
      ? null
      : Number(candidate.id)
  return {
    id: Number.isFinite(locationId) && locationId > 0 ? Math.round(locationId) : null,
    name,
    admin1: String(candidate.admin1 || '')
      .trim()
      .slice(0, 80),
    admin2: String(candidate.admin2 || '')
      .trim()
      .slice(0, 80),
    country: String(candidate.country || '')
      .trim()
      .slice(0, 80),
    countryCode: String(candidate.countryCode || '')
      .trim()
      .toUpperCase()
      .slice(0, 2),
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
    timezone:
      String(candidate.timezone || 'auto')
        .trim()
        .slice(0, 80) || 'auto'
  }
}

function parseBoolean(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function parseDockEdges(value, fallback) {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return cloneValue(fallback)
    }
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_DOCK_EDGE_ENTRIES) {
    return cloneValue(fallback)
  }

  if (candidate.some((side) => !DOCK_EDGES.includes(side))) return cloneValue(fallback)

  const selected = new Set(candidate)
  return DOCK_EDGES.filter((side) => selected.has(side))
}

function parseTitlebarStyle(value, fallback) {
  return value === 'microsoft' || value === 'apple' ? value : fallback
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
    } catch (error) {
      console.warn('[settings-schema] 列表筛选设置不是合法 JSON，已回退默认值:', error)
      return cloneValue(fallback)
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return cloneValue(fallback)
  }

  const listMode = ['timeline', 'custom', 'tag-group'].includes(candidate.listMode)
    ? candidate.listMode
    : 'timeline'
  const tagIds = Array.isArray(candidate.tagIds)
    ? [...new Set(candidate.tagIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : []
  const hasStatusFilter = Array.isArray(candidate.statusFilter)
  const statuses = hasStatusFilter
    ? [...new Set(candidate.statusFilter.filter((status) => VALID_NOTE_STATUSES.has(status)))]
    : []

  return {
    listMode,
    tagIds,
    // 空数组是合法状态，表示“不额外筛选”；只有字段缺失/类型错误才回退默认值。
    statusFilter: hasStatusFilter ? statuses : cloneValue(fallback.statusFilter)
  }
}

const definitions = [
  {
    id: 'appearance.titlebarStyle',
    path: ['appearance', 'titlebarStyle'],
    db: { type: 'appearance', key: 'titlebar_style' },
    defaultValue: 'apple',
    parse: parseTitlebarStyle,
    serialize: String,
    remark: '主窗口导航栏视觉风格（apple / microsoft）'
  },
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
    defaultValue: 0.2,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 1 }),
    serialize: String,
    remark: 'CSS 玻璃霜层全局基准（0~1 浮点数）'
  },
  {
    id: 'css.bgBlur',
    path: ['css', 'bgBlur'],
    db: { type: 'css', key: 'bg_blur' },
    defaultValue: 10,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 5, max: 30 }),
    serialize: String,
    remark: 'CSS 玻璃模糊全局基准（像素）'
  },
  {
    id: 'css.windowOpacity',
    path: ['css', 'windowOpacity'],
    db: { type: 'css', key: 'window_opacity' },
    defaultValue: 0.3,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 1 }),
    serialize: String,
    remark: '窗口透明度（0~1 浮点数）'
  },
  {
    id: 'css.fontSizeBase',
    path: ['css', 'fontSizeBase'],
    db: { type: 'css', key: 'font_size_base' },
    defaultValue: 17,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 14, max: 22, integer: true }),
    serialize: String,
    remark: '基准字号（rem 单位数值）'
  },
  {
    id: 'css.textColor',
    path: ['css', 'textColor'],
    db: { type: 'css', key: 'text_color' },
    defaultValue: '#1d1d1f',
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
    defaultValue: 12,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 40 }),
    serialize: String,
    remark: '系统模糊半径（0~40 DIP）'
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
    id: 'wallpaper.enabled',
    path: ['wallpaper', 'enabled'],
    db: { type: 'wallpaper', key: 'wallpaper_enabled' },
    defaultValue: false,
    parse: parseBoolean,
    serialize: String,
    remark: '主页面壁纸启用状态（与系统毛玻璃互斥）'
  },
  {
    id: 'wallpaper.activeId',
    path: ['wallpaper', 'activeId'],
    db: { type: 'wallpaper', key: 'active_wallpaper_id' },
    defaultValue: null,
    parse: parseNullableInteger,
    serialize: String,
    remark: '当前选中的壁纸裁剪版本 ID'
  },
  {
    id: 'wallpaper.blurRadius',
    path: ['wallpaper', 'blurRadius'],
    db: { type: 'wallpaper', key: 'wallpaper_blur_radius' },
    defaultValue: 8,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 30 }),
    serialize: String,
    remark: '主页面壁纸 CSS 模糊半径（0~30px）'
  },
  {
    id: 'ui.settingsPanelSize',
    path: ['ui', 'settingsPanelSize'],
    db: { type: 'ui', key: 'settings_panel_size' },
    defaultValue: 70,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 25, max: 95, integer: true }),
    serialize: String,
    remark: '当前视图设置面板尺寸百分比（25~95）'
  },
  {
    id: 'ui.dayPanelSize',
    path: ['ui', 'dayPanelSize'],
    db: { type: 'ui', key: 'day_panel_size' },
    defaultValue: 25,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 25, max: 50 }),
    serialize: String,
    remark: '日历视图日期侧栏宽度百分比（25~50）'
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
    id: 'dock.revealHandleEnabled',
    path: ['dock', 'revealHandleEnabled'],
    db: { type: 'dock', key: 'dock_reveal_handle_enabled' },
    defaultValue: false,
    parse: parseBoolean,
    serialize: String,
    remark: '贴边隐藏后是否先显示点击确认条'
  },
  {
    id: 'dock.enabledEdges',
    path: ['dock', 'enabledEdges'],
    db: { type: 'dock', key: 'dock_enabled_edges' },
    // 各视图兼容默认值由 buildDefaults 注入；直接序列化非法输入时回退为空，
    // 保证 renderer 异常载荷不会意外启用任何边缘。
    defaultValue: [],
    parse: parseDockEdges,
    serialize: JSON.stringify,
    remark: '当前视图允许贴边隐藏的方向（top / left / right）'
  },
  {
    id: 'sticky.fontSize',
    path: ['sticky', 'fontSize'],
    db: { type: 'sticky', key: 'sticky_font_size' },
    defaultValue: 16,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 12, max: 32, integer: true }),
    serialize: String,
    remark: '新建便利贴默认字号（12~32px）'
  },
  {
    id: 'sticky.backgroundColor',
    path: ['sticky', 'backgroundColor'],
    db: { type: 'sticky', key: 'sticky_background_color' },
    defaultValue: '#fff2a8',
    parse: parseHexColor,
    serialize: String,
    remark: '新建便利贴默认背景颜色'
  },
  {
    id: 'sticky.cornerRadius',
    path: ['sticky', 'cornerRadius'],
    db: { type: 'sticky', key: 'sticky_corner_radius' },
    defaultValue: 0,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 32, integer: true }),
    serialize: String,
    remark: '新建便利贴默认圆角（0~32px）'
  },
  {
    id: 'sticky.alwaysOnTop',
    path: ['sticky', 'alwaysOnTop'],
    db: { type: 'sticky', key: 'sticky_always_on_top' },
    defaultValue: false,
    parse: parseBoolean,
    serialize: String,
    remark: '新建便利贴默认置顶状态'
  },
  {
    id: 'weather.enabled',
    path: ['weather', 'enabled'],
    db: { type: 'weather', key: 'enabled' },
    defaultValue: false,
    parse: parseBoolean,
    serialize: String,
    remark: '天气展示开关'
  },
  {
    id: 'weather.location',
    path: ['weather', 'location'],
    db: { type: 'weather', key: 'location' },
    defaultValue: null,
    parse: parseWeatherLocation,
    serialize: JSON.stringify,
    remark: '用户确认的天气城市及 WGS84 坐标'
  },
  {
    id: 'remote.receiveNotices',
    path: ['remote', 'receiveNotices'],
    db: { type: 'remote', key: 'receive_notices' },
    defaultValue: true,
    parse: parseBoolean,
    serialize: String,
    remark: '接收远程软件通知'
  },
  {
    id: 'remote.uploadDeviceInfo',
    path: ['remote', 'uploadDeviceInfo'],
    db: { type: 'remote', key: 'upload_device_info' },
    defaultValue: true,
    parse: parseBoolean,
    serialize: String,
    remark: '上传基础设备信息与启动退出时间'
  },
  {
    id: 'onboarding.noticeVersion',
    path: ['onboarding', 'noticeVersion'],
    db: { type: 'onboarding', key: 'first_use_notice_version' },
    defaultValue: 0,
    parse: (value, fallback) => parseNumber(value, fallback, { min: 0, max: 999, integer: true }),
    serialize: String,
    remark: '用户已确认的首次使用须知版本（0 表示尚未确认）'
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

function buildDefaults(viewMode = VIEW_MODES.LIST) {
  const defaults = {}
  SETTING_DEFINITIONS.forEach((definition) => {
    setAtPath(defaults, definition.path, cloneValue(definition.defaultValue))
  })
  if ([VIEW_MODES.MONTH, VIEW_MODES.WEEK].includes(normalizeViewMode(viewMode))) {
    defaults.geometry.widthRatio = 0.7
    defaults.geometry.heightRatio = 0.7
    defaults.ui.settingsPanelSize = 40
    defaults.dock.enabledEdges = ['top']
  } else {
    // 保持升级前列表视图仅允许左右贴边隐藏的行为。
    defaults.dock.enabledEdges = ['left', 'right']
  }
  if (normalizeViewMode(viewMode) === VIEW_MODES.WEEK) {
    defaults.geometry.heightRatio = 0.5
  }
  return defaults
}

export const DEFAULT_SETTINGS = deepFreeze(buildDefaults())

/** 返回一份可安全修改的默认设置。 */
export function createDefaultSettings(viewMode = VIEW_MODES.LIST) {
  return cloneValue(
    normalizeViewMode(viewMode) === VIEW_MODES.LIST ? DEFAULT_SETTINGS : buildDefaults(viewMode)
  )
}

/**
 * 将 app_settings 查询结果解析为完整设置。数据库值优先；缺失或非法时回退默认。
 * @param {Array<{type: string, key: string, value: unknown}>} rows
 */
export function resolveSettingsRows(rows = [], viewMode = VIEW_MODES.LIST) {
  const resolved = createDefaultSettings(viewMode)
  const rowByDbKey = new Map(rows.map((row) => [`${row.type}:${row.key}`, row]))

  SETTING_DEFINITIONS.forEach((definition) => {
    if (!definition.db) return
    const row = rowByDbKey.get(`${definition.db.type}:${definition.db.key}`)
    if (!row) return
    const fallback = cloneValue(getAtPath(resolved, definition.path))
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
