import { installInteractionEvidence } from './diagnosticEvidence.js'
import { installRendererPerformanceDiagnostics } from './performanceDiagnostics.js'
import { diagnosticText, sanitizeDiagnosticValue } from '../../../shared/diagnostic-sanitize.js'

const serializeError = (error) => sanitizeDiagnosticValue(error, { maxBytes: 24576 })

function createReporter(api, defaultScope) {
  return ({ level = 'error', scope = defaultScope, message, error, metadata, dedupeKey }) => {
    try {
      api?.reportLog?.({
        level,
        scope,
        message: diagnosticText(message || error?.message || ''),
        error: error === undefined ? undefined : serializeError(error),
        metadata: metadata === undefined ? undefined : serializeError(metadata),
        dedupeKey:
          dedupeKey ||
          diagnosticText(
            error instanceof Error ? error.stack || error.message : String(message || '')
          )
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
        const boundedArgs = args.slice(0, 16)
        const error = boundedArgs.find(
          (value) =>
            value instanceof Error ||
            (value &&
              typeof value === 'object' &&
              typeof value.message === 'string' &&
              ('stack' in value || 'code' in value || 'cause' in value))
        )
        const message = boundedArgs
          .filter((value) => value !== error)
          .map((value) => {
            if (typeof value === 'string') return diagnosticText(value)
            try {
              return JSON.stringify(serializeError(value))
            } catch {
              return String(value)
            }
          })
          .join(' ')
        report({
          level,
          scope: `${scope}.console-${level}`,
          message: message || error?.message || `${level} console message`,
          error,
          metadata: { argumentCount: args.length },
          dedupeKey: error?.stack || `${level}|${message}`
        })
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
  const removeInteraction = installInteractionEvidence(api)
  const performanceMonitor = installRendererPerformanceDiagnostics(api)
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
  window.addEventListener(
    'pagehide',
    () => {
      removeInteraction()
      performanceMonitor.dispose()
      restoreConsole()
    },
    { once: true }
  )
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
