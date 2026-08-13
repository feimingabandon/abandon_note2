import { getAllSettings, setSettingsBatch } from '../db/db.js'
import {
  DEFAULT_SETTINGS,
  normalizeViewMode,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES
} from '../../shared/settings-schema.js'

export const APPLICATION_SETTINGS_SCOPE = 'application'
export const VIEW_SETTINGS_SCOPES = Object.freeze({
  [VIEW_MODES.LIST]: 'main',
  [VIEW_MODES.MONTH]: 'month',
  [VIEW_MODES.WEEK]: 'week'
})

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
  'remote:receive_notices',
  'remote:upload_device_info',
  'weather:enabled',
  'weather:location'
])

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
    weather: applicationResolved.weather,
    remote: {
      receiveNotices: parseStoredBoolean(receiveNotices, DEFAULT_SETTINGS.remote.receiveNotices),
      uploadDeviceInfo: parseStoredBoolean(
        uploadDeviceInfo,
        DEFAULT_SETTINGS.remote.uploadDeviceInfo
      )
    }
  }
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
    const inheritedRows = getAllSettings(VIEW_SETTINGS_SCOPES[VIEW_MODES.MONTH]).filter(
      (row) => !APPLICATION_SETTING_DB_KEYS.has(`${row.type}:${row.key}`)
    )
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
  if (
    id !== 'remote.receiveNotices' &&
    id !== 'remote.uploadDeviceInfo' &&
    id !== 'weather.enabled' &&
    id !== 'weather.location'
  ) {
    throw new Error(`未知应用级设置项: ${id}`)
  }
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [serializeSetting(id, value)])
}

export function getViewSettingsScope(viewMode) {
  return VIEW_SETTINGS_SCOPES[normalizeViewMode(viewMode)]
}
