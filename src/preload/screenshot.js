/**
 * screenshot.js — 截图窗口预加载脚本
 *
 * 暴露三个 IPC 通道，最小化攻击面。上下文隔离，无 Node 权限。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('screenshot', {
  /** 确定截图，回传裁切后的 data URL */
  confirm: (dataUrl) => ipcRenderer.send('screenshot:confirm', dataUrl),
  /** 取消截图 */
  cancel: () => ipcRenderer.send('screenshot:cancel'),
  /** 接收主进程传来的截图图片 data URL */
  onImage: (cb) => ipcRenderer.on('screenshot:image', (_e, dataUrl) => cb(dataUrl))
})
