import { getAllSettings, setSettingsBatch } from '../db/db.js'
import {
  DEFAULT_SETTINGS,
  normalizeViewMode,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES,
  WINDOW_Z_ORDER_MODES
} from '../../shared/settings-schema.js'

export const APPLICATION_SETTINGS_SCOPE = 'application'
export const VIEW_SETTINGS_SCOPES = Object.freeze({
  [VIEW_MODES.LIST]: 'main',
  [VIEW_MODES.MONTH]: 'month',
  [VIEW_MODES.WEEK]: 'week'
})

/**
 * 保存在 application 作用域的用户可配置项。新增应用级设置时只需在此
 * 登记，持久化分流和“恢复默认设置”就会同步覆盖，避免新设置被漏掉。
 */
export const APPLICATION_SETTING_IDS = Object.freeze([
  'notes.autoMoveYesterday',
  'appearance.titlebarIconScale',
  'appearance.iconColor',
  'shortcuts.viewVisibility',
  'calendar.recurringPreviewEnabled',
  'interaction.doubleClickQuickEdit',
  'remote.receiveNotices',
  'remote.uploadDeviceInfo',
  'weather.enabled',
  'weather.location',
  'onboarding.noticeVersion',
  'window.lockState',
  'window.zOrderMode'
])

const ACTIVE_VIEW_ROW = Object.freeze({
  type: 'application',
  key: 'active_view',
  remark: '当前主视图（list / month / week）'
})

const WEEK_SETTINGS_INITIALIZED_ROW = Object.freeze({
  type: 'application',
  key: 'week_settings_initialized',
  value: 'true',
  remark: '周视图已完成首次设置继承'
})

const APPLICATION_SETTING_DB_KEYS = new Set([
  'appearance:titlebar_icon_scale',
  'appearance:icon_color',
  'shortcuts:view_visibility',
  'remote:receive_notices',
  'remote:upload_device_info',
  'weather:enabled',
  'weather:location',
  'calendar:recurring_preview_enabled',
  'interaction:double_click_quick_edit',
  'notes:auto_move_yesterday',
  'notes:auto_move_last_date',
  'onboarding:first_use_notice_version'
])

// 1.1.0 曾把常显小黑条拖动位置写入各视图。位置现在仅属于一次隐藏会话，
// 旧行由共享 schema 忽略，首次创建周视图时也不能把它继续复制到新作用域。
const OBSOLETE_VIEW_SETTING_DB_KEYS = new Set(['dock:dock_reveal_handle_positions'])

function rowMap(rows) {
  return new Map(rows.map((row) => [`${row.type}:${row.key}`, row.value]))
}

function parseStoredBoolean(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/**
 * 公共设置优先从 application 作用域读取。旧版本只在 main 作用域保存远程开关，
 * 因而缺值时做兼容回读；不批量改库，用户下次修改时自然写入新作用域。
 */
export function readApplicationSettings() {
  const applicationSettingRows = getAllSettings(APPLICATION_SETTINGS_SCOPE)
  const applicationRows = rowMap(applicationSettingRows)
  const applicationResolved = resolveSettingsRows(applicationSettingRows)
  const legacyRows = rowMap(getAllSettings(VIEW_SETTINGS_SCOPES[VIEW_MODES.LIST]))
  const receiveNotices =
    applicationRows.get('remote:receive_notices') ?? legacyRows.get('remote:receive_notices')
  const uploadDeviceInfo =
    applicationRows.get('remote:upload_device_info') ?? legacyRows.get('remote:upload_device_info')
  const storedView = applicationRows.get(`${ACTIVE_VIEW_ROW.type}:${ACTIVE_VIEW_ROW.key}`)

  return {
    activeView: normalizeViewMode(storedView),
    appearance: {
      titlebarIconScale: applicationResolved.appearance.titlebarIconScale,
      iconColor: applicationResolved.appearance.iconColor
    },
    shortcuts: { ...applicationResolved.shortcuts },
    interaction: { ...applicationResolved.interaction },
    calendar: { ...applicationResolved.calendar },
    notes: { ...applicationResolved.notes },
    window: { ...applicationResolved.window },
    weather: applicationResolved.weather,
    onboarding: applicationResolved.onboarding,
    remote: {
      receiveNotices: parseStoredBoolean(receiveNotices, DEFAULT_SETTINGS.remote.receiveNotices),
      uploadDeviceInfo: parseStoredBoolean(
        uploadDeviceInfo,
        DEFAULT_SETTINGS.remote.uploadDeviceInfo
      )
    }
  }
}

/**
 * 导航栏的锁定与窗口层级从历史分视图状态收敛为应用级状态。
 * 旧布尔置顶值天然映射为 top / normal；只在应用级记录缺失时读取一次当前视图，
 * 不保留锁定和层级的版本回退镜像或额外迁移标记。
 */
export function ensureApplicationWindowSettingsInitialized(viewMode) {
  const normalizedViewMode = normalizeViewMode(viewMode)
  const applicationRows = rowMap(getAllSettings(APPLICATION_SETTINGS_SCOPE))
  const lockDbKey = 'system:lock_state'
  const zOrderDbKey = 'system:z_order_mode'
  const needsLockState = !applicationRows.has(lockDbKey)
  const needsZOrderMode = !applicationRows.has(zOrderDbKey)
  if (!needsLockState && !needsZOrderMode) return false

  const legacyRows = getAllSettings(getViewSettingsScope(normalizedViewMode))
  const legacyRowMap = rowMap(legacyRows)
  const resolvedLegacy = resolveSettingsRows(legacyRows, normalizedViewMode)
  const entries = []

  if (needsLockState) {
    entries.push(serializeSetting('window.lockState', resolvedLegacy.window.lockState))
  }
  if (needsZOrderMode) {
    const legacyAlwaysOnTop = parseStoredBoolean(legacyRowMap.get('system:always_on_top'), true)
    entries.push(
      serializeSetting(
        'window.zOrderMode',
        legacyAlwaysOnTop ? WINDOW_Z_ORDER_MODES.TOP : WINDOW_Z_ORDER_MODES.NORMAL
      )
    )
  }

  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, entries)
  return true
}

