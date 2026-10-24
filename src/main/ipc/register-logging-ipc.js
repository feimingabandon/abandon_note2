/** Owns log export admission and transport; capture lifetimes stay with application owners. */
export function registerLoggingIpc({
  mainWindowIpc,
  removeHandler,
  getWindow,
  dialog,
  shell,
  diagnosticController,
  logStore,
  collectSystemDiagnostics,
  getAttachmentRecoveryReport,
  getCrashDumpsPath,
  refreshCrashDumpIndex,
  logger,
  now = Date.now
}) {
  if (typeof getAttachmentRecoveryReport !== 'function')
    throw new TypeError('附件恢复报告读取器不可用')
  const owned = []
  let disposed = false
  let diagnosticExporting = false
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
    handle('logs:query', async (_event, query) => logStore.queryLogs(query))
    handle('logs:attachment-recovery', (_event, ...args) => {
      if (args.length) throw new Error('附件恢复报告查询不接受参数')
      return structuredClone(getAttachmentRecoveryReport())
    })
    handle('logs:open-folder', async () => {
      await logStore.flushLogs()
      const errorMessage = await shell.openPath(logStore.getLogDirectory())
      if (errorMessage) throw new Error(errorMessage)
      return true
    })
    handle('logs:export', async (_event, options = {}) => {
      if (diagnosticExporting) throw new Error('已有诊断日志正在导出')
      diagnosticExporting = true
      let fileSnapshot
      try {
        const range = options?.range ?? 'all'
        if (!['all', 'last-hour'].includes(range)) throw new Error('不支持的日志导出范围')
        // Freeze at the click boundary, before the user waits in the save dialog.
        const requestedAt = now()
        let attachmentRecovery
        let attachmentRecoveryError = null
        try {
          attachmentRecovery = structuredClone(getAttachmentRecoveryReport())
        } catch (error) {
          attachmentRecoveryError = {
            field: 'attachmentRecovery',
            message: error?.message || String(error)
          }
        }
        const frozen = await diagnosticController.freeze('export', requestedAt)
        fileSnapshot = await logStore.freezeLogSnapshot()
        const selection =
          range === 'last-hour'
            ? { from: requestedAt - 3_600_000, to: requestedAt, requestId: frozen.requestId }
            : { requestId: frozen.requestId, to: requestedAt }
        selection.snapshotId = fileSnapshot.id
        const result = await dialog.showSaveDialog(getWindow(), {
          title: '导出诊断日志',
          defaultPath: `abandon-note-diagnostics-${range}-${new Date(requestedAt).toISOString().slice(0, 10)}.jsonl`,
          filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        let systemDiagnostics
        try {
          systemDiagnostics = await collectSystemDiagnostics()
        } catch (error) {
          systemDiagnostics = {
            capturedAt: new Date(now()).toISOString(),
            collectionErrors: [{ field: 'system', message: error?.message || String(error) }]
          }
        }
        const systemSnapshot = { ...systemDiagnostics }
        // This field belongs to the click-time read, including when that read failed.
        delete systemSnapshot.attachmentRecovery
        const hasCollectionErrors =
          attachmentRecoveryError || Object.hasOwn(systemSnapshot, 'collectionErrors')
        const collectionErrors = attachmentRecoveryError
          ? [
              ...(Array.isArray(systemSnapshot.collectionErrors)
                ? systemSnapshot.collectionErrors
                : []),
              attachmentRecoveryError
            ]
          : systemSnapshot.collectionErrors
        delete systemSnapshot.collectionErrors
        // Preserve small errors before report operations can consume the shared export budget.
        systemDiagnostics = {
          ...(hasCollectionErrors ? { collectionErrors } : {}),
          ...(attachmentRecoveryError ? {} : { attachmentRecovery }),
          ...systemSnapshot
        }
        await logStore.exportLogs(
          result.filePath,
          {
            logDirectory: logStore.getLogDirectory(),
            crashDumpsPath: getCrashDumpsPath(),
            recentCrashDumps: await refreshCrashDumpIndex(),
            exportScope: range === 'last-hour' ? 'last-hour' : 'all-retained-logs',
            ...(Number.isFinite(selection.from)
              ? {
                  from: new Date(selection.from).toISOString(),
                  to: new Date(selection.to).toISOString()
                }
              : {})
          },
          systemDiagnostics,
          selection,
          { capture: frozen, controller: diagnosticController.state() }
        )
        logger.info('logs.export', '诊断日志已导出', {
          targetPath: result.filePath,
          exportScope: range === 'last-hour' ? 'last-hour' : 'all-retained-logs'
        })
        return { canceled: false, filePath: result.filePath }
      } finally {
        await logStore.releaseLogSnapshot(fileSnapshot?.id)
        diagnosticExporting = false
      }
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
