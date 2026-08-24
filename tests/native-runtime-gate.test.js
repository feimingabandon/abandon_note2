import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { enforceNativeRuntimeCompatibility } from '../src/main/native-runtime-gate.js'

describe('Windows native runtime startup gate', () => {
  it('allows startup when the native runtime is compatible', () => {
    const logger = { fatal: vi.fn(), error: vi.fn() }
    const dialog = { showErrorBox: vi.fn() }
    const flushLogs = vi.fn()
    const exit = vi.fn()

    expect(
      enforceNativeRuntimeCompatibility({
        getCompatibility: () => ({ success: true, required: true }),
        logger,
        dialog,
        flushLogs,
        exit
      })
    ).toBe(true)
    expect(logger.fatal).not.toHaveBeenCalled()
    expect(dialog.showErrorBox).not.toHaveBeenCalled()
    expect(flushLogs).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('logs, explains recovery, flushes, and exits on a missing or incompatible DLL', () => {
    const logger = { fatal: vi.fn(), error: vi.fn() }
    const dialog = { showErrorBox: vi.fn() }
    const flushLogs = vi.fn()
    const exit = vi.fn()

    expect(
      enforceNativeRuntimeCompatibility({
        getCompatibility: () => ({
          success: false,
          required: true,
          expectedAbiVersion: 1,
          actualAbiVersion: 0,
          dllPath: 'C:\\broken\\blur_engine.dll',
          error: { code: 'NATIVE_ABI_MISMATCH', message: 'ABI 不匹配' }
        }),
        logger,
        dialog,
        flushLogs,
        exit
      })
    ).toBe(false)
    expect(logger.fatal).toHaveBeenCalledWith(
      'startup.native-runtime',
      expect.objectContaining({ code: 'NATIVE_ABI_MISMATCH' }),
      expect.objectContaining({ expectedAbiVersion: 1, actualAbiVersion: 0 })
    )
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Abandon Note 无法启动',
      expect.stringMatching(/官方完整安装包[\s\S]*不会删除这些数据/)
    )
    expect(flushLogs).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('still flushes and exits when the error dialog itself fails', () => {
    const logger = { fatal: vi.fn(), error: vi.fn() }
    const flushLogs = vi.fn()
    const exit = vi.fn()

    expect(
      enforceNativeRuntimeCompatibility({
        getCompatibility: () => {
          throw new Error('export missing')
        },
        logger,
        dialog: {
          showErrorBox: () => {
            throw new Error('dialog unavailable')
          }
        },
        flushLogs,
        exit
      })
    ).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      'startup.native-runtime-dialog',
      expect.objectContaining({ message: 'dialog unavailable' })
    )
    expect(flushLogs).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('runs the native gate before opening the database', () => {
    const source = readFileSync(resolve('src/main/index.js'), 'utf8')
    const readyBlock = source.slice(source.indexOf('app.whenReady().then'))
    expect(readyBlock.indexOf('enforceNativeRuntimeCompatibility({')).toBeGreaterThanOrEqual(0)
    expect(readyBlock.indexOf('enforceNativeRuntimeCompatibility({')).toBeLessThan(
      readyBlock.indexOf('initDatabase()')
    )
  })
})
