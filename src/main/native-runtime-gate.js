function createNativeStartupError(compatibility) {
  const detail = compatibility?.error?.message || 'Windows 原生组件不可用'
  const error = new Error(detail)
  error.code = compatibility?.error?.code || 'NATIVE_RUNTIME_INCOMPATIBLE'
  return error
}

export function enforceNativeRuntimeCompatibility({
  getCompatibility,
  logger,
  dialog,
  flushLogs,
  exit
}) {
  let compatibility
  try {
    compatibility = getCompatibility()
  } catch (error) {
    compatibility = {
      success: false,
      required: true,
      error: {
        code: error?.code || 'NATIVE_RUNTIME_CHECK_FAILED',
        message: error?.message || String(error)
      }
    }
  }

  if (compatibility?.success) return true

  const startupError = createNativeStartupError(compatibility)
  logger.fatal('startup.native-runtime', startupError, {
    expectedAbiVersion: compatibility?.expectedAbiVersion ?? null,
    actualAbiVersion: compatibility?.actualAbiVersion ?? null,
    dllPath: compatibility?.dllPath ?? null
  })

  const detail = compatibility?.error?.message || 'Windows 原生组件缺失或版本不匹配'
  const message =
    'Windows 原生组件缺失、损坏或版本不匹配，Abandon Note 已停止启动。\n\n' +
    '请重新下载官方完整安装包并覆盖安装。便签、设置和附件保存在用户数据目录中，覆盖安装不会删除这些数据。\n\n' +
    `错误：${detail}`

  try {
    dialog.showErrorBox('Abandon Note 无法启动', message)
  } catch (dialogError) {
    logger.error('startup.native-runtime-dialog', dialogError)
  } finally {
    try {
      flushLogs()
    } finally {
      exit(1)
    }
  }
  return false
}
