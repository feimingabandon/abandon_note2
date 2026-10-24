const { contextBridge, ipcRenderer } = require('electron')

// This private page has one fixed input and one completion port. Image bytes
// remain image data; the page receives no filesystem or arbitrary IPC access.
contextBridge.exposeInMainWorld('ownedImagePreview', {
  read: () => ipcRenderer.invoke('image-preview-input'),
  complete: (value) => ipcRenderer.invoke('image-preview-complete', value)
})
