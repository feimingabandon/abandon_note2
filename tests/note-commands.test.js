import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  note: null,
  ownedRows: [],
  transaction: vi.fn((body) => () => body()),
  run: vi.fn(() => ({ changes: 1 })),
  createNote: vi.fn(),
  stageImage: vi.fn(),
  commitStagedImage: vi.fn(),
  addImageRecord: vi.fn(),
  cleanupStagedImage: vi.fn(),
  deleteImageFile: vi.fn(),
  stageImageDeletion: vi.fn(),
  restoreStagedImageDeletion: vi.fn(),
  cancelLiveNoteReminders: vi.fn(),
  editPendingReminder: vi.fn()
}))
vi.mock('../src/main/db/db-connection.js', () => ({
  getDb: () => ({
    transaction: state.transaction,
    prepare: () => ({ all: () => state.ownedRows, run: state.run })
  })
}))
vi.mock('../src/main/db/db-notes.js', () => ({
  createNote: state.createNote,
  getNoteById: () => state.note,
  resolveNoteDurationUpdate: () => ({ durationKind: 'fixed_days', durationDays: 2 }),
  normalizeRequiredNoteContent: (content) => {
    if (!content.trim()) throw new Error('请输入便签内容')
    return content
  }
}))
vi.mock('../src/main/db/db-reminders.js', () => ({
  editPendingReminder: state.editPendingReminder,
  cancelLiveNoteReminders: state.cancelLiveNoteReminders
}))
vi.mock('../src/main/db/db-images.js', () => ({
  stageImage: state.stageImage,
  commitStagedImage: state.commitStagedImage,
  addImageRecord: state.addImageRecord,
  cleanupStagedImage: state.cleanupStagedImage,
  deleteImageFile: state.deleteImageFile,
  stageImageDeletion: state.stageImageDeletion,
  restoreStagedImageDeletion: state.restoreStagedImageDeletion
}))

import {
  createNoteWithAssets,
  normalizeNoteCreateOptions,
  saveNoteDraft
} from '../src/main/notes/note-commands.js'

const image = { base64: 'aW1hZ2U=', ext: 'png' }
const staged = { pendingPath: 'controlled-pending', fileName: 'image.png' }
beforeEach(() => {
  vi.resetAllMocks()
  state.transaction.mockImplementation((body) => () => body())
  state.run.mockReturnValue({ changes: 1 })
  state.note = {
    id: 1,
    content: 'original',
    remark: 'original remark',
    editVersion: 'original-version',
    status: 'in_progress',
    effective_at: Date.now() - 1000,
    finished_at: Date.now(),
    notify_enabled: 0,
    reminder_channels: 0,
    duration_kind: 'fixed_days',
    duration_days: 2,
    attachments: [{ id: 1, file_path: 'original.png' }],
    tags: []
  }
  state.ownedRows = [{ id: 1, file_path: 'original.png' }]
  state.createNote.mockReturnValue(state.note)
  state.stageImage.mockResolvedValue(staged)
  state.commitStagedImage.mockReturnValue({ relativePath: 'controlled-committed.png', fileSize: 5 })
  state.cleanupStagedImage.mockResolvedValue()
  state.deleteImageFile.mockResolvedValue(true)
  state.stageImageDeletion.mockReturnValue({
    pendingPath: 'controlled-deletion',
    originalPath: 'original.png'
  })
})
const draft = (patch = {}) => ({
  id: 1,
  expectedVersion: 'original-version',
  fields: { content: 'changed', status: 'in_progress', isPinned: false },
  tagIds: [],
  addedImages: [image],
  deletedImageIds: [1],
  ...patch
})

