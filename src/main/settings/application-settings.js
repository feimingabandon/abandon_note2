import { getAllSettings, setSettingsBatch } from '../db/db.js'
import { DEFAULT_SETTINGS, serializeSetting, VIEW_MODES } from '../../shared/settings-schema.js'

export const APPLICATION_SETTINGS_SCOPE = 'application'
export const VIEW_SETTINGS_SCOPES = Object.freeze({
  [VIEW_MODES.LIST]: 'main',
  [VIEW_MODES.MONTH]: 'month'
})

const ACTIVE_VIEW_ROW = Object.freeze({
  type: 'application',
  key: 'active_view',
  remark: '当前主视图（list / month）'
})

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
  const applicationRows = rowMap(getAllSettings(APPLICATION_SETTINGS_SCOPE))
  const legacyRows = rowMap(getAllSettings(VIEW_SETTINGS_SCOPES[VIEW_MODES.LIST]))
  const receiveNotices =
    applicationRows.get('remote:receive_notices') ?? legacyRows.get('remote:receive_notices')
  const uploadDeviceInfo =
    applicationRows.get('remote:upload_device_info') ?? legacyRows.get('remote:upload_device_info')
  const storedView = applicationRows.get(`${ACTIVE_VIEW_ROW.type}:${ACTIVE_VIEW_ROW.key}`)

  return {
    activeView: storedView === VIEW_MODES.MONTH ? VIEW_MODES.MONTH : VIEW_MODES.LIST,
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
  const normalized = viewMode === VIEW_MODES.MONTH ? VIEW_MODES.MONTH : VIEW_MODES.LIST
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [{ ...ACTIVE_VIEW_ROW, value: normalized }])
  return normalized
}

export function writeApplicationSetting(id, value) {
  if (id !== 'remote.receiveNotices' && id !== 'remote.uploadDeviceInfo') {
    throw new Error(`未知应用级设置项: ${id}`)
  }
  setSettingsBatch(APPLICATION_SETTINGS_SCOPE, [serializeSetting(id, value)])
}

export function getViewSettingsScope(viewMode) {
  return VIEW_SETTINGS_SCOPES[viewMode] || VIEW_SETTINGS_SCOPES[VIEW_MODES.LIST]
}