export function writeActiveView(viewMode) {
  const normalized = normalizeViewMode(viewMode)
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [{ ...ACTIVE_VIEW_ROW, value: normalized }])
  return normalized
}

/**
 * 周视图第一次启用时，以月视图的持久化设置为起点。初始化标记保存在 application
 * 作用域，因此用户之后即使恢复周视图默认设置（清空 week 作用域），也不会再次继承。
 */
export function ensureViewSettingsInitialized(viewMode) {
  if (normalizeViewMode(viewMode) !== VIEW_MODES.WEEK) return false

  const applicationRows = rowMap(getAllSettings(APPLICATION_SETTINGS_SCOPE))
  if (parseStoredBoolean(applicationRows.get('application:week_settings_initialized'), false)) {
    return false
  }

  const weekScope = VIEW_SETTINGS_SCOPES[VIEW_MODES.WEEK]
  const existingWeekRows = getAllSettings(weekScope)
  if (existingWeekRows.length === 0) {
    const inheritedRows = getAllSettings(VIEW_SETTINGS_SCOPES[VIEW_MODES.MONTH]).filter((row) => {
      const dbKey = `${row.type}:${row.key}`
      return !APPLICATION_SETTING_DB_KEYS.has(dbKey) && !OBSOLETE_VIEW_SETTING_DB_KEYS.has(dbKey)
    })
    if (inheritedRows.length > 0) setSettingsBatch(weekScope, inheritedRows)
  }

  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [WEEK_SETTINGS_INITIALIZED_ROW])
  return true
}

/**
 * 视图切换前同步收敛设置。
 *
 * 窗口移动/缩放使用防抖写库；如果用户调整月视图后立即首次切到周视图，必须先把
 * 尚未落库的真实边界写回 month 作用域，再执行周设置继承。否则 week 会复制旧几何，
 * 而切换流程清理防抖定时器后，用户刚完成的尺寸也会永久丢失。
 */
export function prepareViewSettingsForSwitch({
  sourceViewMode,
  targetViewMode,
  pendingGeometry = null
}) {
  let geometryPersisted = false
  if (pendingGeometry) {
    const bounds = {
      x: Number(pendingGeometry.x),
      y: Number(pendingGeometry.y),
      width: Number(pendingGeometry.width),
      height: Number(pendingGeometry.height)
    }
    if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error('视图切换前的窗口几何信息无效')
    }
    setSettingsBatch(getViewSettingsScope(sourceViewMode), [
      serializeSetting('geometry.posX', bounds.x),
      serializeSetting('geometry.posY', bounds.y),
      serializeSetting('geometry.width', bounds.width),
      serializeSetting('geometry.height', bounds.height)
    ])
    geometryPersisted = true
  }

  return {
    geometryPersisted,
    targetInitialized: ensureViewSettingsInitialized(targetViewMode)
  }
}

export function writeApplicationSetting(id, value) {
  if (!APPLICATION_SETTING_IDS.includes(id)) {
    throw new Error(`未知应用级设置项: ${id}`)
  }
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [serializeSetting(id, value)])
}

/** 原子地把全部用户可配置的应用级设置写回 schema 默认值。 */
export function resetApplicationSettingsToDefaults() {
  const entries = APPLICATION_SETTING_IDS.map((id) => {
    const defaultValue = id
      .split('.')
      .reduce((value, segment) => value?.[segment], DEFAULT_SETTINGS)
    if (defaultValue === undefined) throw new Error(`应用级设置缺少默认值: ${id}`)
    return serializeSetting(id, defaultValue)
  })
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, entries)
  return entries.length
}

export function getViewSettingsScope(viewMode) {
  return VIEW_SETTINGS_SCOPES[normalizeViewMode(viewMode)]
}
