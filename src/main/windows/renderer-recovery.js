/** Bound automatic recovery; native dialogs remain usable when the renderer is gone. */
export function installRendererRecovery(
  window,
  { dialog, logger, canRecover = () => true, restart, openDiagnostics = () => {} }
) {
  let failures = []
  let recovering = false
  let timer = null
  const reload = () => {
    if (window.isDestroyed() || !canRecover()) return
    window.webContents.reload()
  }
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (window.isDestroyed() || !canRecover() || recovering || details.reason === 'clean-exit')
      return
    logger.error('renderer.recovery', new Error('主界面进程退出'), details)
    failures = failures.filter((time) => Date.now() - time < 60_000)
    failures.push(Date.now())
    if (failures.length <= 2) {
      timer = setTimeout(reload, 350)
      return
    }
    recovering = true
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'error',
        message: '界面连续出现异常',
        detail:
          '已暂停自动重载。已提交的便签仍在本机；未保存草稿可在重新打开对应编辑器后恢复，也可从设置导出。',
        buttons: ['重新加载界面', '重启应用', '打开诊断日志', '暂时保留窗口'],
        defaultId: 0,
        cancelId: 3
      })
      if (response === 0) reload()
      if (response === 1) restart()
      if (response === 2) await openDiagnostics()
    } finally {
      recovering = false
    }
  })
  window.on('unresponsive', async () => {
    if (recovering || !canRecover()) return
    recovering = true
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: '界面暂时没有响应',
        detail: '可以继续等待。重新加载会中断当前操作，只能恢复最后成功暂存的草稿。',
        buttons: ['继续等待', '重新加载界面'],
        defaultId: 0,
        cancelId: 0
      })
      if (response === 1) reload()
    } finally {
      recovering = false
    }
  })
  window.on('closed', () => clearTimeout(timer))
}
