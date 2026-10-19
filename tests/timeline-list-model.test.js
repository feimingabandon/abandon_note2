import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNoteListQuerySession } from '../src/renderer/src/composables/useNoteListQuerySession.js'
import { useTimelineListModel } from '../src/renderer/src/composables/useTimelineListModel.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
const notes = (start, count) =>
  Array.from({ length: count }, (_, index) => ({ id: start + index, effective_at: 1 }))
function fixture() {
  const session = useNoteListQuerySession({ getFilters: () => ({ statuses: [], tagIds: [] }) })
  const api = {
    queryPinnedNotes: vi.fn(async () => [{ id: 1, effective_at: Date.now() }]),
    queryRecentNotes: vi.fn(async () => [{ id: 2, effective_at: Date.now() }]),
    queryEarlierNotes: vi.fn(async ({ limit, offset }) => ({
      total: 150,
      notes: notes(10 + offset, Math.min(limit, 150 - offset))
    })),
    countActiveNotes: vi.fn(async () => 152)
  }
  const presentation = {
    captureAnchor: vi.fn(() => ({})),
    captureLayout: vi.fn(() => new Map()),
    restoreAnchor: vi.fn(async () => {}),
    animatePage: vi.fn(async () => {})
  }
  const model = useTimelineListModel({ session, api, presentation })
  return { session, api, model, presentation }
}

