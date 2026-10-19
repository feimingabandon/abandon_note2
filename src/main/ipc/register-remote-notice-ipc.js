/** Owns remote-notice transport; local notice commands and cached remote health remain with their owners. */
export function registerRemoteNoticeIpc({
  mainWindowIpc,
  removeHandler,
  listPendingRemoteNotices,
  listRemoteNotices,
  acknowledgeRemoteNotice,
  getRemoteNoticeLink,
  getRemoteCoordinator,
  shell,
  warn = (...args) => console.warn(...args)
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
    handle('remote-notices:list-pending', () => listPendingRemoteNotices())
    handle('remote-notices:list', (_event, query) => listRemoteNotices(query))
    handle('remote-notices:acknowledge', (_event, { id }) => acknowledgeRemoteNotice(id))
    handle('remote-notices:open-link', (_event, { id }) => {
      const link = getRemoteNoticeLink(id)
      if (!link) return false
      try {
        const url = new URL(link)
        if (url.protocol !== 'https:') return false
        shell
          .openExternal(url.toString())
          .catch((error) => warn('[remote] 打开通知链接失败:', error))
        return true
      } catch {
        return false
      }
    })
    // Reading this cache must not start or refresh a network request.
    handle('remote:get-health', () => {
      const coordinator = getRemoteCoordinator()
      return coordinator
        ? coordinator.getHealthSnapshot()
        : {
            available: false,
            noticeService: false,
            reportService: false,
            checkedAt: null,
            checking: false,
            skipped: false,
            error: '远程服务尚未初始化'
          }
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
