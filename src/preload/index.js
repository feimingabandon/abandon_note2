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

/**
 * 自定义 API 对象
 * 包含渲染进程需要调用的所有主进程功能
 * 每个方法通过 ipcRenderer.send（单向）或 ipcRenderer.invoke（双向）与主进程通信
 */
const api = {
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
  /** 清空 app_settings 并恢复共享默认设置（不影响业务数据和开机自启） */
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  /** 监听设置快照变化；返回取消监听函数 */
  onSettingsChanged: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },

  // ---- 生命周期通知 ----
  /** 通知主进程渲染已就绪，可以显示窗口了 */
  rendererReady: () => ipcRenderer.send('renderer-ready'),

  // ---- 贴边隐藏 ----
  /** 通知主进程鼠标悬停状态（true=进入窗口, false=离开窗口） */
  windowHover: (isHovering) => ipcRenderer.send('window-hover', isHovering),
  /** 边缘触发窗口：鼠标进入边缘时通知主进程恢复窗口 */
  triggerEnter: () => ipcRenderer.send('trigger-enter'),

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
  // ---- 便签 CRUD ----
  /** 创建便签 */
  createNote: (options) => ipcRenderer.invoke('notes:create', options),
  /** 原子创建便签（含图片 + 标签，事务保护） */
  createNoteWithAssets: ({ options, images, tagNames }) =>
    ipcRenderer.invoke('notes:create-with-assets', { options, images, tagNames }),
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
  /** 监听调度器等主进程来源的便签变化；返回取消监听函数。 */
  onNotesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('notes:changed', handler)
    return () => ipcRenderer.removeListener('notes:changed', handler)
  },

  // ---- 标签管理 ----
  /** 创建标签 */
  createTag: (name, color) => ipcRenderer.invoke('tags:create', { name, color }),
  /** 删除标签（按名称） */
  deleteTag: (name) => ipcRenderer.invoke('tags:delete', { name }),
  /** 获取全部标签 */
  listTags: () => ipcRenderer.invoke('tags:list'),
  /** 获取单个标签（按名称） */
  getTag: (name) => ipcRenderer.invoke('tags:get', { name }),

  // ---- 便签-标签关联 ----
  /** 绑定标签到便签 */
  bindTag: (noteId, tagName) => ipcRenderer.invoke('note-tags:bind', { noteId, tagName }),
  /** 取消绑定 */
  unbindTag: (noteId, tagName) => ipcRenderer.invoke('note-tags:unbind', { noteId, tagName }),
  /** 整体设置便签标签（事务替换，tagNames 为字符串数组） */
  setNoteTags: (noteId, tagNames) => ipcRenderer.invoke('note-tags:set', { noteId, tagNames }),
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
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  /** 获取单个模板 */
  getTemplate: (id) => ipcRenderer.invoke('templates:get', { id }),
  /** 暂停模板 */
  pauseTemplate: (id) => ipcRenderer.invoke('templates:pause', { id }),
  /** 恢复模板 */
  resumeTemplate: (id) => ipcRenderer.invoke('templates:resume', { id }),

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
