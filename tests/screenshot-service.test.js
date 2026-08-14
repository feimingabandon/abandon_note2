import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  desktopCapturer: { getSources: vi.fn() },
  screen: { getDisplayNearestPoint: vi.fn(), getCursorScreenPoint: vi.fn() }
}))

vi.mock('electron', () => electronMocks)
vi.mock('../src/main/logging/logger.js', () => ({
  logger: { error: vi.fn() }
}))
vi.mock('../src/main/logging/window-capture.js', () => ({
  setWindowLogContext: vi.fn()
}))

import { ScreenshotService } from '../src/main/services/ScreenshotService.js'

describe('ScreenshotService dock suspension', () => {
  let handler
  let service
  let onCaptureStart
  let onCaptureEnd
  let webContents

  beforeEach(() => {
    handler = null
    webContents = {}
    onCaptureStart = vi.fn()
    onCaptureEnd = vi.fn()
    service = new ScreenshotService({
      ipcMain: {
        handle: vi.fn((_channel, nextHandler) => {
          handler = nextHandler
        }),
        removeHandler: vi.fn()
      },
      preloadPath: 'screenshot-preload.js',
      getMainWindow: () => ({ webContents }),
      onCaptureStart,
      onCaptureEnd
    })
    service.initialize()
  })

  it('keeps dock behavior suspended for the entire capture promise', async () => {
    let finishCapture
    service.capture = vi.fn(() => new Promise((resolve) => (finishCapture = resolve)))

    const resultPromise = handler({ sender: webContents })
    expect(onCaptureStart).toHaveBeenCalledOnce()
    expect(onCaptureEnd).not.toHaveBeenCalled()

    finishCapture('image')
    await expect(resultPromise).resolves.toBe('image')
    expect(onCaptureEnd).toHaveBeenCalledOnce()
  })

  it('always resumes dock behavior when capture throws', async () => {
    service.capture = vi.fn(() => Promise.reject(new Error('capture failed')))

    await expect(handler({ sender: webContents })).rejects.toThrow('capture failed')
    expect(onCaptureStart).toHaveBeenCalledOnce()
    expect(onCaptureEnd).toHaveBeenCalledOnce()
  })

  it('does not suspend dock behavior for an unauthorized renderer', async () => {
    await expect(handler({ sender: {} })).rejects.toThrow('无权使用截图功能')
    expect(onCaptureStart).not.toHaveBeenCalled()
    expect(onCaptureEnd).not.toHaveBeenCalled()
  })
})
