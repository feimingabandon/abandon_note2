import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  errorCaptureInternals,
  installBrowserErrorCapture,
  installVueErrorCapture
} from '../src/renderer/src/utils/installErrorCapture.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.window
})

describe('renderer error capture', () => {
  it('serializes Error details, causes and custom fields without losing circular values', () => {
    const cause = new Error('数据库不可用')
    const error = new Error('保存失败', { cause })
    error.code = 'SAVE_FAILED'
    error.context = { noteId: 42 }
    error.context.self = error.context
    error.self = error

    expect(errorCaptureInternals.serializeError(error)).toMatchObject({
      name: 'Error',
      message: '保存失败',
      code: 'SAVE_FAILED',
      cause: {
        name: 'Error',
        message: '数据库不可用'
      },
      context: {
        noteId: 42,
        self: '[Circular]'
      },
      self: '[Circular]'
    })
  })

  it('reports window errors and unhandled promise rejections through the restricted API', () => {
    const listeners = new Map()
    globalThis.window = {
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener))
    }
    const reportLog = vi.fn()
    installBrowserErrorCapture({ reportLog }, { scope: 'test-renderer' })

    const runtimeError = new Error('渲染失败')
    listeners.get('error')({
      target: globalThis.window,
      message: runtimeError.message,
      error: runtimeError,
      filename: 'Page.vue',
      lineno: 12,
      colno: 8
    })
    listeners.get('unhandledrejection')({ reason: new Error('Promise 失败') })

    expect(reportLog).toHaveBeenCalledTimes(2)
    expect(reportLog.mock.calls[0][0]).toMatchObject({
      level: 'error',
      scope: 'test-renderer.window-error',
      message: '渲染失败',
      error: {
        name: 'Error',
        message: '渲染失败'
      }
    })
    expect(reportLog.mock.calls[1][0]).toMatchObject({
      scope: 'test-renderer.unhandled-rejection',
      message: 'Promise 失败'
    })
  })

  it('captures Vue component errors with component and lifecycle context', () => {
    const reportLog = vi.fn()
    const app = { config: {} }
    installVueErrorCapture(app, { reportLog })

    app.config.errorHandler(
      new Error('mounted 失败'),
      { $options: { name: 'SettingsPanel' } },
      'mounted hook'
    )

    expect(reportLog).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'vue.error',
        message: 'mounted 失败',
        metadata: {
          info: 'mounted hook',
          component: 'SettingsPanel'
        }
      })
    )
  })
})
