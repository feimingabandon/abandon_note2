import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }))
  }
}))
import { BrowserWindow } from 'electron'
import {
  ReminderWindow,
  REMINDER_INITIALIZATION_TIMEOUT_MS
} from '../src/main/services/ReminderWindow.js'

const popups = new Set()
afterEach(() => {
  for (const popup of popups) popup.dispose()
  popups.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  BrowserWindow.mockReset()
})

function deferred() {
  let resolve, reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeWindow() {
  const win = new EventEmitter()
  const contents = new EventEmitter()
  let destroyed = false
  let visible = false
  const load = deferred()
  Object.assign(contents, {
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed)
  })
  Object.assign(win, {
    webContents: contents,
    load,
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    loadFile: vi.fn(() => load.promise),
    loadURL: vi.fn(() => load.promise),
    showInactive: vi.fn(() => {
      visible = true
      win.emit('show')
    }),
    show: vi.fn(() => {
      visible = true
      win.emit('show')
    }),
    focus: vi.fn(() => win.emit('focus')),
    hide: vi.fn(() => {
      const wasVisible = visible
      visible = false
      if (wasVisible) win.emit('hide')
    }),
    destroy: vi.fn(() => {
      if (destroyed) return
      destroyed = true
      visible = false
      contents.emit('destroyed')
      win.emit('closed')
    }),
    close: () => {
      const event = { preventDefault: vi.fn() }
      win.emit('close', event)
      if (!event.preventDefault.mock.calls.length) win.destroy()
      return event
    }
  })
  return win
}

function fixture({ construct, ...options } = {}) {
  vi.useFakeTimers()
  const handlers = new Map()
  const windows = []
  const onDismissAll = vi.fn()
  const reportError = vi.fn()
  const popup = new ReminderWindow({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: vi.fn((channel) => handlers.delete(channel))
    },
    preloadPath: 'reminder-preload.js',
    rendererPath: 'renderer',
    onAction: vi.fn(),
    onDismissAll,
    reportError,
    getSettings: vi.fn(() => ({ appearance: 'shared' })),
    ...options
  })
  popups.add(popup)
  BrowserWindow.mockImplementation(function () {
    const win = fakeWindow()
    windows.push(win)
    construct?.(win, popup)
    return win
  })
  return {
    popup,
    windows,
    handlers,
    onDismissAll,
    reportError,
    ready: (win = windows.at(-1)) => handlers.get('reminders:ready')({ sender: win.webContents })
  }
}

const rows = (ids = ['a']) => ids.map((id) => ({ id, note_id: id, content: id, due_at: 1000 }))
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

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

