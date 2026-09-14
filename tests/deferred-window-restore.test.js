import { expect, it, vi } from 'vitest'
import { createDeferredWindowRestore } from '../src/main/windows/deferred-window-restore.js'

it('runs after show returns and coalesces repeated notifications for the same window', () => {
  const queue = [],
    restore = vi.fn(),
    window = {}
  const request = createDeferredWindowRestore({
    schedule: (fn) => queue.push(fn),
    canRestore: () => true,
    restore
  })
  request(window, 'show')
  request(window, 'show')
  expect(restore).not.toHaveBeenCalled()
  expect(queue).toHaveLength(1)
  queue.shift()()
  expect(restore).toHaveBeenCalledExactlyOnceWith(window, 'show')
  request(window, 'tray')
  queue.shift()()
  expect(restore).toHaveBeenLastCalledWith(window, 'tray')
})

it.each(['hidden', 'destroyed', 'replaced'])('rechecks eligibility after the window is %s', () => {
  const queue = [],
    restore = vi.fn(),
    window = {}
  let eligible = true
  const request = createDeferredWindowRestore({
    schedule: (fn) => queue.push(fn),
    canRestore: () => eligible,
    restore
  })
  request(window, 'show')
  eligible = false
  queue.shift()()
  expect(restore).not.toHaveBeenCalled()
})
