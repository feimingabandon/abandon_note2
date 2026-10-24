/** Owns wallpaper transport; storage, settings ordering and compensation remain with the background coordinator. */
export function registerWallpaperIpc({
  mainWindowIpc,
  assertWriteSource = () => {},
  assertDocumentSource,
  wallpaperRetirement,
  createSettingsOperation,
  runMutation = (operation) => operation(),
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
    handle('wallpapers:save', (event, payload, source) => {
      assertWriteSource(event, source)
      return runMutation(() => backgroundSettingsCoordinator.saveWallpaper(payload || {}))
    })
    handle('wallpapers:activate', (event, payload, source) => {
      assertWriteSource(event, source)
      const operation = createSettingsOperation?.(source)
      return runMutation(() =>
        operation
          ? backgroundSettingsCoordinator.activateWallpaper(payload, operation)
          : backgroundSettingsCoordinator.activateWallpaper(payload)
      )
    })
    handle('wallpapers:disable', (event, source) => {
      assertWriteSource(event, source)
      const operation = createSettingsOperation?.(source)
      return runMutation(() =>
        operation
          ? backgroundSettingsCoordinator.disableWallpaper(operation)
          : backgroundSettingsCoordinator.disableWallpaper()
      )
    })
    handle('wallpapers:delete', (event, payload, source) => {
      assertWriteSource(event, source)
      return runMutation(() => backgroundSettingsCoordinator.deleteWallpaper(payload))
    })
    handle('wallpapers:retirement-ack', (event, payload, source) => {
      // Completion must stay available while a page-leave seal drains the
      // original mutation. Document and ticket ownership still apply.
      assertDocumentSource(event, source)
      return wallpaperRetirement.acknowledge(event, payload, source)
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
