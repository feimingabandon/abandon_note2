import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('stickyAPI', {
  reportLog: (payload) => ipcRenderer.send('logs:write', payload),
  getState: () => ipcRenderer.invoke('sticky:get-state'),
  ready: () => ipcRenderer.invoke('sticky:ready'),
  close: () => ipcRenderer.invoke('sticky:close'),
  togglePin: () => ipcRenderer.invoke('sticky:toggle-pin'),
  updateContent: (payload) => ipcRenderer.invoke('sticky:update-content', payload),
  onContentChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sticky:content-changed', listener)
    return () => ipcRenderer.removeListener('sticky:content-changed', listener)
  },
  updateAppearance: (state) => ipcRenderer.invoke('sticky:update-appearance', state)
})
