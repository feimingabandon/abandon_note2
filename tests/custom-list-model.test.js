import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNoteListQuerySession } from '../src/renderer/src/composables/useNoteListQuerySession.js'
import { useCustomListModel } from '../src/renderer/src/composables/useCustomListModel.js'
afterEach(() => vi.restoreAllMocks())

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const notes = (offset, count) =>
  Array.from({ length: count }, (_, index) => ({
    id: offset + index,
    sort_order: (offset + index) * 10,
    is_pinned: 0
  }))
function fixture({ total = 80 } = {}) {
  const filters = { statuses: ['in_progress'], tagIds: [3] }
  const session = useNoteListQuerySession({ getFilters: () => filters })
  const api = {
    queryCustomPinned: vi.fn(async () => [{ id: 1, is_pinned: 1, sort_order: 1 }]),
    queryCustomNormal: vi.fn(async ({ limit, offset }) => ({
      total,
      notes: notes(10 + offset, Math.max(0, Math.min(limit, 100, total - offset)))
    })),
    countActiveNotes: vi.fn(async () => total + 1),
    updateCustomSortOrders: vi.fn(async () => {})
  }
  const presentation = {
    captureAnchor: vi.fn(() => ({})),
    restoreAnchor: vi.fn(async () => {}),
    captureLayout: vi.fn(() => new Map()),
    animatePage: vi.fn(async () => {})
  }
  return {
    session,
    api,
    filters,
    presentation,
    model: useCustomListModel({ session, api, presentation })
  }
}
async function loadNormalRange(model) {
  await model.load()
  for (let page = 0; page < 6; page++) await model.loadMore()
  expect(model.customList.value).toHaveLength(121)
}
describe('custom list independent paging and sorting', () => {
  it('retains active filters and loaded normal range on an anchored refresh', async () => {
    const { model, api, presentation } = fixture()
    await model.load()
    expect(model.customNormalTotal.value).toBe(80)
    await model.loadMore()
    await model.loadMore()
    expect(model.customList.value).toHaveLength(41)
    expect(model.customNormalTotal.value).toBe(80)
    api.queryCustomNormal.mockClear()
    await model.load({ showLoading: false, preserveAnchor: true })
    expect(api.queryCustomNormal).toHaveBeenCalledWith({
      statuses: ['in_progress'],
      tagIds: [3],
      limit: 40,
      offset: 0
    })
    expect(model.customList.value).toHaveLength(41)
    expect(model.customNormalTotal.value).toBe(80)
    expect(presentation.restoreAnchor).toHaveBeenCalled()
  })
  it('collects a loaded range over the database page cap before committing its refreshed snapshot', async () => {
    const { model, api, session, presentation } = fixture({ total: 200 })
    await loadNormalRange(model)
    const previous = model.customList.value
    const secondPage = deferred()
    api.queryCustomNormal.mockClear()
    api.queryCustomNormal
      .mockResolvedValueOnce({ total: 200, notes: notes(1000, 100) })
      .mockImplementationOnce(() => secondPage.promise)
    api.countActiveNotes.mockResolvedValueOnce(250)
    presentation.restoreAnchor.mockClear()
    const refresh = model.load({ showLoading: false, preserveAnchor: true })
    await vi.waitFor(() => expect(api.queryCustomNormal).toHaveBeenCalledTimes(2))
    expect(model.customList.value).toBe(previous)
    expect(model.customNormalTotal.value).toBe(200)
    expect(session.allNoteTotal.value).toBe(201)
    expect(presentation.restoreAnchor).not.toHaveBeenCalled()
    secondPage.resolve({ total: 200, notes: notes(1100, 20) })
    expect((await refresh).status).toBe('success')
    expect(api.queryCustomNormal.mock.calls.map(([query]) => query)).toEqual([
      { statuses: ['in_progress'], tagIds: [3], limit: 100, offset: 0 },
      { statuses: ['in_progress'], tagIds: [3], limit: 20, offset: 100 }
    ])
    expect(model.customList.value).toHaveLength(121)
    expect(model.customList.value.at(-1).id).toBe(1119)
    expect(model.customNormalTotal.value).toBe(200)
    expect(model.customNormalHasMore.value).toBe(true)
    expect(session.allNoteTotal.value).toBe(250)
    expect(presentation.restoreAnchor).toHaveBeenCalledTimes(1)
  })
  it('keeps the entire prior snapshot if a later refresh page fails', async () => {
    const { model, api, session, presentation } = fixture({ total: 200 })
    await loadNormalRange(model)
    const previous = model.customList.value
    api.queryCustomNormal.mockClear()
    api.queryCustomNormal
      .mockResolvedValueOnce({ total: 200, notes: notes(1000, 100) })
      .mockRejectedValueOnce(new Error('second refresh page failed'))
    api.countActiveNotes.mockResolvedValueOnce(250)
    presentation.restoreAnchor.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await model.load({ showLoading: false, preserveAnchor: true })).status).toBe('error')
    expect(model.customList.value).toBe(previous)
    expect(model.customNormalTotal.value).toBe(200)
    expect(session.allNoteTotal.value).toBe(201)
    expect(session.loadError.value).toBe(null)
    expect(presentation.restoreAnchor).not.toHaveBeenCalled()
  })
  it.each(['new refresh', 'disposal'])('discards a late refresh page after %s', async (action) => {
    const { model, api, session, presentation } = fixture({ total: 200 })
    await loadNormalRange(model)
    const secondPage = deferred()
    api.queryCustomNormal.mockClear()
    api.queryCustomNormal
      .mockResolvedValueOnce({ total: 200, notes: notes(1000, 100) })
      .mockImplementationOnce(() => secondPage.promise)
    const old = model.load({ showLoading: false, preserveAnchor: true })
    await vi.waitFor(() => expect(api.queryCustomNormal).toHaveBeenCalledTimes(2))
    if (action === 'new refresh') await model.load()
    else session.dispose()
    const current = model.customList.value
    const refreshedAt = session.lastRefreshedAt.value
    presentation.restoreAnchor.mockClear()
    secondPage.resolve({ total: 200, notes: notes(1100, 20) })
    expect((await old).status).toBe('cancelled')
    expect(model.customList.value).toBe(current)
    expect(session.lastRefreshedAt.value).toBe(refreshedAt)
    expect(presentation.restoreAnchor).not.toHaveBeenCalled()
  })
  it.each([
    { total: 85, firstTotal: 85, firstCount: 85, secondCount: 0, requests: 1 },
    { total: 105, firstTotal: 200, firstCount: 100, secondCount: 5, requests: 2 },
    { total: 95, firstTotal: 200, firstCount: 100, secondCount: 0, requests: 2 }
  ])('stops collecting when the matching total shrinks to $total', async (scenario) => {
    const { model, api } = fixture({ total: 200 })
    await loadNormalRange(model)
    api.queryCustomNormal.mockClear()
    api.queryCustomNormal
      .mockResolvedValueOnce({
        total: scenario.firstTotal,
        notes: notes(1000, scenario.firstCount)
      })
      .mockResolvedValueOnce({ total: scenario.total, notes: notes(1100, scenario.secondCount) })
    expect((await model.load({ showLoading: false, preserveAnchor: true })).status).toBe('success')
    expect(api.queryCustomNormal).toHaveBeenCalledTimes(scenario.requests)
    expect(model.customList.value).toHaveLength(scenario.total + 1)
    expect(model.customNormalTotal.value).toBe(scenario.total)
    expect(model.customNormalHasMore.value).toBe(false)
  })
  it('stops on an empty later page even if a changing database still reports more matches', async () => {
    const { model, api } = fixture({ total: 200 })
    await loadNormalRange(model)
    api.queryCustomNormal.mockClear()
    api.queryCustomNormal
      .mockResolvedValueOnce({ total: 200, notes: notes(1000, 100) })
      .mockResolvedValueOnce({ total: 200, notes: [] })
    expect((await model.load({ showLoading: false, preserveAnchor: true })).status).toBe('success')
    expect(api.queryCustomNormal).toHaveBeenCalledTimes(2)
    expect(model.customList.value).toHaveLength(101)
    expect(model.customNormalTotal.value).toBe(200)
    expect(model.customNormalHasMore.value).toBe(true)
  })
  it('rejects a child response and its finally after a newer full load and page', async () => {
    const { model, api } = fixture()
    await model.load()
    const oldPage = deferred(),
      newPage = deferred()
    api.queryCustomNormal.mockImplementationOnce(() => oldPage.promise)
    const old = model.loadMore()
    await model.load()
    api.queryCustomNormal.mockImplementationOnce(() => newPage.promise)
    const fresh = model.loadMore()
    oldPage.resolve({ total: 80, notes: [{ id: 999 }] })
    await old
    expect(model.customList.value.map((note) => note.id)).not.toContain(999)
    expect(model.customNormalLoading.value).toBe(true)
    newPage.resolve({ total: 80, notes: notes(20, 10) })
    await fresh
    expect(model.customNormalLoading.value).toBe(false)
  })
  it('assigns existing slots to reordered normal cards without crossing the pinned zone', async () => {
    const { model, api } = fixture()
    await model.load()
    const normal = model.customList.value.filter((note) => !note.is_pinned)
    const originalSlots = normal.map((note) => note.sort_order)
    await model.reorderZone(false, [...normal].reverse())
    expect(model.customList.value[0].id).toBe(1)
    const reordered = model.customList.value.slice(1)
    expect(reordered.map((note) => note.id)).toEqual([...normal].reverse().map((note) => note.id))
    expect(reordered.map((note) => note.sort_order)).toEqual(originalSlots)
    expect(api.updateCustomSortOrders).toHaveBeenCalledWith(
      reordered.map((note) => ({ id: note.id, sortOrder: note.sort_order }))
    )
  })
  it('restores database order after a persistence error and preserves snapshot on query failure', async () => {
    const { model, api, session } = fixture()
    await model.load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.updateCustomSortOrders.mockRejectedValueOnce(new Error('write failed'))
    await model.reorderZone(false, [...model.customList.value.slice(1)].reverse())
    expect(model.customList.value[1].id).toBe(10)
    const previous = model.customList.value
    api.queryCustomPinned.mockRejectedValueOnce(new Error('read failed'))
    expect((await model.load()).status).toBe('error')
    expect(model.customList.value).toBe(previous)
    expect(session.loadError.value).toBe('列表加载失败')
    vi.restoreAllMocks()
  })
  it('invalidates pending paging on mode changes and disposal', async () => {
    const { model, api, session } = fixture()
    await model.load()
    const pending = deferred()
    api.queryCustomNormal.mockImplementationOnce(() => pending.promise)
    const more = model.loadMore()
    session.begin()
    pending.resolve({ total: 80, notes: [{ id: 999 }] })
    await more
    expect(model.customList.value).toHaveLength(11)
    const full = deferred()
    api.queryCustomPinned.mockImplementationOnce(() => full.promise)
    const load = model.load()
    session.dispose()
    full.resolve([])
    expect((await load).status).toBe('cancelled')
    expect(model.customList.value).toHaveLength(11)
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
  it.each([true, false])(
    'blocks old-offset paging until a quiet refresh finishes (preserveAnchor=%s)',
    async (preserveAnchor) => {
      const { model, api } = fixture({ total: 200 })
      await model.load()
      await model.loadMore()
      await model.loadMore()
      const response = deferred()
      api.queryCustomNormal.mockClear()
      api.queryCustomNormal.mockImplementationOnce(() => response.promise)
      const refresh = model.load({ showLoading: false, preserveAnchor })
      await model.loadMore()
      expect(api.queryCustomNormal).toHaveBeenCalledTimes(1)
      response.resolve({ total: 200, notes: notes(10, preserveAnchor ? 40 : 20) })
      await refresh
      await model.loadMore()
      const normal = model.customList.value.filter((note) => !note.is_pinned)
      expect(normal.map((note) => note.id)).toEqual(
        notes(10, preserveAnchor ? 60 : 40).map((note) => note.id)
      )
      expect(new Set(normal.map((note) => note.id)).size).toBe(normal.length)
      expect(api.queryCustomNormal.mock.calls.at(-1)[0].offset).toBe(preserveAnchor ? 40 : 20)
    }
  )
  it('keeps the paging gate through anchor restoration and does not unlock a newer refresh from old finally', async () => {
    const { model, api, presentation } = fixture()
    await model.load()
    const anchor = deferred(),
      nextResponse = deferred()
    presentation.restoreAnchor.mockImplementationOnce(() => anchor.promise)
    const old = model.load({ showLoading: false, preserveAnchor: true })
    await vi.waitFor(() => expect(presentation.restoreAnchor).toHaveBeenCalledTimes(2))
    api.queryCustomNormal.mockClear()
    await model.loadMore()
    expect(api.queryCustomNormal).not.toHaveBeenCalled()
    api.queryCustomNormal.mockImplementationOnce(() => nextResponse.promise)
    const fresh = model.load({ showLoading: false, preserveAnchor: true })
    anchor.resolve()
    expect((await old).status).toBe('cancelled')
    await model.loadMore()
    expect(api.queryCustomNormal).toHaveBeenCalledTimes(1)
    nextResponse.resolve({ total: 80, notes: notes(10, 10) })
    await fresh
    await model.loadMore()
    expect(api.queryCustomNormal).toHaveBeenCalledTimes(2)
  })
  it('captures the latest user reading position after collecting the refresh and before committing', async () => {
    const { model, api, presentation } = fixture()
    await model.load()
    const response = deferred()
    let scrollTop = 400
    presentation.captureAnchor.mockImplementation(() => ({ scrollTop }))
    presentation.restoreAnchor.mockImplementation(async (anchor) => {
      scrollTop = anchor.scrollTop
    })
    api.queryCustomNormal.mockImplementationOnce(() => response.promise)
    const refresh = model.load({ showLoading: false, preserveAnchor: true })
    scrollTop = 600
    response.resolve({ total: 80, notes: notes(10, 10) })
    await refresh
    expect(scrollTop).toBe(600)
    expect(presentation.captureAnchor).toHaveBeenCalledTimes(1)
  })
  it('does not admit full loads or scroll pages after disposal', async () => {
    const { model, api, session } = fixture()
    await model.load()
    session.dispose()
    api.queryCustomNormal.mockClear()
    api.queryCustomPinned.mockClear()
    await model.loadMore()
    expect((await model.load()).status).toBe('cancelled')
    expect(api.queryCustomNormal).not.toHaveBeenCalled()
    expect(api.queryCustomPinned).not.toHaveBeenCalled()
  })
})
