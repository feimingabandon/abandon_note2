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

function installStructuredConsoleCapture(report, scope) {
  const originals = {
    warn: console.warn,
    error: console.error
  }

  for (const level of ['warn', 'error']) {
    console[level] = (...args) => {
      try {
        const error = args.find(
          (value) =>
            value instanceof Error ||
            (value &&
              typeof value === 'object' &&
              typeof value.message === 'string' &&
              ('stack' in value || 'code' in value || 'cause' in value))
        )
        if (error) {
          const message = args
            .filter((value) => value !== error)
            .map((value) =>
              typeof value === 'string' ? value : JSON.stringify(serializeError(value))
            )
            .join(' ')
          report({
            level,
            scope: `${scope}.console-${level}`,
            message: message || error.message,
            error,
            metadata: { argumentCount: args.length }
          })
        }
      } catch {
        // 控制台增强失败时仍必须执行原始 console，不能反过来干扰业务错误处理。
      }
      originals[level].apply(console, args)
    }
  }

  return () => {
    console.warn = originals.warn
    console.error = originals.error
  }
}

export function installBrowserErrorCapture(
  api,
  { scope = 'renderer', captureStructuredConsole = false } = {}
) {
  const report = createReporter(api, scope)
  const restoreConsole = captureStructuredConsole
    ? installStructuredConsoleCapture(report, scope)
    : () => {}
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
  report.restoreConsole = restoreConsole
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
