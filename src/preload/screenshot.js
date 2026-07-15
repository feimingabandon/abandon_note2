/**
 * screenshot.js — 截图窗口预加载脚本
 *
 * 暴露三个 IPC 通道，最小化攻击面。上下文隔离，无 Node 权限。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('screenshot', {
  /** 确定截图，只回传逻辑像素选区；原始图片由主进程裁切。 */
  confirm: (selection) => ipcRenderer.send('screenshot:confirm', selection),
  /** 取消截图 */
  cancel: () => ipcRenderer.send('screenshot:cancel')
})
