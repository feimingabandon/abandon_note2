import { describe, expect, it, vi } from 'vitest'
import { useNoteListQuerySession } from '../src/renderer/src/composables/useNoteListQuerySession.js'
import { useTagGroupListModel } from '../src/renderer/src/composables/useTagGroupListModel.js'
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const notes = (offset, count, tag = 1) =>
  Array.from({ length: count }, (_, i) => ({
    id: offset + i,
    tags: [{ id: tag }],
    attachment_count: 2,
    has_text: true
  }))
function fixture() {
  const session = useNoteListQuerySession({ getFilters: () => ({ statuses: [], tagIds: [] }) })
  const api = {
    queryTagGroups: vi.fn(async () => [
      { key: 'tag:1', id: 1, name: 'one', total: 150 },
      { key: 'tag:2', id: 2, name: 'two', total: 12 },
      { key: 'untagged', id: null, name: 'untagged', total: 0, untagged: true }
    ]),
    queryTagGroupNotes: vi.fn(async ({ offset, limit, tagId }) => ({
      total: tagId === 1 ? 150 : 12,
      notes: notes(10 + offset, Math.min(limit, (tagId === 1 ? 150 : 12) - offset), tagId)
    })),
    countActiveNotes: vi.fn(async () => 162)
  }
  const presentation = {
    captureAnchor: vi.fn(() => ({})),
    captureLayout: vi.fn(() => new Map()),
    restoreAnchor: vi.fn(async () => {}),
    animatePage: vi.fn(async () => {})
  }
  const model = useTagGroupListModel({ session, api, presentation })
  return { session, api, model, presentation }
}
async function ticks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
describe('tag group snapshot and latest expansion ownership', () => {
  it('accepts readonly UI group handles and restores more than100 loaded notes atomically', async () => {
    const { model, api } = fixture()
    await model.load()
    await model.toggleGroup(model.tagGroups.value[0])
    for (let i = 0; i < 6; i++) await model.loadPage(model.tagGroups.value[0])
    expect(model.tagGroups.value[0].notes).toHaveLength(130)
    api.queryTagGroupNotes.mockClear()
    const slow = deferred()
    api.queryTagGroupNotes.mockImplementationOnce(() => slow.promise)
    const refreshing = model.load({ showLoading: false, preserveAnchor: true })
    await ticks()
    expect(model.tagGroups.value[0].notes).toHaveLength(130)
    slow.resolve({ total: 150, notes: notes(10, 100) })
    await refreshing
    expect(model.tagGroups.value[0].notes).toHaveLength(130)
    expect(api.queryTagGroupNotes.mock.calls.map(([arg]) => arg.limit)).toEqual([100, 30])
  })
  it('absorbs latest expansion and collapse while overview/page requests are pending', async () => {
    const { model, api } = fixture()
    await model.load()
    await model.toggleGroup(model.tagGroups.value[0])
    const overview = deferred()
    api.queryTagGroups.mockImplementationOnce(() => overview.promise)
    const refreshing = model.load({ showLoading: false, preserveAnchor: true })
    await model.toggleGroup(model.tagGroups.value[0])
    await model.toggleGroup(model.tagGroups.value[1])
    overview.resolve([
      { key: 'tag:1', id: 1, name: 'one', total: 150 },
      { key: 'tag:2', id: 2, name: 'two', total: 12 }
    ])
    await refreshing
    expect(model.tagGroups.value[0].expanded).toBe(false)
    expect(model.tagGroups.value[1].expanded).toBe(true)
    expect(model.tagGroups.value[1].notes).toHaveLength(10)
  })
  it('carries requested count into refresh and rejects late child results', async () => {
    const { model, api } = fixture()
    await model.load()
    await model.toggleGroup(model.tagGroups.value[0])
    const slow = deferred()
    api.queryTagGroupNotes.mockImplementationOnce(() => slow.promise)
    const old = model.loadPage(model.tagGroups.value[0])
    await model.load({ showLoading: false, preserveAnchor: true })
    expect(model.tagGroups.value[0].notes).toHaveLength(30)
    slow.resolve({ total: 150, notes: [{ id: 999 }] })
    expect((await old).status).toBe('cancelled')
    expect(model.tagGroups.value[0].notes.map((n) => n.id)).not.toContain(999)
    expect(model.tagGroups.value[0].loading).toBe(false)
  })
  it('keeps the complete old snapshot when one expanded group query fails', async () => {
    const { model, api, session } = fixture()
    await model.load()
    await model.toggleGroup(model.tagGroups.value[0])
    const previous = model.tagGroups.value
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.queryTagGroupNotes.mockRejectedValueOnce(new Error('partial failure'))
    expect((await model.load({ showLoading: false, preserveAnchor: true })).status).toBe('error')
    expect(model.tagGroups.value).toBe(previous)
    expect(session.loadError.value).toBeNull()
    vi.restoreAllMocks()
  })
  it('reorders by explicit setter, keeps untagged last and patches only same-group notes preserving summaries', async () => {
    const { model } = fixture()
    await model.load()
    await model.toggleGroup(model.tagGroups.value[0])
    model.replaceGroups([...model.tagGroups.value].reverse())
    expect(model.orderedTagIds()).toEqual([2, 1])
    expect(model.tagGroups.value.at(-1).untagged).toBe(true)
    expect(model.patchNote({ id: 10, status: 'completed', tags: [{ id: 2 }] })).toBe(false)
    expect(model.patchNote({ id: 10, status: 'completed', tags: [{ id: 1 }] })).toBe(true)
    const group = model.tagGroups.value.find((g) => g.id === 1)
    expect(group.notes[0]).toMatchObject({
      id: 10,
      status: 'completed',
      attachment_count: 2,
      has_text: true
    })
    await model.toggleGroup(group)
    expect(group.expanded).toBe(false)
  })
  it('cancels complete snapshots on dispose and isolates the next model', async () => {
    const { model, api, session } = fixture()
    const slow = deferred()
    api.queryTagGroups.mockImplementationOnce(() => slow.promise)
    const old = model.load()
    session.dispose()
    const fresh = fixture()
    await fresh.model.load()
    slow.resolve([{ key: 'tag:99', id: 99, total: 1 }])
    expect((await old).status).toBe('cancelled')
    expect(model.tagGroups.value).toEqual([])
    expect(fresh.model.tagGroups.value).toHaveLength(3)
  })
})
