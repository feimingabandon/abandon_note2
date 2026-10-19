import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBusinessIpcHandlers } from '../src/main/ipc/register-business-ipc.js'

const store = vi.hoisted(() => ({
  deleteNote: vi.fn(),
  getNoteById: vi.fn(),
  purgeNoteAndFiles: vi.fn()
}))

vi.mock('electron', () => ({ clipboard: {} }))
vi.mock('../src/main/db/db.js', () => ({}))
vi.mock('../src/main/db/db-historical-note-move.js', () => ({}))
vi.mock('../src/main/db/db-notes.js', () => store)
vi.mock('../src/main/db/db-tags.js', () => ({}))
vi.mock('../src/main/db/db-templates.js', () => ({}))
vi.mock('../src/main/db/db-images.js', () => ({ purgeNoteAndFiles: store.purgeNoteAndFiles }))
vi.mock('../src/main/db/image-addition-compensation.js', () => ({}))
vi.mock('../src/main/notes/note-commands.js', () => ({
  normalizeNoteCreateOptions: (options) => options
}))
vi.mock('../src/main/logging/operation-context.js', () => ({
  checkpoint: vi.fn(),
  diagnosticBroadcast: (payload) => payload
}))
vi.mock('../src/main/logging/persistence-evidence.js', () => ({
  observeNoteMutation: (handler, _readNote, event, args) => handler(event, ...args)
}))

function fixture() {
  const handlers = new Map()
  const order = []
  const send = vi.fn(() => order.push('broadcast'))
  const window = {
    isDestroyed: () => false,
    webContents: { id: 1, isDestroyed: () => false, send }
  }
  const onRemindersChanged = vi.fn(() => order.push('refresh'))
  const onNotePurged = vi.fn(() => order.push('sticky-cleanup'))
  const runMutation = vi.fn((operation) => operation())
  registerBusinessIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getMainWindow: () => window,
    onRemindersChanged,
    onNotePurged,
    runMutation
  })
  return {
    order,
    send,
    onRemindersChanged,
    onNotePurged,
    runMutation,
    invoke: (channel, id = 42) => handlers.get(channel)({ sender: window.webContents }, { id }),
    unauthorized: (channel) => handlers.get(channel)({ sender: {} }, { id: 42 })
  }
}

const removals = [
  { channel: 'notes:delete', reason: 'deletion', command: 'deleteNote' },
  { channel: 'notes:purge', reason: 'purge', command: 'purgeNoteAndFiles' }
]

beforeEach(() => {
  vi.resetAllMocks()
  store.getNoteById.mockReturnValue({ id: 42, attachments: [] })
})

describe('note removal reminder reconciliation through the registered IPC handlers', () => {
  it.each(removals)(
    '$channel refreshes reminders immediately after a successful commit',
    async (row) => {
      const f = fixture()
      store[row.command].mockImplementation(() => {
        f.order.push('commit')
        return true
      })

      expect(await f.invoke(row.channel)).toBe(true)

      expect(store[row.command]).toHaveBeenCalledWith(42)
      expect(f.onRemindersChanged).toHaveBeenCalledTimes(1)
      expect(f.send).toHaveBeenCalledExactlyOnceWith('notes:changed', {
        reason: row.reason,
        id: 42
      })
      expect(f.order).toEqual(
        row.channel === 'notes:purge'
          ? ['commit', 'sticky-cleanup', 'refresh', 'broadcast']
          : ['commit', 'refresh', 'broadcast']
      )
      expect(f.onNotePurged).toHaveBeenCalledTimes(row.channel === 'notes:purge' ? 1 : 0)
      expect(f.runMutation).toHaveBeenCalledTimes(1)
    }
  )

  it.each(removals)('$channel keeps an unsuccessful removal silent', async (row) => {
    const f = fixture()
    store[row.command].mockReturnValue(false)

    expect(await f.invoke(row.channel)).toBe(false)

    expect(f.onRemindersChanged).not.toHaveBeenCalled()
    expect(f.onNotePurged).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(removals)(
    '$channel preserves a storage failure without broadcasting success',
    async (row) => {
      const f = fixture()
      const failure = new Error('storage failed')
      store[row.command].mockImplementation(() => {
        throw failure
      })

      await expect(Promise.resolve().then(() => f.invoke(row.channel))).rejects.toBe(failure)

      expect(f.onRemindersChanged).not.toHaveBeenCalled()
      expect(f.onNotePurged).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
    }
  )

  it.each(removals)(
    '$channel preserves the committed result if reminder presentation fails',
    async (row) => {
      const f = fixture()
      const failure = new Error('presentation failed')
      store[row.command].mockReturnValue(true)
      f.onRemindersChanged.mockImplementation(() => {
        throw failure
      })
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await f.invoke(row.channel)).toBe(true)
        expect(f.send).toHaveBeenCalledExactlyOnceWith('notes:changed', {
          reason: row.reason,
          id: 42
        })
        expect(log).toHaveBeenCalledWith('[reminders] refresh failed', failure)
      } finally {
        log.mockRestore()
      }
    }
  )

  it.each(removals)('$channel still rejects a foreign renderer before mutation', (row) => {
    const f = fixture()

    expect(() => f.unauthorized(row.channel)).toThrow('无权访问便签业务数据')

    expect(store[row.command]).not.toHaveBeenCalled()
    expect(f.onRemindersChanged).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('waits for permanent removal and retains normalized sticky cleanup before reconciliation', async () => {
    const f = fixture()
    let finish
    store.purgeNoteAndFiles.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    const result = f.invoke('notes:purge', '42')
    expect(store.purgeNoteAndFiles).toHaveBeenCalledWith(42)
    expect(f.order).toEqual([])
    finish(true)

    expect(await result).toBe(true)
    expect(f.onNotePurged).toHaveBeenCalledExactlyOnceWith(42)
    expect(f.order).toEqual(['sticky-cleanup', 'refresh', 'broadcast'])
  })
})
