function serializeError(error, seen = new WeakSet()) {
  if (typeof error === 'bigint') return String(error)
  if (!error || typeof error !== 'object') return error
  if (seen.has(error)) return '[Circular]'
  seen.add(error)
  if (error instanceof Error) {
    const result = {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
    if (error.code !== undefined) result.code = error.code
    if (error.cause !== undefined) result.cause = serializeError(error.cause, seen)
    for (const key of Object.keys(error)) {
      if (!(key in result)) result[key] = serializeError(error[key], seen)
    }
    return result
  }
  if (Array.isArray(error)) return error.map((item) => serializeError(item, seen))
  return Object.fromEntries(
    Object.entries(error).map(([key, value]) => [key, serializeError(value, seen)])
  )
}

function createReporter(api, defaultScope) {
  return ({ level = 'error', scope = defaultScope, message, error, metadata, dedupeKey }) => {
    try {
      api?.reportLog?.({
        level,
        scope,
        message: String(message || error?.message || ''),
        error: error === undefined ? undefined : serializeError(error),
        metadata: metadata === undefined ? undefined : serializeError(metadata),
        dedupeKey:
          dedupeKey ||
          (error instanceof Error ? error.stack || error.message : String(message || ''))
      })
    } catch {
      // Logging must never replace or hide the original application failure.
    }
  }
}

export function installBrowserErrorCapture(api, { scope = 'renderer' } = {}) {
  const report = createReporter(api, scope)
  window.addEventListener(
    'error',
    (event) => {
      const resourceTarget = event.target
      if (!(event.error instanceof Error) && resourceTarget && resourceTarget !== window) {
        report({
          scope: `${scope}.resource`,
          message: `资源加载失败：${resourceTarget.src || resourceTarget.href || resourceTarget.tagName}`,
          metadata: {
            tagName: resourceTarget.tagName,
            src: resourceTarget.src,
            href: resourceTarget.href
          }
        })
        return
      }
      report({
        scope: `${scope}.window-error`,
        message: event.message,
        error: event.error,
        metadata: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        }
      })
    },
    true
  )
  window.addEventListener('unhandledrejection', (event) => {
    report({
      scope: `${scope}.unhandled-rejection`,
      message:
        event.reason instanceof Error ? event.reason.message : `未处理的 Promise：${event.reason}`,
      error: event.reason
    })
  })
  return report
}

export function installVueErrorCapture(app, api) {
  const report = createReporter(api, 'vue')
  app.config.errorHandler = (error, instance, info) => {
    report({
      scope: 'vue.error',
      message: error?.message || 'Vue 运行异常',
      error,
      metadata: {
        info,
        component:
          instance?.$options?.name ||
          instance?.$options?.__name ||
          instance?.$?.type?.__name ||
          null
      }
    })
  }
  app.config.warnHandler = (message, instance, trace) => {
    report({
      level: 'warn',
      scope: 'vue.warning',
      message,
      metadata: {
        trace,
        component:
          instance?.$options?.name ||
          instance?.$options?.__name ||
          instance?.$?.type?.__name ||
          null
      },
      dedupeKey: `${message}|${trace}`
    })
  }
}

export const errorCaptureInternals = { serializeError }
