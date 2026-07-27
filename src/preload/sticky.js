import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('stickyAPI', {
  reportLog: (payload) => ipcRenderer.send('logs:write', payload),
  getState: () => ipcRenderer.invoke('sticky:get-state'),
  ready: () => ipcRenderer.invoke('sticky:ready'),
  close: () => ipcRenderer.invoke('sticky:close'),
  togglePin: () => ipcRenderer.invoke('sticky:toggle-pin'),
  updateAppearance: (state) => ipcRenderer.invoke('sticky:update-appearance', state)
})
