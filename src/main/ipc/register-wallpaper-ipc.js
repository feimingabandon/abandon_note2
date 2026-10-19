/** Owns wallpaper transport; storage, settings ordering and compensation remain with the background coordinator. */
export function registerWallpaperIpc({
  mainWindowIpc,
  removeHandler,
  backgroundSettingsCoordinator,
  getWallpaperThumbnail,
  getWallpaperDataUrl
}) {
  const owned = []
  let disposed = false
  const handle = (channel, handler) => {
    mainWindowIpc.handle(channel, handler)
    owned.push(channel)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of owned.splice(0)) removeHandler(channel)
  }

  try {
    handle('wallpapers:list', () => backgroundSettingsCoordinator.listWallpaperLibraryRecords())
    handle('wallpapers:get-thumbnail', (_event, { id, maxSize }) =>
      getWallpaperThumbnail(id, maxSize)
    )
    handle('wallpapers:get-data', (_event, { id, original = false }) =>
      getWallpaperDataUrl(id, { original })
    )
    handle('wallpapers:save', (_event, payload) =>
      backgroundSettingsCoordinator.saveWallpaper(payload || {})
    )
    handle('wallpapers:activate', (_event, payload) =>
      backgroundSettingsCoordinator.activateWallpaper(payload)
    )
    handle('wallpapers:disable', () => backgroundSettingsCoordinator.disableWallpaper())
    handle('wallpapers:delete', (_event, payload) =>
      backgroundSettingsCoordinator.deleteWallpaper(payload)
    )
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
