import { describe, expect, it, vi } from 'vitest'
import { assertMainWindowSender, createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'

describe('主窗口 IPC 授权', () => {
  it('只允许当前主窗口的 webContents', () => {
    const webContents = {}
    const getMainWindow = () => ({ isDestroyed: () => false, webContents })

    expect(() =>
      assertMainWindowSender({ sender: webContents }, getMainWindow, '测试功能')
    ).not.toThrow()
    expect(() => assertMainWindowSender({ sender: {} }, getMainWindow, '测试功能')).toThrow(
      '无权访问测试功能'
    )
  })

  it('在业务 handler 执行前统一拒绝未授权 sender', () => {
    const handlers = new Map()
    const rawIpcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
    const webContents = {}
    const handler = vi.fn(() => 'ok')
    createMainWindowIpc(
      rawIpcMain,
      () => ({ isDestroyed: () => false, webContents }),
      '业务数据'
    ).handle('example', handler)

    expect(() => handlers.get('example')({ sender: {} }, 1)).toThrow('无权访问业务数据')
    expect(handler).not.toHaveBeenCalled()
    expect(handlers.get('example')({ sender: webContents }, 2)).toBe('ok')
    expect(handler).toHaveBeenCalledWith({ sender: webContents }, 2)
  })

  it('允许显式只读请求把旧窗口 sender 转换为取消结果', () => {
    const handlers = new Map()
    const webContents = {}
    const mainWindow = { isDestroyed: () => false, webContents }
    createMainWindowIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      () => mainWindow,
      '业务数据'
    ).handle('read-only', () => 'current', { onStaleSender: () => null })

    expect(handlers.get('read-only')({ sender: webContents })).toBe('current')
    expect(handlers.get('read-only')({ sender: {} })).toBeNull()
  })
})