describe('owned reminder initialization', () => {
  it.each(['ready-first', 'load-first'])('presents once after both gates: %s', async (order) => {
    const f = fixture()
    f.popup.sync(rows())
    const win = f.windows[0]
    if (order === 'ready-first') f.ready(win)
    else {
      win.load.resolve()
      await settle()
    }
    expect(win.showInactive).not.toHaveBeenCalled()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
    if (order === 'ready-first') {
      f.popup.sync(rows(['a', 'b']))
      win.load.resolve()
      await settle()
    } else f.ready(win)
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.webContents.send.mock.lastCall[1].reminders).toHaveLength(
      order === 'ready-first' ? 2 : 1
    )
    f.ready(win)
    f.ready(win)
    win.webContents.emit('did-stop-loading')
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(f.popup.focusRequest).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not treat did-stop-loading as load success and retains rows after rejection', async () => {
    const f = fixture()
    const reminders = rows()
    f.popup.sync(reminders)
    const win = f.windows[0]
    f.ready(win)
    win.webContents.emit('did-stop-loading')
    expect(win.showInactive).not.toHaveBeenCalled()
    const failure = new Error('load rejected')
    win.load.reject(failure)
    await settle()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(f.popup.rows).toBe(reminders)
    expect(f.onDismissAll).not.toHaveBeenCalled()
    expect(f.reportError).toHaveBeenCalledWith('[reminders] window load failed', failure)
    expect(() => f.ready(win)).toThrow('无权访问便签提醒')
    f.popup.sync(reminders)
    const next = f.windows[1]
    next.load.resolve()
    await settle()
    f.ready(next)
    expect(next.showInactive).toHaveBeenCalledOnce()
  })

  it.each(['neither', 'only-ready', 'only-load'])(
    'uses one real 15 second deadline: %s',
    async (gate) => {
      const f = fixture()
      f.popup.sync(rows())
      const win = f.windows[0]
      expect(REMINDER_INITIALIZATION_TIMEOUT_MS).toBe(15000)
      if (gate === 'only-ready') f.ready(win)
      if (gate === 'only-load') {
        win.load.resolve()
        await settle()
      }
      vi.advanceTimersByTime(14999)
      expect(win.destroy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(win.destroy).toHaveBeenCalledOnce()
      expect(f.reportError).toHaveBeenCalledWith(
        '[reminders] window initialization timed out',
        expect.objectContaining({ code: 'REMINDER_INITIALIZATION_TIMEOUT' })
      )
      win.load.resolve()
      await settle()
      expect(win.showInactive).not.toHaveBeenCalled()
      expect(win.focus).not.toHaveBeenCalled()
      expect(f.popup.rows).toHaveLength(1)
      expect(f.onDismissAll).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('includes synchronous construction time in the same deadline', () => {
    const f = fixture({ construct: () => vi.setSystemTime(Date.now() + 15000) })
    f.popup.sync(rows())
    expect(f.windows[0].destroy).toHaveBeenCalledOnce()
    expect(f.windows[0].loadFile).not.toHaveBeenCalled()
    expect(f.reportError).toHaveBeenCalledWith(
      '[reminders] window initialization timed out',
      expect.objectContaining({ code: 'REMINDER_INITIALIZATION_TIMEOUT' })
    )
  })

  it.each(['sync', 'focus'])(
    'keeps the current %s request when it discovers an expired prior entry',
    async (request) => {
      const f = fixture()
      f.popup.sync(rows())
      const expired = f.windows[0]
      // Move wall time without delivering the timer: this models returning from synchronous work.
      vi.setSystemTime(Date.now() + 15000)
      if (request === 'sync') f.popup.sync(rows())
      else f.popup.focusRound('a')
      const next = f.windows[1]
      expect(expired.destroy).toHaveBeenCalledOnce()
      expect(next).toBeDefined()
      next.load.resolve()
      await settle()
      f.ready(next)
      if (request === 'sync') {
        expect(next.showInactive).toHaveBeenCalledOnce()
        expect(next.focus).not.toHaveBeenCalled()
      } else {
        expect(next.show).toHaveBeenCalledOnce()
        expect(next.focus).toHaveBeenCalledOnce()
        expect(f.popup.focusRequest).toBe(1)
      }
      expired.load.resolve()
      await settle()
      expect(next.destroy).not.toHaveBeenCalled()
    }
  )

  it('does not inherit expired pending focus when an independent sync replaces its window', async () => {
    const f = fixture()
    f.popup.sync(rows())
    f.popup.focusRound('a')
    const expired = f.windows[0]
    vi.setSystemTime(Date.now() + 15000)
    f.popup.sync(rows())
    const next = f.windows[1]
    next.load.resolve()
    await settle()
    f.ready(next)
    expect(expired.destroy).toHaveBeenCalledOnce()
    expect(next.showInactive).toHaveBeenCalledOnce()
    expect(next.show).not.toHaveBeenCalled()
    expect(next.focus).not.toHaveBeenCalled()
    expect(f.popup.focusRequest).toBe(1)
  })

  it('keeps a new focus request when construction synchronously refreshes its rows', async () => {
    let refreshDuringConstruction = false
    const f = fixture({
      construct: (_win, popup) => {
        if (refreshDuringConstruction) popup.sync(rows())
      }
    })
    f.popup.sync(rows())
    vi.advanceTimersByTime(15000)
    refreshDuringConstruction = true
    f.popup.focusRound('a')
    const next = f.windows[1]
    next.load.resolve()
    await settle()
    f.ready(next)
    expect(next.show).toHaveBeenCalledOnce()
    expect(next.focus).toHaveBeenCalledOnce()
    expect(next.showInactive).not.toHaveBeenCalled()
    expect(f.popup.focusRequest).toBe(1)
  })

  it.each(['construction', 'wiring', 'load'])(
    'cleans synchronous %s exceptions and permits a later operation',
    (phase) => {
      const failure = new Error(phase)
      const f = fixture({
        construct: (win) => {
          if (phase === 'construction') throw failure
          if (phase === 'wiring')
            win.webContents.setWindowOpenHandler.mockImplementation(() => {
              throw failure
            })
          if (phase === 'load')
            win.loadFile.mockImplementation(() => {
              throw failure
            })
        }
      })
      f.popup.sync(rows())
      expect(f.popup.window).toBeNull()
      expect(f.reportError).toHaveBeenCalledWith(
        '[reminders] window initialization failed',
        failure
      )
      if (phase !== 'construction') expect(f.windows[0].destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      BrowserWindow.mockImplementationOnce(function () {
        const next = fakeWindow()
        f.windows.push(next)
        return next
      })
      f.popup.sync(rows())
      expect(f.popup.window).toBe(f.windows[1])
    }
  )

  it.each(['construction', 'wiring'])(
    'cancels destruction during %s before runtime listeners exist',
    async (phase) => {
      const f = fixture({
        construct: (win) => {
          if (phase === 'construction') win.destroy()
          else win.webContents.setWindowOpenHandler.mockImplementation(() => win.destroy())
        }
      })
      f.popup.sync(rows())
      const destroyed = f.windows[0]
      expect(destroyed.destroy).toHaveBeenCalledOnce()
      expect(destroyed.loadFile).not.toHaveBeenCalled()
      expect(f.popup.initialization).toBeNull()
      expect(f.popup.window).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      expect(destroyed.eventNames()).toEqual([])
      expect(destroyed.webContents.eventNames()).toEqual([])
      BrowserWindow.mockImplementationOnce(function () {
        const next = fakeWindow()
        f.windows.push(next)
        return next
      })
      f.popup.sync(rows())
      const next = f.windows[1]
      next.load.resolve()
      await settle()
      f.ready(next)
      expect(next.showInactive).toHaveBeenCalledOnce()
      expect(f.reportError).not.toHaveBeenCalled()
    }
  )

  it('keeps latest pending focus and consumes it without replaying or incrementing on ready', async () => {
    const f = fixture()
    f.popup.sync(rows(['a', 'b']))
    const win = f.windows[0]
    expect(f.popup.focusRound('missing')).toBe(false)
    expect(f.popup.focusRequest).toBe(0)
    f.popup.focusRound('a')
    f.popup.focusRound('b')
    f.ready(win)
    expect(win.show).not.toHaveBeenCalled()
    win.load.resolve()
    await settle()
    expect(f.popup.snapshot()).toMatchObject({ focusId: 'b', focusRequest: 2 })
    expect(win.webContents.send.mock.lastCall[1]).toMatchObject({ focusId: 'b', focusRequest: 2 })
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(win.showInactive).not.toHaveBeenCalled()
    f.ready(win)
    f.popup.sync(rows(['a', 'b']))
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(f.popup.focusRequest).toBe(2)
    f.popup.focusRound('b')
    expect(win.focus).toHaveBeenCalledTimes(2)
    expect(f.popup.focusRequest).toBe(3)
  })

  it('revokes removed pending focus while other reminders may present passively', async () => {
    const f = fixture()
    f.popup.sync(rows(['a', 'b']))
    f.popup.focusRound('a')
    f.popup.sync(rows(['b']))
    const win = f.windows[0]
    f.ready(win)
    win.load.resolve()
    await settle()
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(f.popup.focusId).toBeNull()
    expect(f.popup.focusRequest).toBe(1)
  })

  it.each(['hide', 'empty'])(
    'late gates do not overrule %s, but a later sync is a new passive intent',
    async (action) => {
      const f = fixture()
      f.popup.sync(rows())
      f.popup.focusRound('a')
      const win = f.windows[0]
      if (action === 'hide') f.popup.hideAll()
      else f.popup.sync([])
      f.ready(win)
      win.load.resolve()
      await settle()
      expect(win.showInactive).not.toHaveBeenCalled()
      expect(win.show).not.toHaveBeenCalled()
      expect(win.focus).not.toHaveBeenCalled()
      f.popup.sync(rows())
      expect(win.showInactive).toHaveBeenCalledOnce()
      expect(win.focus).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'hiding wins over synchronous dismiss refresh and focus, including failure=%s',
    async (fails) => {
      const failure = new Error('dismiss failed')
      const f = fixture()
      f.popup.onDismissAll = vi.fn(() => {
        f.popup.sync(rows())
        expect(f.popup.focusRound('a')).toBe(false)
        if (fails) throw failure
      })
      f.popup.sync(rows())
      f.popup.focusRound('a')
      const win = f.windows[0]
      f.popup.hideAll()
      f.ready(win)
      win.load.resolve()
      await settle()
      expect(f.popup.onDismissAll).toHaveBeenCalledExactlyOnceWith(['a'])
      expect(win.hide).toHaveBeenCalledOnce()
      expect(win.showInactive).not.toHaveBeenCalled()
      expect(win.show).not.toHaveBeenCalled()
      expect(win.focus).not.toHaveBeenCalled()
      if (fails) expect(f.reportError).toHaveBeenCalledWith('[reminders] dismiss failed', failure)
      f.popup.focusRound('a')
      expect(win.focus).toHaveBeenCalledOnce()
    }
  )

  it('cancels pending close, but a successful close keeps the hidden reusable window', async () => {
    const f = fixture()
    f.popup.sync(rows())
    const first = f.windows[0]
    expect(first.close().preventDefault).toHaveBeenCalledOnce()
    expect(first.destroy).toHaveBeenCalledOnce()
    first.load.resolve()
    await settle()
    expect(first.showInactive).not.toHaveBeenCalled()
    f.popup.sync(rows())
    const next = f.windows[1]
    next.load.resolve()
    await settle()
    f.ready(next)
    next.close()
    expect(next.destroy).not.toHaveBeenCalled()
    expect(next.isVisible()).toBe(false)
    f.ready(next)
    expect(next.showInactive).toHaveBeenCalledOnce()
    f.popup.sync(rows())
    expect(f.windows).toHaveLength(2)
    expect(next.showInactive).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['closed', 'resolve'],
    ['closed', 'reject'],
    ['contents-destroyed', 'resolve'],
    ['contents-destroyed', 'reject'],
    ['crash', 'resolve'],
    ['crash', 'reject']
  ])('invalidates %s and isolates replacement from old load %s', async (event, outcome) => {
    const f = fixture()
    f.popup.sync(rows())
    const first = f.windows[0]
    if (event === 'closed') first.destroy()
    if (event === 'contents-destroyed') first.webContents.emit('destroyed')
    if (event === 'crash') first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    f.popup.sync(rows())
    const next = f.windows[1]
    if (outcome === 'resolve') first.load.resolve()
    else first.load.reject(new Error('late old load failure'))
    await settle()
    expect(f.popup.window).toBe(next)
    expect(next.destroy).not.toHaveBeenCalled()
    expect(() => f.ready(first)).toThrow('无权访问便签提醒')
    next.load.resolve()
    await settle()
    f.ready(next)
    expect(next.showInactive).toHaveBeenCalledOnce()
  })

  it.each(['hide', 'stop', 'dispose', 'close'])(
    'does not focus after a synchronous show callback chooses %s',
    async (action) => {
      const f = fixture()
      f.popup.sync(rows())
      const win = f.windows[0]
      win.once('show', () => {
        if (action === 'hide') f.popup.hideAll()
        if (action === 'stop') f.popup.stopPresentation()
        if (action === 'dispose') f.popup.dispose()
        if (action === 'close') win.close()
      })
      f.popup.focusRound('a')
      f.ready(win)
      win.load.resolve()
      await settle()
      expect(win.focus).not.toHaveBeenCalled()
      expect(win.showInactive).not.toHaveBeenCalled()
    }
  )

  it.each(['showInactive', 'show', 'focus', 'send'])(
    'terminates native %s failures without dismissing rows',
    async (method) => {
      const f = fixture()
      f.popup.sync(rows())
      const win = f.windows[0]
      const failure = new Error(method)
      const target = method === 'send' ? win.webContents : win
      target[method].mockImplementation(() => {
        throw failure
      })
      if (method === 'show' || method === 'focus') f.popup.focusRound('a')
      f.ready(win)
      win.load.resolve()
      await settle()
      expect(win.destroy).toHaveBeenCalledOnce()
      expect(f.onDismissAll).not.toHaveBeenCalled()
      expect(f.popup.rows).toHaveLength(1)
      expect(f.reportError).toHaveBeenCalledWith('[reminders] window presentation failed', failure)
    }
  )

  it.each(['stop', 'dispose'])(
    'does not publish a window when construction reenters %s',
    async (action) => {
      const f = fixture({
        construct: (_win, popup) => (action === 'stop' ? popup.stopPresentation() : popup.dispose())
      })
      f.popup.sync(rows())
      const win = f.windows[0]
      expect(win.destroy).toHaveBeenCalledOnce()
      expect(win.loadFile).not.toHaveBeenCalled()
      expect(f.popup.window).toBeNull()
      win.load.resolve()
      await settle()
      f.popup.sync(rows())
      expect(f.popup.focusRound('a')).toBe(false)
      expect(f.windows).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('stops during window wiring before loading and releases attached listeners', () => {
    const f = fixture({
      construct: (win, popup) => {
        win.webContents.setWindowOpenHandler.mockImplementation(() => popup.stopPresentation())
      }
    })
    f.popup.sync(rows())
    const win = f.windows[0]
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(win.loadFile).not.toHaveBeenCalled()
    expect(win.eventNames()).toEqual([])
    expect(win.webContents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes a load rejected after synchronous stop', async () => {
    const f = fixture({
      construct: (win, popup) => {
        win.loadFile.mockImplementation(() => {
          popup.stopPresentation()
          return win.load.promise
        })
      }
    })
    f.popup.sync(rows())
    const win = f.windows[0]
    win.load.reject(new Error('aborted on stop'))
    await settle()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(f.reportError).not.toHaveBeenCalled()
    expect(win.eventNames()).toEqual([])
    expect(win.webContents.eventNames()).toEqual([])
  })

  it('stops pending presentation permanently and keeps ready windows for final dispose', async () => {
    const pending = fixture()
    pending.popup.sync(rows())
    const first = pending.windows[0]
    pending.popup.stopPresentation()
    pending.popup.stopPresentation()
    first.load.resolve()
    await settle()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(() => pending.ready(first)).toThrow('无权访问便签提醒')
    pending.popup.sync(rows())
    pending.popup.focusRound('a')
    expect(pending.windows).toHaveLength(1)
    expect(pending.onDismissAll).not.toHaveBeenCalled()

    const ready = fixture()
    ready.popup.sync(rows())
    const win = ready.windows[0]
    win.load.resolve()
    await settle()
    ready.ready(win)
    win.hide()
    ready.popup.stopPresentation()
    ready.popup.sync(rows())
    ready.popup.focusRound('a')
    ready.ready(win)
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.destroy).not.toHaveBeenCalled()
    ready.popup.dispose()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(ready.handlers.size).toBe(0)
    expect(win.eventNames()).toEqual([])
    expect(win.webContents.eventNames()).toEqual([])
  })

  it('external settings send publishes snapshots without creating or presenting windows', async () => {
    const f = fixture()
    f.popup.send()
    expect(f.windows).toHaveLength(0)
    f.popup.sync(rows())
    const win = f.windows[0]
    f.popup.send()
    expect(win.webContents.send).not.toHaveBeenCalled()
    win.load.resolve()
    await settle()
    f.ready(win)
    win.hide()
    const sends = win.webContents.send.mock.calls.length
    f.popup.send()
    expect(win.webContents.send).toHaveBeenCalledTimes(sends + 1)
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('finishes cleanup when a diagnostic callback throws', async () => {
    const f = fixture({
      reportError: () => {
        throw new Error('diagnostic failed')
      }
    })
    f.popup.sync(rows())
    const win = f.windows[0]
    win.load.reject(new Error('load failed'))
    await settle()
    expect(win.destroy).toHaveBeenCalledOnce()
    expect(f.popup.window).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a failed early destruction for final disposal without restoring presentation', () => {
    const f = fixture()
    f.popup.sync(rows())
    const win = f.windows[0]
    const destroy = win.destroy.getMockImplementation()
    const failure = new Error('native destroy failed')
    win.destroy.mockImplementationOnce(() => {
      throw failure
    })
    f.popup.stopPresentation()
    expect(f.reportError).toHaveBeenCalledWith('[reminders] window cleanup failed', failure)
    expect(f.popup.window).toBeNull()
    expect(f.popup.retainedWindows.has(win)).toBe(true)
    expect(f.popup.focusRound('a')).toBe(false)
    win.destroy.mockImplementation(destroy)
    f.popup.dispose()
    expect(win.destroy).toHaveBeenCalledTimes(2)
    expect(win.isDestroyed()).toBe(true)
    expect(f.popup.retainedWindows.size).toBe(0)
  })

  it('reports final destruction failure after removing IPC and cancelling its deadline', () => {
    const f = fixture()
    f.popup.sync(rows())
    const win = f.windows[0]
    const failure = new Error('final native destroy failed')
    win.destroy.mockImplementation(() => {
      throw failure
    })
    expect(() => f.popup.dispose()).toThrow(AggregateError)
    expect(f.handlers.size).toBe(0)
    expect(f.popup.retainedWindows.has(win)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.popup.dispose()).not.toThrow()
  })
})
