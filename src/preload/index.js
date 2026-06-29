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
  /** 最小化当前窗口 */
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  /** 切换最大化/还原状态 */
  maximizeWindow: () => ipcRenderer.send('window-maximize'),

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
  setSetting: (windowName, type, key, value) =>
    ipcRenderer.invoke('set-setting', windowName, type, key, value),
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

  // ---- 开机自启 ----
  /** 获取 OS 真实开机自启状态（打开设置页时调用，自动同步数据库） */
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  /** 设置开机自启（同步更新 OS + 数据库） */
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled)
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
