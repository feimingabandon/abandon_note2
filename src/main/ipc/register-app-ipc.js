/** Owns only the app-info/update transport registration; authorization/logging stay in the supplied registrar. */
export function registerAppIpc({
  mainWindowIpc,
  removeHandler,
  app,
  shell,
  appUpdateService,
  platform = process.platform,
  arch = process.arch
}) {
  const owned = []
  let disposed = false
  const handle = (channel, fn) => {
    mainWindowIpc.handle(channel, fn)
    owned.push(channel)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const channel of owned.splice(0)) removeHandler(channel)
  }
  try {
    handle('update:check', async () => appUpdateService.check())
    handle('app:get-info', () => ({ version: app.getVersion(), platform, arch }))
    handle('update:open-link', async (_event, request = {}) => {
      const { target } = request
      if (!['download', 'gitcode', 'github'].includes(target)) throw new Error('未知的更新入口')
      const url = appUpdateService.getExternalUrl(request)
      await shell.openExternal(url)
      return true
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
