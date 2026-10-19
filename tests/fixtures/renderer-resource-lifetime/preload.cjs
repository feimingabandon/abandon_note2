const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  listImages: (noteId) => ipcRenderer.invoke('fixture:images', noteId),
  getImageThumbnail: (path) => ipcRenderer.invoke('fixture:thumbnail', path),
  getImageDimensions: () => Promise.resolve({ width: 64, height: 64 }),
  getImageBase64: (path) => ipcRenderer.invoke('fixture:original', path),
  saveImages: (noteId, images) => ipcRenderer.invoke('fixture:save-images', { noteId, images })
})
