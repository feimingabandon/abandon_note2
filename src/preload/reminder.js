import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('reminderAPI', {
  getState: () => ipcRenderer.invoke('reminders:state'),
  ready: () => ipcRenderer.invoke('reminders:ready'),
  action: (payload) => ipcRenderer.invoke('reminders:action', payload),
  hide: () => ipcRenderer.invoke('reminders:hide'),
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('reminders:changed', listener)
    return () => ipcRenderer.removeListener('reminders:changed', listener)
  }
})