describe('complete note command coordination with controlled dependency fixtures', () => {
  it.each(['create', 'draft'])(
    'preserves the failed %s addition recovery manifest when final unlink fails',
    async (kind) => {
      const sqlError = new Error('original attachment SQL failure')
      state.addImageRecord.mockImplementationOnce(() => {
        throw sqlError
      })
      state.deleteImageFile.mockResolvedValueOnce(false)
      const operation =
        kind === 'create'
          ? createNoteWithAssets({ options: { content: 'new' }, images: [image], tagIds: [] })
          : saveNoteDraft(draft())
      await expect(operation).rejects.toBe(sqlError)
      expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).not.toContain(staged)
      if (kind === 'draft') expect(state.restoreStagedImageDeletion).toHaveBeenCalledOnce()
    }
  )

  it('waits every final compensation, preserves each failed manifest, and restores old draft deletions after cleanup errors', async () => {
    const first = { ...staged, operationDirectory: 'op-first' }
    const second = { ...staged, operationDirectory: 'op-second' }
    state.stageImage.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    state.commitStagedImage
      .mockReturnValueOnce({ relativePath: 'first.png', fileSize: 5 })
      .mockReturnValueOnce({ relativePath: 'second.png', fileSize: 5 })
    const sqlError = new Error('original second INSERT failure')
    state.addImageRecord
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw sqlError
      })
    let finishFirst
    state.deleteImageFile
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve
        })
      )
      .mockRejectedValueOnce(new Error('second unlink failed'))
    state.cleanupStagedImage.mockRejectedValueOnce(new Error('first staging cleanup failed'))
    let completed = false
    const outcome = saveNoteDraft(draft({ addedImages: [image, image] })).catch((error) => error)
    outcome.then(() => {
      completed = true
    })
    try {
      for (let index = 0; index < 20; index++) await Promise.resolve()
      expect(completed).toBe(false)
      finishFirst(true)
      expect(await outcome).toBe(sqlError)
      expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).toEqual([first])
      expect(state.restoreStagedImageDeletion).toHaveBeenCalledOnce()
    } finally {
      finishFirst(true)
      await outcome
    }
  })

  it('retains the original staging error and drains all unpublished cleanup even when one rejects', async () => {
    const second = { ...staged, operationDirectory: 'op-second' }
    const stageError = new Error('third stage failed')
    state.stageImage
      .mockResolvedValueOnce(staged)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(stageError)
    let completeCleanup
    state.cleanupStagedImage
      .mockRejectedValueOnce(new Error('first cleanup failed'))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          completeCleanup = resolve
        })
      )
    let completed = false
    const outcome = createNoteWithAssets({
      options: { content: 'new' },
      images: [image, image, image],
      tagIds: []
    }).catch((error) => error)
    outcome.then(() => {
      completed = true
    })
    try {
      for (let index = 0; index < 20; index++) await Promise.resolve()
      expect(completed).toBe(false)
      completeCleanup()
      expect(await outcome).toBe(stageError)
      expect(state.cleanupStagedImage).toHaveBeenCalledTimes(2)
    } finally {
      completeCleanup()
      await outcome
    }
  })

  it('cleans already staged additions when a later addition cannot stage, before starting SQL', async () => {
    state.stageImage.mockResolvedValueOnce(staged).mockRejectedValueOnce(new Error('stage failure'))
    await expect(
      createNoteWithAssets({ options: { content: 'new' }, images: [image, image], tagIds: [] })
    ).rejects.toThrow('stage failure')
    expect(state.transaction).not.toHaveBeenCalled()
    expect(state.createNote).not.toHaveBeenCalled()
    expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).toEqual([staged])
  })

  it('compensates committed files when a later SQL attachment write fails', async () => {
    state.addImageRecord.mockImplementationOnce(() => {
      throw new Error('record failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        createNoteWithAssets({ options: { content: 'new' }, images: [image], tagIds: [] })
      ).rejects.toThrow('record failure')
      expect(state.deleteImageFile.mock.calls.map(([file]) => file)).toEqual([
        'controlled-committed.png'
      ])
      expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).toContain(staged)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('rejects a deletion not owned by this note without staging resources', async () => {
    state.ownedRows = []
    await expect(saveNoteDraft(draft())).rejects.toThrow('附件不存在或不属于当前便签')
    expect(state.stageImage).not.toHaveBeenCalled()
    expect(state.transaction).not.toHaveBeenCalled()
  })

  it('rechecks the complete version after asynchronous staging and restores pending deletion on conflict', async () => {
    state.stageImage.mockImplementationOnce(async () => {
      state.note = { ...state.note, content: 'other writer', editVersion: 'new-version' }
      return staged
    })
    await expect(saveNoteDraft(draft())).rejects.toThrow('便签已发生变化')
    expect(state.run).not.toHaveBeenCalled()
    expect(state.commitStagedImage).not.toHaveBeenCalled()
    expect(state.restoreStagedImageDeletion).toHaveBeenCalledExactlyOnceWith({
      pendingPath: 'controlled-deletion',
      originalPath: 'original.png'
    })
    expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).toContain(staged)
    expect(state.note.content).toBe('other writer')
  })

  it("preserves another writer's remark when it changes during attachment staging", async () => {
    state.stageImage.mockImplementationOnce(async () => {
      state.note = { ...state.note, remark: 'other writer remark', editVersion: 'remark-version' }
      return staged
    })
    await expect(
      saveNoteDraft(draft({ fields: { content: 'changed', remark: 'draft remark' } }))
    ).rejects.toThrow('便签已发生变化')
    expect(state.run).not.toHaveBeenCalled()
    expect(state.commitStagedImage).not.toHaveBeenCalled()
    expect(state.restoreStagedImageDeletion).toHaveBeenCalledOnce()
    expect(state.cleanupStagedImage.mock.calls.map(([item]) => item)).toContain(staged)
    expect(state.note.remark).toBe('other writer remark')
  })

  it('restores old files and removes newly committed files when draft resource SQL fails', async () => {
    state.addImageRecord.mockImplementationOnce(() => {
      throw new Error('draft record failure')
    })
    await expect(saveNoteDraft(draft())).rejects.toThrow('draft record failure')
    expect(state.deleteImageFile.mock.calls.map(([file]) => file)).toEqual([
      'controlled-committed.png'
    ])
    expect(state.restoreStagedImageDeletion).toHaveBeenCalledExactlyOnceWith({
      pendingPath: 'controlled-deletion',
      originalPath: 'original.png'
    })
  })

  it('supports image-only creation and explicit completion in the same draft save', async () => {
    await createNoteWithAssets({
      options: { content: '', remark: 'image-only remark' },
      images: [image],
      tagIds: []
    })
    expect(state.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ content: '', remark: 'image-only remark' }),
      { allowEmptyContent: true }
    )
    await saveNoteDraft(draft({ fields: { content: 'changed', status: 'completed' } }))
    expect(
      state.run.mock.calls.some((args) => args[0] === 'changed' && args[2] === 'completed')
    ).toBe(true)
    expect(state.cancelLiveNoteReminders).toHaveBeenCalledWith(1, expect.any(Number))
  })

  it('preserves immediate time intentions until the creation commit', () => {
    expect(
      normalizeNoteCreateOptions({
        content: '立即已完成',
        effectiveAt: null,
        status: 'completed',
        finishedAt: 'now'
      })
    ).toMatchObject({ effectiveAt: null, status: 'completed', finishedAt: 'now' })
  })

  it('cancels the old live round when rescheduling to future with reminders enabled', async () => {
    state.note.reminder_channels = 1
    await saveNoteDraft(
      draft({
        fields: {
          content: 'changed',
          status: 'initialized',
          effectiveAt: Date.now() + 600_000,
          reminderChannels: 1,
          pendingReminder: { id: 'obsolete', expectedDueAt: 1, dueAt: 2 }
        }
      })
    )
    expect(state.cancelLiveNoteReminders).toHaveBeenCalledWith(1, expect.any(Number))
    expect(state.editPendingReminder).not.toHaveBeenCalled()
    expect(
      state.run.mock.calls.some((args) => args[0] === 'changed' && args[2] === 'initialized')
    ).toBe(true)
  })

  it('preserves a follow-up round when correcting an in-progress historical time', async () => {
    state.note.reminder_channels = 1
    const pendingReminder = { id: 'current', expectedDueAt: 1, dueAt: Date.now() + 600_000 }
    await saveNoteDraft(
      draft({
        fields: {
          content: 'changed',
          status: 'in_progress',
          effectiveAt: Date.now() - 86_400_000,
          reminderChannels: 1,
          pendingReminder
        }
      })
    )
    expect(state.cancelLiveNoteReminders).not.toHaveBeenCalled()
    expect(state.editPendingReminder).toHaveBeenCalledWith(1, pendingReminder, expect.any(Number))
  })

  it('rejects an impossible future completed state without writing SQL', async () => {
    await expect(
      saveNoteDraft(
        draft({
          fields: { content: 'changed', status: 'completed', effectiveAt: Date.now() + 600_000 }
        })
      )
    ).rejects.toThrow()
    expect(state.run).not.toHaveBeenCalled()
    expect(state.cancelLiveNoteReminders).not.toHaveBeenCalled()
  })
})
