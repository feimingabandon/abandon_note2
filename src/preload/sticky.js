import { contextBridge, ipcRenderer as electronIpcRenderer } from 'electron'
import { createStickyDiagnosticIpcRenderer } from './sticky-diagnostic-ipc.js'

const ipcRenderer = createStickyDiagnosticIpcRenderer(electronIpcRenderer)

contextBridge.exposeInMainWorld('stickyAPI', {
  reportLog: (payload) => ipcRenderer.send('logs:write', payload),
  getDiagnosticPolicy: () => ipcRenderer.diagnostics.getPolicy(),
  onDiagnosticPolicy: (callback) => ipcRenderer.diagnostics.subscribe(callback),
  onDiagnosticFlush: (callback) => ipcRenderer.diagnostics.onFlush(callback),
  registerDiagnosticCapability: (name) => ipcRenderer.diagnostics.capability(name),
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
