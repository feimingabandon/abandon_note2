import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), screen: {} }))
import { ReminderWindow } from '../src/main/services/ReminderWindow.js'

it('sends all displayed reminder ids through one batch when the popup is hidden', () => {
  const handlers = new Map()
  const onAction = vi.fn()
  const onDismissAll = vi.fn()
  const popup = new ReminderWindow({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel)
    },
    onAction,
    onDismissAll
  })
  const sender = {}
  popup.window = { webContents: sender, isDestroyed: () => false, hide: vi.fn(), destroy: vi.fn() }
  popup.rows = Array.from({ length: 1000 }, (_, id) => ({ id }))
  expect(handlers.get('reminders:hide')({ sender })).toBe(true)
  expect(onDismissAll).toHaveBeenCalledExactlyOnceWith(popup.rows.map((row) => row.id))
  expect(onAction).not.toHaveBeenCalled()
  expect(popup.window.hide).toHaveBeenCalledOnce()
  popup.dispose()
})

it('still hides the popup when batch admission fails', () => {
  const reportError = vi.fn()
  const error = new Error('正在清空便签数据')
  const popup = new ReminderWindow({
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    onDismissAll: () => {
      throw error
    },
    reportError
  })
  popup.window = { hide: vi.fn(), destroy: vi.fn() }
  popup.rows = [{ id: 'a' }, { id: 'b' }]
  popup.hideAll()
  expect(reportError).toHaveBeenCalledExactlyOnceWith('[reminders] dismiss failed', error)
  expect(popup.window.hide).toHaveBeenCalledOnce()
  popup.dispose()
})
