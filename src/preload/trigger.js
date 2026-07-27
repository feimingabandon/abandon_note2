import { contextBridge, ipcRenderer } from 'electron'

// 贴边触发窗口只需要一个动作，不能继承主窗口的完整数据库与设置 API。
contextBridge.exposeInMainWorld('api', {
  reportLog: (payload) => ipcRenderer.send('logs:write', payload),
  triggerEnter: () => ipcRenderer.send('trigger-enter')
})
