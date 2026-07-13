/**
 * preload/index.js — 预加载脚本
 *
 * 职责：
 *   在渲染进程（网页）和主进程之间建立安全的 IPC 通信桥梁。
 *   通过 contextBridge 将受限的 API 暴露给渲染进程，
 *   避免直接暴露 Node.js 或 Electron 的完整能力，确保安全性。
 *
 * 暴露到 window 对象上的接口：
 *   - window.electron：electron-toolkit 提供的标准 Electron API
 *   - window.api：自定义的业务 API（窗口控制、数据库操作等）
 */

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload' // electron-toolkit 标准 preload API

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
  /** 获取当前锁定状态 */
  getLockState: () => ipcRenderer.invoke('get-lock-state'),

  // ---- 窗口置顶 ----
  /** 切换窗口置顶状态，返回新的置顶状态 */
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  /** 获取当前置顶状态 */
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),

  // ---- 缩放手柄（窗口边界操作） ----
  /** 获取当前窗口的位置和尺寸（双向通信，返回 Promise） */
  getWindowBounds: () => ipcRenderer.invoke('window-get-bounds'),
  /** 设置窗口的位置和尺寸（单向通信） */
  setWindowBounds: (bounds) => ipcRenderer.send('window-set-bounds', bounds),

  // ---- 数据库桥接（双向通信，均返回 Promise） ----
  /** 按类型批量获取设置 */
  getSettings: (windowName, type) => ipcRenderer.invoke('get-settings', windowName, type),
  /** 获取单个设置值 */
  getSetting: (windowName, key) => ipcRenderer.invoke('get-setting', windowName, key),
  /** 写入/更新设置 */
  setSetting: (windowName, type, key, value, remark = '') =>
    ipcRenderer.invoke('set-setting', windowName, type, key, value, remark),
  /** 删除设置 */
  deleteSetting: (windowName, key) => ipcRenderer.invoke('delete-setting', windowName, key),

  // ---- 生命周期通知 ----
  /** 通知主进程渲染已就绪，可以显示窗口了 */
  rendererReady: () => ipcRenderer.send('renderer-ready'),

  // ---- 贴边隐藏 ----
  /** 通知主进程鼠标悬停状态（true=进入窗口, false=离开窗口） */
  windowHover: (isHovering) => ipcRenderer.send('window-hover', isHovering),
  /** 边缘触发窗口：鼠标进入边缘时通知主进程恢复窗口 */
  triggerEnter: () => ipcRenderer.send('trigger-enter'),

  // ---- 数据库重置 ----
  resetDatabase: () => ipcRenderer.invoke('reset-database'),

  // ---- 窗口几何重置 ----
  /** 恢复窗口为默认宽高（屏幕 25% × 90%），保留当前位置 */
  resetWindowGeometry: () => ipcRenderer.invoke('reset-window-geometry'),

  // ---- 开机自启 ----
  /** 校验开机自启状态（DB 为权威，同步 OS，失败返回错误信息） */
  verifyAutoStart: () => ipcRenderer.invoke('verify-auto-start'),
  /** 设置开机自启（同步更新 OS + 数据库） */
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // ---- 系统模糊 ----
  /** 校验毛玻璃启用状态（DB 为权威，同步运行时，失败返回错误信息） */
  verifyBlurEnabled: () => ipcRenderer.invoke('verify-blur-enabled'),
  /** 获取平台模糊能力信息（支持 / 不支持 / 策略等） */
  getBlurCapabilities: () => ipcRenderer.invoke('get-blur-capabilities'),
  /** 获取当前模糊配置 */
  getBlurConfig: () => ipcRenderer.invoke('get-blur-config'),
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
  /** 删除便签（取消） */
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', { id }),
  /** 获取单条便签（含附件和标签） */
  getNote: (id) => ipcRenderer.invoke('notes:get', { id }),
  /** 查询便签列表 */
  listNotes: (options) => ipcRenderer.invoke('notes:list', options),
  /** 开始处理 */
  startProgress: (id) => ipcRenderer.invoke('notes:start-progress', { id }),
  /** 完成便签 */
  completeNote: (id) => ipcRenderer.invoke('notes:complete', { id }),
  /** 取消便签 */
  cancelNote: (id) => ipcRenderer.invoke('notes:cancel', { id }),

  // ---- 标签管理 ----
  /** 创建标签 */
  createTag: (name, color) => ipcRenderer.invoke('tags:create', { name, color }),
  /** 更新标签（按名称） */
  updateTag: (name, fields) => ipcRenderer.invoke('tags:update', { name, fields }),
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
  /** 获取图片数量 */
  getImageCount: (noteId) => ipcRenderer.invoke('images:count', { noteId }),

  // ---- 截图 ----
  /** 捕获全屏截图，返回 data URL */
  captureScreen: () => ipcRenderer.invoke('screenshot:capture'),

  // ---- 批量操作 ----
  /** 批量更新状态 */
  batchUpdateStatus: (ids, status) => ipcRenderer.invoke('batch:update-status', { ids, status }),
  /** 批量设置置顶 */
  batchSetPinned: (ids, pinned) => ipcRenderer.invoke('batch:set-pinned', { ids, pinned }),
  /** 批量设置生效时间 */
  batchSetEffectiveAt: (ids, effectiveAt) =>
    ipcRenderer.invoke('batch:set-effective-at', { ids, effectiveAt }),
  /** 批量添加标签 */
  batchAddTags: (noteIds, tagNames) => ipcRenderer.invoke('batch:add-tags', { noteIds, tagNames }),

  // ---- 调度器健康检查 ----
  /** 获取调度器健康状态 */
  getSchedulerHealth: () => ipcRenderer.invoke('scheduler:health')
}

// ============================================================
// 根据上下文隔离模式选择暴露方式
// ============================================================
if (process.contextIsolated) {
  // 上下文隔离模式（推荐）：通过 contextBridge 安全暴露 API
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI) // 暴露标准 Electron API
    contextBridge.exposeInMainWorld('api', api) // 暴露自定义业务 API
  } catch (error) {
    console.error(error)
  }
} else {
  // 非隔离模式（不推荐，仅作兼容）：直接挂载到 window 对象
  window.electron = electronAPI
  window.api = api
}
