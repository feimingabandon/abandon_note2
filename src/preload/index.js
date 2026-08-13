/**
 * preload/index.js — 预加载脚本
 *
 * 职责：
 *   在渲染进程（网页）和主进程之间建立安全的 IPC 通信桥梁。
 *   通过 contextBridge 将受限的 API 暴露给渲染进程，
 *   避免直接暴露 Node.js 或 Electron 的完整能力，确保安全性。
 *
 * 仅暴露 window.api；渲染层不获得通用 Electron API。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { getSystemNotificationCapability } from '../shared/notification-policy.js'

/**
 * 自定义 API 对象
 * 包含渲染进程需要调用的所有主进程功能
 * 每个方法通过 ipcRenderer.send（单向）或 ipcRenderer.invoke（双向）与主进程通信
 */
const api = {
  runtimeCapabilities: {
    platform: process.platform,
    systemNotifications: getSystemNotificationCapability(process.platform)
  },

  // ---- 本地日志与诊断 ----
  /** 上报 renderer 结构化日志；主进程负责落盘。 */
  reportLog: (payload) => ipcRenderer.send('logs:write', payload),
  /** 分页读取本机日志，只供设置页诊断查看器使用。 */
  queryLogs: (query) => ipcRenderer.invoke('logs:query', query),
  /** 使用系统文件管理器打开日志目录。 */
  openLogsFolder: () => ipcRenderer.invoke('logs:open-folder'),
  /** 导出完整诊断日志。 */
  exportLogs: () => ipcRenderer.invoke('logs:export'),

  // ---- 窗口控制（单向通信，无需返回值） ----
  /** 关闭当前窗口 */
  closeWindow: () => ipcRenderer.send('window-close'),

  // ---- 窗口锁定 ----
  /** 切换窗口锁定状态（禁止/允许移动和缩放），返回新的锁定状态 */
  toggleLock: () => ipcRenderer.invoke('toggle-lock'),

  // ---- 窗口置顶 ----
  /** 切换窗口置顶状态，返回新的置顶状态 */
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),

  // ---- 缩放手柄（窗口边界操作） ----
  /** 获取当前窗口的位置和尺寸（双向通信，返回 Promise） */
  getWindowBounds: () => ipcRenderer.invoke('window-get-bounds'),
  /** 设置窗口的位置和尺寸（单向通信） */
  setWindowBounds: (bounds) => ipcRenderer.send('window-set-bounds', bounds),

  // ---- 设置桥接（双向通信，均返回 Promise） ----
  /** 按共享 schema ID 写入设置；数据库键名和校验不暴露给 renderer */
  setSettingValue: (id, value) => ipcRenderer.invoke('set-setting-value', id, value),
  /** 获取 DB 值覆盖共享默认值后的完整设置快照 */
  getSettingsSnapshot: () => ipcRenderer.invoke('get-settings-snapshot'),
  /** 只恢复当前视图的独立默认设置（不影响公共设置、其他视图和业务数据） */
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  /** 监听设置快照变化；返回取消监听函数 */
  onSettingsChanged: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },

  // ---- 远程软件通知 ----
  listPendingRemoteNotices: () => ipcRenderer.invoke('remote-notices:list-pending'),
  listRemoteNotices: (query) => ipcRenderer.invoke('remote-notices:list', query),
  acknowledgeRemoteNotice: (id) => ipcRenderer.invoke('remote-notices:acknowledge', { id }),
  openRemoteNoticeLink: (id) => ipcRenderer.invoke('remote-notices:open-link', { id }),
  onRemoteNoticesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('remote-notices:changed', handler)
    return () => ipcRenderer.removeListener('remote-notices:changed', handler)
  },
  getRemoteHealth: () => ipcRenderer.invoke('remote:get-health'),
  onRemoteHealthChanged: (callback) => {
    const handler = (_event, health) => callback(health)
    ipcRenderer.on('remote-health:changed', handler)
    return () => ipcRenderer.removeListener('remote-health:changed', handler)
  },

  // ---- 生命周期通知 ----
  /** 通知主进程渲染已就绪，可以显示窗口了 */
  rendererReady: () => ipcRenderer.send('renderer-ready'),

  // ---- 应用内消息条（主进程降级提醒：系统通知发送失败时改用应用内 Toast） ----
  /** 监听主进程下发的应用内消息；返回取消监听函数。 */
  onAppMessage: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('app:message', handler)
    return () => ipcRenderer.removeListener('app:message', handler)
  },
  /** 点击便签系统通知后，由主进程要求当前视图定位并打开对应便签。 */
  onNotificationOpenNote: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('notification:open-note', handler)
    return () => ipcRenderer.removeListener('notification:open-note', handler)
  },

  // ---- 应用更新（全手动模式：仅检查新版本与打开发布页，固定仓库地址） ----
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openManualUpdate: (provider) => ipcRenderer.invoke('update:open-manual', provider),

  // ---- 贴边隐藏 ----
  /** 通知主进程鼠标悬停状态（true=进入窗口, false=离开窗口） */
  windowHover: (isHovering) => ipcRenderer.send('window-hover', isHovering),

  // ---- 便签数据清理 ----
  /** 清空便签、模板、标签和附件，保留 app_settings */
  clearNoteData: () => ipcRenderer.invoke('clear-note-data'),

  // ---- 开机自启 ----
  /** 直接读取操作系统的开机自启真实状态（不使用数据库副本） */
  verifyAutoStart: () => ipcRenderer.invoke('verify-auto-start'),
  /** 设置开机自启并回读操作系统真实状态（不写入 app_settings） */
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // ---- 系统模糊 ----
  /** 设置模糊配置（立即生效 + 持久化） */
  setBlurConfig: (config) => ipcRenderer.invoke('set-blur-config', config),
  /** 监听统一调度器产出的毛玻璃诊断结果 */
  onBlurDiagnosticChanged: (callback) => {
    const handler = (_event, diagnostic) => callback(diagnostic)
    ipcRenderer.on('blur:diagnostic-changed', handler)
    return () => ipcRenderer.removeListener('blur:diagnostic-changed', handler)
  },
  // ---- 主页面壁纸 ----
  listWallpapers: () => ipcRenderer.invoke('wallpapers:list'),
  getWallpaperThumbnail: (id, maxSize = 240) =>
    ipcRenderer.invoke('wallpapers:get-thumbnail', { id, maxSize }),
  getWallpaperData: (id, original = false) =>
    ipcRenderer.invoke('wallpapers:get-data', { id, original }),
  saveWallpaper: (payload) => ipcRenderer.invoke('wallpapers:save', payload),
  activateWallpaper: (id) => ipcRenderer.invoke('wallpapers:activate', { id }),
  disableWallpaper: () => ipcRenderer.invoke('wallpapers:disable'),
  deleteWallpaper: (id) => ipcRenderer.invoke('wallpapers:delete', { id }),
  // ---- 便签 CRUD ----
  /** 创建便签 */
  createNote: (options) => ipcRenderer.invoke('notes:create', options),
  /** 原子创建便签（含图片 + 标签，事务保护） */
  createNoteWithAssets: ({ options, images, tagIds }) =>
    ipcRenderer.invoke('notes:create-with-assets', { options, images, tagIds }),
  /** 更新便签（部分字段） */
  updateNote: (id, fields) => ipcRenderer.invoke('notes:update', { id, fields }),
  /** 原子保存编辑草稿（字段、标签及附件变更） */
  saveNoteDraft: (payload) => ipcRenderer.invoke('notes:save-draft', payload),
  /** 逻辑删除便签（附件随记录保留，清空便签数据时物理清理） */
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', { id }),
  /** 彻底删除便签及其附件文件（不可恢复） */
  purgeNote: (id) => ipcRenderer.invoke('notes:purge', { id }),
  /** 获取单条便签（含附件和标签） */
  getNote: (id) => ipcRenderer.invoke('notes:get', { id }),
  /** 基于有效便签正文创建一次性桌面便利贴；正文由主进程重新读取。 */
  createSticky: (noteId) => ipcRenderer.invoke('sticky:create', { noteId }),
  /** 查询便签列表 */
  queryPinnedNotes: (options) => ipcRenderer.invoke('notes:query-pinned', options),
  /** 查询三天内非置顶便签（时间线模式） */
  queryRecentNotes: (options) => ipcRenderer.invoke('notes:query-recent', options),
  /** 查询更早的非置顶便签（时间线模式，分页） */
  queryEarlierNotes: (options) => ipcRenderer.invoke('notes:query-earlier', options),
  /** 查询置顶便签（自定义模式，按 sort_order） */
  queryCustomPinned: (options) => ipcRenderer.invoke('notes:query-custom-pinned', options),
  /** 查询日常便签（自定义模式，分页） */
  queryCustomNormal: (options) => ipcRenderer.invoke('notes:query-custom-normal', options),
  /** 查询标签分组及各组在当前状态筛选下的便签数量 */
  queryTagGroups: (options) => ipcRenderer.invoke('notes:query-tag-groups', options),
  /** 分页查询单个标签组；tagId 为 null 时查询未分类 */
  queryTagGroupNotes: (options) => ipcRenderer.invoke('notes:query-tag-group', options),
  /** 在独立搜索工作区查询全部未删除便签 */
  searchNotes: (options) => ipcRenderer.invoke('notes:search', options),
  /** 查询全部未删除便签总数（不受筛选影响） */
  countActiveNotes: () => ipcRenderer.invoke('notes:count-active'),
  /** 全局重排 sort_order（自定义模式） */
  reorderCustomSortOrder: () => ipcRenderer.invoke('notes:reorder-custom'),
  /** 原子提交拖拽后的排序槽位 */
  updateCustomSortOrders: (items) => ipcRenderer.invoke('notes:update-custom-order', { items }),
  /** 开始处理 */
  startProgress: (id) => ipcRenderer.invoke('notes:start-progress', { id }),
  /** 完成便签 */
  completeNote: (id) => ipcRenderer.invoke('notes:complete', { id }),
  /** 将已完成便签重新恢复为进行中 */
  reopenNote: (id) => ipcRenderer.invoke('notes:reopen', { id }),
  /** 查询指定日期和多选状态下的日报便签预览。 */
  previewDailyReport: (options) => ipcRenderer.invoke('daily-report:preview', options),
  /** 由系统保存对话框导出选中的日报便签为 TXT。 */
  exportDailyReport: (options) => ipcRenderer.invoke('daily-report:export', options),
  /** 打开最近一次成功导出的日报所在文件夹。 */
  openDailyReportExportFolder: () => ipcRenderer.invoke('daily-report:open-export-folder'),
  /** 监听调度器等主进程来源的便签变化；返回取消监听函数。 */
  onNotesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('notes:changed', handler)
    return () => ipcRenderer.removeListener('notes:changed', handler)
  },
  /** 获取固定 7×6 的月历日期与当前可见范围内的真实便签。 */
  getMonthCalendarData: (year, month) => ipcRenderer.invoke('calendar:get-month', { year, month }),
  /** 获取锚点日期所在周（周一至周日）的日期、元数据与真实便签。 */
  getWeekCalendarData: (anchorDate) => ipcRenderer.invoke('calendar:get-week', { anchorDate }),
  /** 获取某年份最终生效的节假日数据状态（用户数据优先，内置数据兜底）。 */
  getHolidayDataStatus: (year = new Date().getFullYear()) =>
    ipcRenderer.invoke('calendar:holiday-data-status', { year }),
  /** 通过系统文件选择器导入 chinese-days JSON。 */
  importHolidayData: () => ipcRenderer.invoke('calendar:holiday-data-import'),
  /** 从固定的 chinese-days 官方 CDN 下载指定年份并导入。 */
  downloadHolidayData: (year = new Date().getFullYear()) =>
    ipcRenderer.invoke('calendar:holiday-data-download', { year }),
  /** 在默认浏览器中打开固定的按年份 JSON 地址。 */
  openHolidayDataLink: (year = new Date().getFullYear()) =>
    ipcRenderer.invoke('calendar:holiday-data-open-link', { year }),
  /** 返回当前年份尚无数据且本年度尚未提醒时的应用内通知。 */
  getHolidayDataNotice: () => ipcRenderer.invoke('calendar:holiday-data-notice'),
  dismissHolidayDataNotice: (year) =>
    ipcRenderer.invoke('calendar:holiday-data-dismiss-notice', { year }),
  onHolidayDataChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('calendar:holiday-data-changed', handler)
    return () => ipcRenderer.removeListener('calendar:holiday-data-changed', handler)
  },

  // ---- 天气（Open-Meteo，无 API Key） ----
  getWeatherDivisionTree: () => ipcRenderer.invoke('weather:get-division-tree'),
  resolveWeatherLocation: (location) =>
    ipcRenderer.invoke('weather:resolve-location', { location }),
  getWeatherForecast: () => ipcRenderer.invoke('weather:get-forecast'),
  refreshWeatherForecast: () => ipcRenderer.invoke('weather:refresh-forecast'),
  onWeatherForecastUpdated: (callback) => {
    const handler = (_event, forecast) => callback(forecast)
    ipcRenderer.on('weather:forecast-updated', handler)
    return () => ipcRenderer.removeListener('weather:forecast-updated', handler)
  },
  openWeatherSource: () => ipcRenderer.invoke('weather:open-source'),

  // ---- 标签管理 ----
  /** 创建标签 */
  createTag: (name, color) => ipcRenderer.invoke('tags:create', { name, color }),
  /** 修改标签（按稳定 ID） */
  updateTag: (id, fields) => ipcRenderer.invoke('tags:update', { id, fields }),
  /** 删除标签（按稳定 ID） */
  deleteTag: (id) => ipcRenderer.invoke('tags:delete', { id }),
  /** 只重排传入的可见标签；其他标签保留原排序槽位。 */
  updateTagOrder: (tagIds) => ipcRenderer.invoke('tags:update-order', { tagIds }),
  /** 获取全部标签 */
  listTags: () => ipcRenderer.invoke('tags:list'),
  /** 获取单个标签（按稳定 ID） */
  getTag: (id) => ipcRenderer.invoke('tags:get', { id }),
  /** 获取删除标签会影响的便签与模板数量 */
  getTagUsage: (id) => ipcRenderer.invoke('tags:usage', { id }),
  /** 监听标签新增、修改与删除；返回取消监听函数。 */
  onTagsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('tags:changed', handler)
    return () => ipcRenderer.removeListener('tags:changed', handler)
  },

  // ---- 便签-标签关联 ----
  /** 绑定标签到便签 */
  bindTag: (noteId, tagId) => ipcRenderer.invoke('note-tags:bind', { noteId, tagId }),
  /** 取消绑定 */
  unbindTag: (noteId, tagId) => ipcRenderer.invoke('note-tags:unbind', { noteId, tagId }),
  /** 整体设置便签标签（事务替换，tagIds 为正整数数组） */
  setNoteTagIds: (noteId, tagIds) => ipcRenderer.invoke('note-tags:set', { noteId, tagIds }),
  /** 获取便签的标签列表 */
  getNoteTags: (noteId) => ipcRenderer.invoke('note-tags:list', { noteId }),

  // ---- 循环模板 ----
  /** 创建循环模板 */
  createTemplate: (options) => ipcRenderer.invoke('templates:create', options),
  /** 更新模板 */
  updateTemplate: (id, fields) => ipcRenderer.invoke('templates:update', { id, fields }),
  /** 删除模板（软删） */
  deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', { id }),
  /** 获取模板列表 */
  listTemplates: (options) => ipcRenderer.invoke('templates:list', options),
  /** 获取单个模板 */
  getTemplate: (id, includeDeleted = false) =>
    ipcRenderer.invoke('templates:get', { id, includeDeleted }),
  /** 暂停模板 */
  pauseTemplate: (id) => ipcRenderer.invoke('templates:pause', { id }),
  /** 恢复模板 */
  resumeTemplate: (id) => ipcRenderer.invoke('templates:resume', { id }),
  /** 从已删除恢复模板（恢复后默认运行） */
  restoreTemplate: (id) => ipcRenderer.invoke('templates:restore', { id }),
  /** 彻底删除已删除模板 */
  purgeTemplate: (id) => ipcRenderer.invoke('templates:purge', { id }),
  /** 使用主进程调度算法预览下一次生成时间 */
  previewTemplateNextRun: (recurrenceRule, afterTimestamp = Date.now()) =>
    ipcRenderer.invoke('templates:preview-next-run', { recurrenceRule, afterTimestamp }),
  /** 监听调度器触发的模板状态变化；返回取消监听函数。 */
  onTemplatesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('templates:changed', handler)
    return () => ipcRenderer.removeListener('templates:changed', handler)
  },

  // ---- 图片附件 ----
  /** 批量保存图片 */
  saveImages: (noteId, images) => ipcRenderer.invoke('images:save-batch', { noteId, images }),
  /** 删除图片 */
  deleteImage: (id) => ipcRenderer.invoke('images:delete', { id }),
  /** 获取图片列表 */
  listImages: (noteId) => ipcRenderer.invoke('images:list', { noteId }),
  /** 获取图片 Base64 */
  getImageBase64: (relativePath) => ipcRenderer.invoke('images:get-base64', { relativePath }),
  /** 获取图片缩略图 */
  getImageThumbnail: (relativePath, maxSize = 240) =>
    ipcRenderer.invoke('images:get-thumbnail', { relativePath, maxSize }),
  /** 获取图片数量 */
  getImageCount: (noteId) => ipcRenderer.invoke('images:count', { noteId }),

  // ---- 截图 ----
  /** 捕获全屏截图，返回 data URL */
  captureScreen: () => ipcRenderer.invoke('screenshot:capture'),
  /** 截图窗口已经显示；后续选区和裁剪不再属于“启动中” */
  onScreenshotReady: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('screenshot:ready', handler)
    return () => ipcRenderer.removeListener('screenshot:ready', handler)
  },

  // ---- 调度器健康检查 ----
  /** 获取调度器健康状态 */
  getSchedulerHealth: () => ipcRenderer.invoke('scheduler:health')
}

contextBridge.exposeInMainWorld('api', api)