describe('timeline list snapshot ownership', () => {
  it('commits midnight groups, history counts and cutoff together after a delayed refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 15, 23, 59))
    const { model, api } = fixture()
    const all = [
      { id: 1, effective_at: new Date(2026, 9, 15, 12).getTime() },
      { id: 2, effective_at: new Date(2026, 9, 13, 12).getTime() }
    ]
    const recent = ({ cutoffTime }) => all.filter((note) => note.effective_at > cutoffTime)
    api.queryPinnedNotes.mockResolvedValue([])
    api.queryRecentNotes.mockImplementation(async (options) => recent(options))
    api.queryEarlierNotes.mockImplementation(async ({ cutoffTime, limit, offset }) => {
      const history = all.filter((note) => note.effective_at <= cutoffTime)
      return { total: history.length, notes: history.slice(offset, offset + limit) }
    })
    await model.load()
    const ids = (group) =>
      model.timelineGroups.value.find((item) => item.group === group)?.items.map((note) => note.id)
    expect(ids('today')).toEqual([1])
    expect(ids('dayBefore')).toEqual([2])
    expect(model.earlierTotal.value).toBe(0)

    vi.setSystemTime(new Date(2026, 9, 16, 0, 1))
    const pending = deferred()
    api.queryRecentNotes.mockImplementationOnce(() => pending.promise)
    const loading = model.load({ showLoading: false, preserveAnchor: true })
    expect(ids('today')).toEqual([1])
    expect(ids('dayBefore')).toEqual([2])
    expect(model.earlierTotal.value).toBe(0)
    pending.resolve([all[0]])
    expect((await loading).status).toBe('success')
    expect(ids('today')).toBeUndefined()
    expect(ids('yesterday')).toEqual([1])
    expect(ids('dayBefore')).toBeUndefined()
    expect(ids('date-2026-10-13')).toEqual([2])
    expect(model.earlierTotal.value).toBe(1)
    expect(model.noteList.value.map((note) => note.id)).toEqual([1, 2])
  })

  it('keeps all loaded history over the IPC page bound and commits one complete refresh', async () => {
    const { model, api, session } = fixture()
    await model.load()
    for (let index = 0; index < 6; index++) await model.loadEarlier()
    expect(model.noteList.value).toHaveLength(132)
    api.queryEarlierNotes.mockClear()
    const page = deferred()
    api.queryEarlierNotes
      .mockImplementationOnce(async () => ({ total: 150, notes: [] }))
      .mockImplementationOnce(() => page.promise)
    const refreshing = model.load({ showLoading: false, preserveAnchor: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(model.noteList.value).toHaveLength(132)
    page.resolve({ total: 150, notes: notes(10, 100) })
    expect((await refreshing).status).toBe('success')
    expect(model.noteList.value).toHaveLength(132)
    expect(api.queryEarlierNotes.mock.calls.map(([arg]) => arg.limit)).toEqual([0, 100, 30])
    expect(session.allNoteTotal.value).toBe(152)
  })

  it('rejects a delayed child page after a newer parent snapshot', async () => {
    const { model, api } = fixture()
    await model.load()
    const oldPage = deferred()
    api.queryEarlierNotes.mockImplementationOnce(() => oldPage.promise)
    const more = model.loadEarlier()
    await model.load()
    oldPage.resolve({ total: 150, notes: [{ id: 999, effective_at: 1 }] })
    await more
    expect(model.noteList.value.map((note) => note.id)).not.toContain(999)
    expect(model.noteList.value).toHaveLength(12)
    expect(model.earlierLoading.value).toBe(false)
  })

  it('uses latest collapse/reopen intent during a full refresh', async () => {
    const { model, api } = fixture()
    await model.load()
    const oldPage = deferred()
    api.queryEarlierNotes
      .mockImplementationOnce(async () => ({ total: 150, notes: [] }))
      .mockImplementationOnce(() => oldPage.promise)
    const refresh = model.load({ preserveAnchor: true })
    await Promise.resolve()
    await Promise.resolve()
    model.collapseEarlier()
    model.clearCollapsedEarlier()
    model.toggleGroupCollapse('earlier')
    oldPage.resolve({ total: 150, notes: [{ id: 999, effective_at: 1 }] })
    await refresh
    expect(model.noteList.value.map((note) => note.id)).not.toContain(999)
    expect(model.noteList.value).toHaveLength(12)
    expect(model.collapsedGroups.value.earlier).toBe(false)
  })

  it('preserves prior cards on a failed snapshot and only shows foreground errors', async () => {
    const { model, api, session } = fixture()
    await model.load()
    const previous = model.noteList.value
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.queryPinnedNotes.mockRejectedValueOnce(new Error('query failure'))
    expect((await model.load({ showLoading: false })).status).toBe('error')
    expect(model.noteList.value).toBe(previous)
    expect(session.loadError.value).toBeNull()
    api.queryPinnedNotes.mockRejectedValueOnce(new Error('foreground failure'))
    await model.load()
    expect(session.loadError.value).toBe('列表加载失败')
    expect(session.loading.value).toBe(false)
    vi.restoreAllMocks()
  })

  it('does not let a cancelled request finish a newer loading indicator', async () => {
    const { model, api, session } = fixture()
    const first = deferred(),
      second = deferred()
    api.queryPinnedNotes
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const old = model.load(),
      fresh = model.load()
    first.resolve([])
    expect((await old).status).toBe('cancelled')
    expect(session.loading.value).toBe(true)
    second.resolve([])
    await fresh
    expect(session.loading.value).toBe(false)
  })

  it('invalidates full and child requests on disposal and keeps the next instance isolated', async () => {
    const { model, api, session } = fixture()
    const first = deferred()
    api.queryPinnedNotes.mockImplementationOnce(() => first.promise)
    const loading = model.load()
    session.dispose()
    const next = fixture()
    await next.model.load()
    first.resolve([{ id: 999 }])
    expect((await loading).status).toBe('cancelled')
    expect(model.noteList.value).toEqual([])
    expect(next.model.noteList.value).toHaveLength(12)
  })
  it('cancels completion after an anchor wait belongs to a newer mode refresh', async () => {
    const { model, session, presentation } = fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    await model.load()
    const anchor = deferred()
    presentation.restoreAnchor.mockImplementationOnce(() => anchor.promise)
    const old = model.load({ showLoading: false, preserveAnchor: true })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    session.begin({ showLoading: false })
    clock.mockReturnValue(200)
    session.markRefreshed()
    clock.mockReturnValue(300)
    anchor.resolve()
    expect((await old).status).toBe('cancelled')
    expect(session.lastRefreshedAt.value).toBe(200)
    clock.mockRestore()
  })
})
