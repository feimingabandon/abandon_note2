import { beforeEach, describe, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({
  bindTag: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getNoteTags: vi.fn(),
  setNoteTagIds: vi.fn(),
  unbindTag: vi.fn(),
  updateTag: vi.fn(),
  updateTagOrder: vi.fn()
}))
vi.mock('../src/main/db/db-tags.js', () => repository)
import { createTagCommands } from '../src/main/tags/tag-commands.js'

beforeEach(() => vi.resetAllMocks())

function fixture() {
  const events = []
  const broadcastTagChange = vi.fn((reason, result, payload) => {
    if (result) events.push(['tags:changed', { reason, ...payload }])
    return result
  })
  const broadcastNoteChange = vi.fn((reason, result, payload) => {
    if (result) events.push(['notes:changed', { reason, ...payload }])
    return result
  })
  return {
    commands: createTagCommands({ broadcastTagChange, broadcastNoteChange }),
    events,
    broadcastTagChange,
    broadcastNoteChange
  }
}

describe('tag command owner', () => {
  it('preserves create results, including a duplicate-name null without publishing a change', () => {
    const { commands, events } = fixture()
    const tag = { id: 31, name: '  original DB input  ', color: '#ABCDEF', sort_order: 65536 }
    repository.createTag.mockReturnValueOnce(tag).mockReturnValueOnce(null)
    expect(commands.create({ name: tag.name, color: tag.color })).toBe(tag)
    expect(repository.createTag).toHaveBeenCalledExactlyOnceWith(tag.name, tag.color)
    expect(commands.create({ name: 'existing' })).toBeNull()
    expect(events).toEqual([['tags:changed', { reason: 'create', tag }]])
  })

  it('keeps rename metadata and tag-before-note publication after the DB mutation', () => {
    const { commands, events } = fixture()
    const tag = { id: 31, name: 'renamed', color: '#123456' }
    const fields = { name: tag.name, color: tag.color }
    repository.updateTag.mockImplementationOnce(() => {
      expect(events).toEqual([])
      return { tag, oldName: 'old name' }
    })
    expect(commands.update({ id: '31', fields })).toBe(tag)
    expect(repository.updateTag).toHaveBeenCalledExactlyOnceWith('31', fields)
    expect(events).toEqual([
      ['tags:changed', { reason: 'update', tag, oldName: 'old name' }],
      ['notes:changed', { reason: 'tag', tagId: 31 }]
    ])
  })

  it('publishes a real delete once in the original order and leaves missing deletes silent', () => {
    const { commands, events } = fixture()
    repository.deleteTag.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(commands.delete({ id: '31' })).toBe(true)
    expect(commands.delete({ id: '31' })).toBe(false)
    expect(repository.deleteTag.mock.calls).toEqual([['31'], ['31']])
    expect(events).toEqual([
      ['tags:changed', { reason: 'delete', id: 31 }],
      ['notes:changed', { reason: 'tag', tagId: 31 }]
    ])
  })

  it('delegates slot rules to DB and normalizes only the existing reorder notification payload', () => {
    const { commands, events } = fixture()
    const submitted = ['9', 3]
    const ordered = [{ id: 9 }, { id: 7 }, { id: 3 }]
    repository.updateTagOrder.mockReturnValueOnce(ordered)
    expect(commands.reorder({ tagIds: submitted })).toBe(ordered)
    expect(repository.updateTagOrder).toHaveBeenCalledExactlyOnceWith(submitted)
    expect(events).toEqual([['tags:changed', { reason: 'reorder', tagIds: [9, 3] }]])
  })

  it('keeps binding IDs and DB booleans while suppressing a no-change unbind notification', () => {
    const { commands, events } = fixture()
    repository.bindTag.mockReturnValueOnce(true)
    repository.unbindTag.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(commands.bind({ noteId: '17', tagId: '31' })).toBe(true)
    expect(commands.unbind({ noteId: '17', tagId: '31' })).toBe(true)
    expect(commands.unbind({ noteId: '17', tagId: '31' })).toBe(false)
    expect(repository.bindTag).toHaveBeenCalledExactlyOnceWith('17', '31')
    expect(repository.unbindTag.mock.calls).toEqual([
      ['17', '31'],
      ['17', '31']
    ])
    expect(events).toEqual([
      ['notes:changed', { reason: 'tag', id: '17', tagId: '31' }],
      ['notes:changed', { reason: 'tag', id: '17', tagId: '31' }]
    ])
  })

  it('reads the committed assignment before returning and publishing a complete set operation', () => {
    const { commands, events } = fixture()
    const calls = []
    const assigned = [{ id: 31, name: 'assigned' }]
    repository.setNoteTagIds.mockImplementationOnce((...args) => calls.push(['write', ...args]))
    repository.getNoteTags.mockImplementationOnce((noteId) => {
      calls.push(['read', noteId])
      expect(events).toEqual([])
      return assigned
    })
    expect(commands.setNoteTags({ noteId: '17', tagIds: ['31'] })).toBe(assigned)
    expect(calls).toEqual([
      ['write', '17', ['31']],
      ['read', '17']
    ])
    expect(events).toEqual([['notes:changed', { reason: 'tag', id: '17' }]])
  })

  it.each([
    ['create', 'createTag', { name: 'invalid' }],
    ['update', 'updateTag', { id: 31, fields: { name: 'duplicate' } }],
    ['delete', 'deleteTag', { id: 31 }],
    ['reorder', 'updateTagOrder', { tagIds: [31, 31] }],
    ['bind', 'bindTag', { noteId: 17, tagId: 31 }],
    ['unbind', 'unbindTag', { noteId: 17, tagId: 31 }],
    ['setNoteTags', 'setNoteTagIds', { noteId: 17, tagIds: [31, 32] }]
  ])(
    'preserves the original %s repository error before any notification',
    (command, method, payload) => {
      const { commands, events } = fixture()
      const failure = new Error('original repository failure')
      repository[method].mockImplementationOnce(() => {
        throw failure
      })
      expect(() => commands[command](payload)).toThrow(failure)
      expect(events).toEqual([])
      expect(repository.getNoteTags).not.toHaveBeenCalled()
    }
  )
})
