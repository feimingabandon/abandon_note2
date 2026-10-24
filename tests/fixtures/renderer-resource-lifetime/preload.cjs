const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  fixtureDraftAssets: {
    stageImage: (image) => ipcRenderer.invoke('fixture:draft-stage', image),
    thumbnailAsset: (assetId, size) =>
      ipcRenderer.invoke('fixture:draft-thumbnail', { assetId, size }),
    previewAsset: (assetId) => ipcRenderer.invoke('fixture:draft-preview', assetId),
    releaseAssets: (assetIds) => ipcRenderer.invoke('fixture:draft-release', assetIds),
    flush: () => ipcRenderer.invoke('fixture:draft-flush')
  },
  listImages: (noteId) => ipcRenderer.invoke('fixture:images', noteId),
  getImageThumbnail: (path) => ipcRenderer.invoke('fixture:thumbnail', path),
  getImageDimensions: () => Promise.resolve({ width: 64, height: 64 }),
  getImageThumbnailDetails: async (path) => ({
    data: await ipcRenderer.invoke('fixture:thumbnail', path),
    width: 64,
    height: 64
  }),
  getImageBase64: (path) => ipcRenderer.invoke('fixture:original', path),
  saveImages: (noteId, images) => ipcRenderer.invoke('fixture:save-images', { noteId, images })
})
