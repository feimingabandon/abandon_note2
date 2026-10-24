import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import {
  cloneDraftMetadata,
  removePreviousDraftSessions
} from '../src/renderer/src/utils/draftAssets.js'
import {
  hashLegacyDraft,
  legacyDraftKey,
  legacyMigrationReceipt,
  LEGACY_CAPTURE_CONFLICT
} from '../src/renderer/src/utils/legacyDraftAssets.js'

const lifecycle = vi.hoisted(() => ({ mount: [], unmount: [], showMessage: vi.fn() }))
vi.mock('vue', async (original) => ({
  ...(await original()),
  onMounted: (callback) => lifecycle.mount.push(callback),
  onBeforeUnmount: (callback) => lifecycle.unmount.push(callback)
}))
vi.mock('../src/renderer/src/composables/useMessage.js', () => ({
  useMessage: () => ({ showMessage: lifecycle.showMessage })
}))

const sessionId = 'launch-session'
const prefix = `abandon:editing-draft:v3:${sessionId}:`
const asset = { assetId: 'asset', ext: 'png', name: 'image.png', size: 3, sha256: 'a'.repeat(64) }
let storage, api, useDraftProtection, editingDataGeneration, getLegacyCaptureConflict

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function storageFixture() {
  const result = {}
  Object.defineProperties(result, {
    getItem: { value: vi.fn((key) => (Object.hasOwn(result, key) ? result[key] : null)) },
    setItem: {
      value: vi.fn((key, value) => {
        result[key] = String(value)
      })
    },
    removeItem: {
      value: vi.fn((key) => {
        delete result[key]
      })
    }
  })
  return result
}
function apiFixture() {
  const owners = new Map(),
    states = new Map()
  let sequence = 0
  return {
    owners,
    states,
    openOwner: vi.fn(async (key, resume) => {
      let owner = owners.get(key)
      if (resume && resume.ownerId !== owner?.ownerId) throw new Error('invalid resume')
      if (!owner) {
        owner = { sessionId, key, ownerId: `owner-${++sequence}`, generation: 1 }
        owners.set(key, owner)
      }
      return owner
    }),
    stage: vi.fn(async () => ({ ...asset })),
    preview: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      ext: 'png',
      size: 3,
      sha256: asset.sha256
    })),
    thumbnail: vi.fn(async () => ({ data: 'data:image/png;base64,AQID', width: 100, height: 60 })),
    release: vi.fn(async () => true),
    discardOwner: vi.fn(async (owner) => {
      owners.delete(owner.key)
      return { cancelled: true, cleanupErrors: [] }
    }),
    submitNote: vi.fn(async (_owner, requestId) => {
      const receipt = { requestId, status: 'committed', result: { id: 17 } }
      states.set(requestId, receipt)
      return receipt
    }),
    noteState: vi.fn(
      async (_owner, requestId) => states.get(requestId) || { requestId, status: 'unknown' }
    ),
    waitNote: vi.fn(async (_owner, requestId) => states.get(requestId))
  }
}
function fixture(options = {}) {
  const content = ref(''),
    images = ref([]),
    working = ref(false)
  const port = useDraftProtection({
    key: 'editor',
    fields: { content },
    dirty: () => Boolean(content.value || images.value.length),
    busy: () => working.value,
    extra: () => ({ attachments: images.value }),
    ...options
  })
  const mounts = lifecycle.mount.splice(0),
    unmounts = lifecycle.unmount.splice(0)
  return {
    port,
    content,
    images,
    working,
    mount: () => Promise.all(mounts.map((callback) => callback())),
    unmount: () => unmounts.forEach((callback) => callback())
  }
}
function seed({
  key = 'editor',
  data = { content: 'retained', attachments: [asset] },
  handoff = null
} = {}) {
  const owner = { sessionId, key, ownerId: 'existing-owner', generation: 1 }
  api.owners.set(key, owner)
  storage.setItem(
    prefix + key,
    JSON.stringify({
      version: 3,
      sessionId,
      key,
      owner,
      data,
      handoff: handoff ? { submittedData: cloneDraftMetadata(data), ...handoff } : null
    })
  )
  return owner
}
async function settle() {
  for (let i = 0; i < 5; i++) await nextTick()
}
const legacyImage = { base64: 'AQID', ext: 'png', name: 'original.png', size: 3 }
function seedLegacy(key = 'new:list', data = { content: 'legacy text' }) {
  const raw = JSON.stringify({ updatedAt: 123, data })
  storage.setItem(legacyDraftKey(sessionId, key), raw)
  return raw
}
function legacyForm(options = {}) {
  const content = ref(''),
    images = ref([])
  const f = fixture({
    key: 'new:list',
    fields: { content },
    dirty: () => Boolean(content.value || images.value.length),
    extra: () => ({ attachments: { addedImages: images.value, deletedImageIds: [] } }),
    restoreExtra: (data) => {
      images.value = data.attachments?.addedImages || []
    },
    ...options
  })
  return { ...f, content, images }
}

beforeEach(async () => {
  vi.resetModules()
  lifecycle.mount = []
  lifecycle.unmount = []
  lifecycle.showMessage.mockReset()
  storage = storageFixture()
  api = apiFixture()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', {
    api: { runtimeCapabilities: { editingDraftSessionId: sessionId }, draftAssets: api }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;({ useDraftProtection, editingDataGeneration, getLegacyCaptureConflict } =
    await import('../src/renderer/src/composables/useDraftProtection.js'))
})
afterEach(() => {
  lifecycle.unmount.splice(0).forEach((callback) => callback())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('metadata draft persistence and ownership', () => {
  it('does not allocate owners or storage for empty calendar-style drafts', async () => {
    const forms = Array.from({ length: 42 }, (_, index) => fixture({ key: `day:${index}` }))
    await Promise.all(forms.map((form) => form.mount()))
    expect(await window.__prepareEditingDrafts()).toEqual({ dirty: false, blocked: false })
    expect(api.openOwner).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    forms.forEach((form) => form.unmount())
  })

  it('awaits first dirty owner binding and preserves its final flush across immediate same-key remount', async () => {
    const first = fixture()
    await first.mount()
    const opening = deferred(),
      original = { sessionId, key: 'editor', ownerId: 'delayed-owner', generation: 1 }
    api.openOwner.mockReturnValueOnce(opening.promise)
    first.content.value = 'typed immediately before unmount'
    const preparation = window.__prepareEditingDrafts()
    let prepared = false
    void preparation.then(() => {
      prepared = true
    })
    await settle()
    expect(prepared).toBe(false)
    first.unmount()
    const replacement = fixture()
    const mounting = replacement.mount()
    api.owners.set('editor', original)
    opening.resolve(original)
    await preparation
    await mounting
    expect(replacement.content.value).toBe('typed immediately before unmount')
    expect(api.openOwner).toHaveBeenLastCalledWith('editor', original)
    replacement.unmount()
  })

  it.each(['explicit', 'global'])(
    'gives %s clear priority over a first dirty owner opening',
    async (mode) => {
      const f = fixture()
      await f.mount()
      const opening = deferred(),
        original = { sessionId, key: 'editor', ownerId: 'clear-opening', generation: 1 }
      api.openOwner.mockReturnValueOnce(opening.promise)
      f.content.value = 'must not return after clear'
      const pending = f.port.flush()
      await settle()
      const clearing = mode === 'global' ? window.__clearEditingDrafts() : f.port.clear()
      f.unmount()
      opening.resolve(original)
      await Promise.all([pending, clearing])
      expect(storage.getItem(prefix + 'editor')).toBeNull()
      if (mode === 'global') expect(api.discardOwner).not.toHaveBeenCalled()
      else expect(api.discardOwner).toHaveBeenCalledWith(original)
    }
  )

  it('lets replacement discard finish after a predecessor owner-opening flush without resurrecting text', async () => {
    const first = fixture()
    await first.mount()
    const opening = deferred(),
      original = { sessionId, key: 'editor', ownerId: 'replaced-opening', generation: 1 }
    api.openOwner.mockReturnValueOnce(opening.promise)
    first.content.value = 'obsolete predecessor'
    const oldFlush = first.port.flush()
    first.unmount()
    const replacement = fixture(),
      mounting = replacement.mount()
    const clearing = replacement.port.clear()
    api.owners.set('editor', original)
    opening.resolve(original)
    await Promise.all([oldFlush, mounting, clearing])
    expect(storage.getItem(prefix + 'editor')).toBeNull()
    expect(api.discardOwner).toHaveBeenCalledWith(original)
    replacement.unmount()
  })

  it('persists a clean owner binding so a replacement document can resume an empty form', async () => {
    const f = fixture()
    await f.mount()
    expect(api.openOwner).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    f.content.value = 'temporary'
    await f.port.flush()
    const original = api.owners.get('editor')
    f.content.value = ''
    expect(await f.port.flush()).toEqual({ dirty: false, blocked: false, persisted: true })
    expect(JSON.parse(storage.getItem(prefix + 'editor')).owner).toEqual(original)
    f.unmount()
    const next = fixture()
    await next.mount()
    expect(api.openOwner).toHaveBeenLastCalledWith('editor', original)
    expect(lifecycle.showMessage.mock.calls.some(([, message]) => message.includes('已恢复'))).toBe(
      false
    )
    next.unmount()
  })

  it('writes text metadata without restaging or previewing originals, and separates busy from persistence', async () => {
    const f = fixture()
    await f.mount()
    f.images.value = [await f.port.stageImage({ base64: 'AQID', ext: 'png' })]
    for (let i = 0; i < 4; i++) {
      f.content.value += '文字'
      await settle()
    }
    f.working.value = true
    expect(await f.port.flush()).toEqual({ dirty: true, blocked: true, persisted: true })
    const stored = JSON.parse(storage.getItem(prefix + 'editor'))
    expect(stored.data).toEqual({ content: '文字'.repeat(4), attachments: [asset] })
    expect(storage.getItem(prefix + 'editor')).not.toMatch(/base64|capability|dataUrl/)
    expect(api.stage).toHaveBeenCalledTimes(1)
    expect(api.preview).not.toHaveBeenCalled()
    expect(await window.__prepareEditingDrafts()).toEqual({ dirty: true, blocked: true })
    f.unmount()
    expect(api.discardOwner).not.toHaveBeenCalled()
  })

  it('rebinds a same-key remount before restoring images and permits preview during restoration', async () => {
    const original = seed()
    let f
    const restoreExtra = vi.fn(async (data) => {
      expect(api.openOwner).toHaveBeenCalledWith('editor', original)
      f.images.value = data.attachments
      expect((await f.port.previewAsset(asset.assetId)).bytes).toEqual(new Uint8Array([1, 2, 3]))
      expect(await f.port.thumbnailAsset(asset.assetId, 512)).toEqual({
        data: 'data:image/png;base64,AQID',
        width: 100,
        height: 60
      })
      expect((await f.port.flush()).persisted).toBe(false)
    })
    f = fixture({ restoreExtra })
    await f.mount()
    expect(f.content.value).toBe('retained')
    expect((await f.port.flush()).persisted).toBe(true)
    f.unmount()
    const next = fixture({
      restoreExtra: (data) => {
        next.images.value = data.attachments
      }
    })
    await next.mount()
    expect(next.content.value).toBe('retained')
    expect(api.discardOwner).not.toHaveBeenCalled()
    next.unmount()
  })

  it.each(['clear', 'global', 'unmount'])(
    'invalidates the same image port and rejects a late thumbnail after %s',
    async (action) => {
      seed()
      const f = fixture()
      await f.mount()
      const held = deferred()
      api.thumbnail.mockReturnValueOnce(held.promise)
      const pending = f.port.thumbnailAsset(asset.assetId)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'DRAFT_DOCUMENT_EXPIRED' })
      await settle()
      const generation = f.port.imageGeneration.value
      if (action === 'clear') await f.port.clear()
      else if (action === 'global') await window.__clearEditingDrafts()
      else f.unmount()
      expect(f.port.imageGeneration.value).toBeGreaterThan(generation)
      held.resolve({ data: 'data:image/png;base64,AQID', width: 100, height: 60 })
      await rejected
      if (action !== 'unmount') f.unmount()
    }
  )

  it.each(['legacy', 'unknown', 'restore-failed'])(
    'retains %s raw records without watcher overwrite',
    async (mode) => {
      const location =
        mode === 'legacy' ? `abandon:editing-draft:v2:${sessionId}:editor` : prefix + 'editor'
      if (mode === 'restore-failed') seed()
      else
        storage.setItem(
          location,
          mode === 'unknown'
            ? '{"version":99,"secret":"keep"}'
            : '{"data":{"image":"base64-original"}}'
        )
      const original = storage.getItem(location)
      const f = fixture({
        restoreExtra: () => {
          if (mode === 'restore-failed') throw new Error('preview unavailable')
        }
      })
      await f.mount()
      f.content.value = 'later typing'
      await settle()
      expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
      expect(storage.getItem(location)).toBe(original)
      f.unmount()
    }
  )

  it('preserves the first quota failure and blocks leaving without replacing the journal', async () => {
    seed()
    const f = fixture({
      restoreExtra: (data) => {
        f.images.value = data.attachments
      }
    })
    await f.mount()
    const raw = storage.getItem(prefix + 'editor')
    storage.setItem.mockImplementation(() => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    })
    f.content.value = 'changed'
    await settle()
    expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
    expect(storage.getItem(prefix + 'editor')).toBe(raw)
    f.unmount()
  })

  it('invalidates clear synchronously and compensates late stage against its original owner', async () => {
    const f = fixture()
    await f.mount()
    const stage = deferred(),
      cancelled = deferred()
    api.stage.mockReturnValueOnce(stage.promise)
    api.discardOwner.mockReturnValueOnce(cancelled.promise)
    const pending = f.port.stageImage({ base64: 'AQID', ext: 'png' }).catch((error) => error)
    await settle()
    const original = api.owners.get('editor')
    const clearing = f.port.clear()
    f.content.value = 'late watcher'
    await settle()
    expect((await f.port.flush()).persisted).toBe(false)
    stage.resolve(asset)
    expect((await pending).code).toBe('DRAFT_DOCUMENT_EXPIRED')
    expect(api.release).toHaveBeenCalledWith(original, ['asset'])
    cancelled.resolve({ cancelled: true, cleanupErrors: [{ code: 'CLEANUP', message: 'unlink' }] })
    await clearing
    expect(storage.getItem(prefix + 'editor')).toBeNull()
    f.unmount()
  })

  it('globally discards before remount, removes only recognized local records and leaves asset cleanup to main', async () => {
    const f = fixture()
    await f.mount()
    f.content.value = 'clear me'
    await f.port.flush()
    storage.setItem(prefix + 'unknown', '{"version":99}')
    const oldGeneration = editingDataGeneration.value
    const clearing = window.__clearEditingDrafts()
    expect(editingDataGeneration.value).toBe(oldGeneration + 1)
    f.content.value = 'cannot resurrect'
    await clearing
    await settle()
    expect(storage.getItem(prefix + 'editor')).toBeNull()
    expect(storage.getItem(prefix + 'unknown')).toBe('{"version":99}')
    expect(api.discardOwner).not.toHaveBeenCalled()
    f.unmount()
  })

  it('retains unknown raw data when global clear arrives before restoration starts', async () => {
    storage.setItem(prefix + 'editor', '{"version":99,"original":"preserve"}')
    const f = fixture()
    await window.__clearEditingDrafts()
    await f.mount()
    expect(storage.getItem(prefix + 'editor')).toBe('{"version":99,"original":"preserve"}')
    expect(api.openOwner).not.toHaveBeenCalled()
    f.unmount()
  })

  it('confirms cancellation of a saved owner when discard precedes mounted restoration', async () => {
    const original = seed()
    const f = fixture()
    await f.port.clear()
    expect(api.openOwner).toHaveBeenCalledWith('editor', original)
    expect(api.discardOwner).toHaveBeenCalledWith(original)
    expect(storage.getItem(prefix + 'editor')).toBeNull()
    await f.mount()
    f.unmount()
  })

  it('does not let an unmounted port clear the replacement form owner or journal', async () => {
    const first = fixture()
    await first.mount()
    first.content.value = 'original'
    first.unmount()
    const replacement = fixture()
    await replacement.mount()
    replacement.content.value = 'replacement'
    await replacement.port.flush()
    expect(await first.port.clear()).toBe(false)
    expect(JSON.parse(storage.getItem(prefix + 'editor')).data.content).toBe('replacement')
    expect(api.discardOwner).not.toHaveBeenCalled()
    replacement.unmount()
  })

  it('allows late picker compensation after unmount using only the captured original owner', async () => {
    const f = fixture()
    await f.mount()
    await f.port.stageImage({ base64: 'AQID', ext: 'png' })
    const original = api.owners.get('editor')
    f.unmount()
    await f.port.releaseAssets(['asset'])
    expect(api.release).toHaveBeenCalledWith(original, ['asset'])
  })

  it('forgets revoked asset associations and never borrows the resumed owner for old IDs', async () => {
    const f = fixture()
    await f.mount()
    await f.port.stageImage({ base64: 'AQID', ext: 'png' })
    await f.port.clear()
    await f.port.resume()
    await expect(f.port.releaseAssets(['asset'])).rejects.toMatchObject({
      code: 'DRAFT_DOCUMENT_EXPIRED'
    })
    expect(api.release).not.toHaveBeenCalled()
    f.unmount()
  })

  it('serializes resume behind cancellation and lets a newer clear cancel the queued resume', async () => {
    const f = fixture()
    await f.mount()
    f.content.value = 'allocate before cancel'
    await f.port.flush()
    const cancellation = deferred()
    api.discardOwner.mockReturnValueOnce(cancellation.promise)
    const clearing = f.port.clear(),
      resuming = f.port.resume()
    expect(api.openOwner).toHaveBeenCalledTimes(1)
    const newerClear = f.port.clear()
    api.owners.delete('editor')
    cancellation.resolve({ cancelled: true, cleanupErrors: [] })
    await Promise.all([clearing, newerClear])
    expect(await resuming).toBe(false)
    expect(api.openOwner).toHaveBeenCalledTimes(1)
    expect(await f.port.resume()).toBe(true)
    expect(api.openOwner).toHaveBeenCalledTimes(2)
    f.unmount()
  })
})

describe('durable note request recovery', () => {
  it('locks uncertain submissions, rejects new asset input and preserves bypass edits when the old request committed', async () => {
    const onCommitted = vi.fn(),
      f = fixture({ onCommitted, resumeAfterCommit: true })
    await f.mount()
    f.content.value = 'submitted text'
    api.submitNote.mockImplementationOnce(async (_owner, requestId) => {
      api.states.set(requestId, { requestId, status: 'committed', result: { id: 91 } })
      throw new Error('reply unavailable')
    })
    const saving = f.port.commitNote('create', { images: [] })
    expect(f.port.commitLocked.value).toBe(true)
    await expect(saving).rejects.toThrow('reply unavailable')
    expect(f.port.commitLocked.value).toBe(true)
    await expect(f.port.stageImage({ base64: 'AQID', ext: 'png' })).rejects.toMatchObject({
      code: 'DRAFT_NOTE_PENDING'
    })
    await expect(f.port.clear()).rejects.toMatchObject({ code: 'DRAFT_NOTE_PENDING' })
    // Simulate a non-UI writer bypassing inert controls; this data must survive.
    f.content.value = 'new text after the uncertain result'
    f.images.value = [{ ...asset, assetId: 'later-asset' }]
    await f.port.flush()
    const first = JSON.parse(storage.getItem(prefix + 'editor'))
    await expect(f.port.commitNote('create', {})).resolves.toEqual({ id: 91 })
    const retained = JSON.parse(storage.getItem(prefix + 'editor'))
    expect(retained.data.content).toBe('new text after the uncertain result')
    expect(retained.data.attachments[0].assetId).toBe('later-asset')
    expect(retained.handoff).toEqual(first.handoff)
    expect(retained.handoff.submittedData.content).toBe('submitted text')
    expect(api.submitNote).toHaveBeenCalledTimes(1)
    expect(api.discardOwner).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(f.port.commitLocked.value).toBe(true)
    f.unmount()
    const recoveredCallback = vi.fn(),
      replacement = fixture({ onCommitted: recoveredCallback })
    await replacement.mount()
    expect(replacement.port.commitLocked.value).toBe(true)
    expect(JSON.parse(storage.getItem(prefix + 'editor')).data).toEqual(retained.data)
    expect(recoveredCallback).not.toHaveBeenCalled()
    expect(api.submitNote).toHaveBeenCalledTimes(1)
    replacement.unmount()
  })

  it.each(['failed', 'rejected'])(
    'a query confirms %s and unlocks without submitting the query placeholder',
    async (status) => {
      const handoff = { requestId: 'uncertain', kind: 'create', payload: { images: [asset] } }
      seed({ handoff })
      const f = fixture()
      await f.mount()
      expect(f.port.commitLocked.value).toBe(true)
      api.states.set(handoff.requestId, {
        requestId: handoff.requestId,
        status,
        error: { code: 'CONFIRMED', message: 'not committed' }
      })
      await expect(f.port.commitNote('create', {})).rejects.toThrow('not committed')
      expect(f.port.commitLocked.value).toBe(false)
      expect(api.submitNote).not.toHaveBeenCalled()
      f.content.value = 'explicit new save'
      await f.port.commitNote('create', { images: [], options: { content: f.content.value } })
      expect(api.submitNote).toHaveBeenCalledTimes(1)
      expect(api.submitNote.mock.calls[0][1]).not.toBe(handoff.requestId)
      f.unmount()
    }
  )

  it('keeps restored pending locked until main confirms failure, then restores editable fields', async () => {
    const handoff = { requestId: 'pending-lock', kind: 'save', payload: { id: 5, addedImages: [] } }
    seed({ handoff })
    api.states.set(handoff.requestId, { requestId: handoff.requestId, status: 'pending' })
    const waiting = deferred()
    api.waitNote.mockReturnValueOnce(waiting.promise)
    const f = fixture(),
      mounting = f.mount()
    await settle()
    expect(f.port.commitLocked.value).toBe(true)
    waiting.resolve({
      requestId: handoff.requestId,
      status: 'failed',
      error: { code: 'SQL', message: 'refused' }
    })
    await mounting
    expect(f.port.commitLocked.value).toBe(false)
    expect(f.content.value).toBe('retained')
    expect(api.submitNote).not.toHaveBeenCalled()
    f.unmount()
  })

  it('never submits when the request journal cannot be persisted', async () => {
    const f = fixture()
    await f.mount()
    f.content.value = 'preserve me'
    await f.port.flush()
    storage.setItem.mockImplementation(() => {
      throw new Error('journal write refused')
    })
    f.content.value = 'preserve me'
    await expect(f.port.commitNote('create', { images: [] })).rejects.toThrow(
      'journal write refused'
    )
    expect(api.submitNote).not.toHaveBeenCalled()
    expect(api.discardOwner).not.toHaveBeenCalled()
    f.unmount()
  })

  it('persists request identity before SQL and recovers a lost response without a second submit', async () => {
    const onCommitted = vi.fn(),
      f = fixture({ onCommitted })
    await f.mount()
    f.content.value = 'save once'
    api.submitNote.mockImplementationOnce(async (_owner, requestId, kind, payload) => {
      expect(JSON.parse(storage.getItem(prefix + 'editor')).handoff).toEqual({
        requestId,
        kind,
        payload,
        submittedData: { content: 'save once', attachments: [] }
      })
      api.states.set(requestId, { requestId, status: 'committed', result: { id: 18 } })
      throw new Error('response lost')
    })
    await expect(
      f.port.commitNote('create', { options: { content: 'save once' }, images: [], tagIds: [] })
    ).rejects.toThrow('response lost')
    const requestId = JSON.parse(storage.getItem(prefix + 'editor')).handoff.requestId
    expect(await f.port.commitNote('create', { options: { content: 'do not replay' } })).toEqual({
      id: 18
    })
    expect(api.noteState).toHaveBeenCalledWith(expect.any(Object), requestId)
    expect(api.submitNote).toHaveBeenCalledTimes(1)
    expect(onCommitted).toHaveBeenCalledWith({ id: 18 }, { recovered: false })
    expect(storage.getItem(prefix + 'editor')).toBeNull()
    f.unmount()
  })

  it.each(['committed', 'pending'])(
    'resolves restored %s before field or image rehydration',
    async (status) => {
      const handoff = {
        requestId: 'original-request',
        kind: 'create',
        payload: { images: [asset] }
      }
      seed({ handoff })
      api.states.set(handoff.requestId, {
        requestId: handoff.requestId,
        status,
        result: { id: 20 }
      })
      api.waitNote.mockResolvedValue({
        requestId: handoff.requestId,
        status: 'committed',
        result: { id: 20 }
      })
      const restoreExtra = vi.fn(),
        onCommitted = vi.fn(),
        f = fixture({ restoreExtra, onCommitted })
      await f.mount()
      expect(f.content.value).toBe('')
      expect(restoreExtra).not.toHaveBeenCalled()
      expect(onCommitted).toHaveBeenCalledWith({ id: 20 }, { recovered: true })
      expect(api.submitNote).not.toHaveBeenCalled()
      expect(storage.getItem(prefix + 'editor')).toBeNull()
      f.unmount()
    }
  )

  it('retains an unknown original request and reuses its payload on the next explicit action', async () => {
    const handoff = {
      requestId: 'uncertain-request',
      kind: 'create',
      payload: { options: { content: 'original' }, images: [] }
    }
    seed({ handoff })
    const f = fixture()
    await f.mount()
    await f.port.commitNote('create', { options: { content: 'changed' } })
    expect(api.submitNote).toHaveBeenCalledWith(
      expect.any(Object),
      handoff.requestId,
      handoff.kind,
      handoff.payload
    )
    f.unmount()
  })

  it('keeps SQL failure sources and creates a new identity only on the next explicit save', async () => {
    const f = fixture()
    await f.mount()
    f.images.value = [asset]
    api.submitNote.mockImplementationOnce(async (_owner, requestId) => ({
      requestId,
      status: 'failed',
      error: { code: 'SQL', message: 'SQL refused' }
    }))
    await expect(f.port.commitNote('create', { images: [asset] })).rejects.toThrow('SQL refused')
    const first = JSON.parse(storage.getItem(prefix + 'editor')).handoff.requestId
    expect(api.discardOwner).not.toHaveBeenCalled()
    expect(api.release).not.toHaveBeenCalled()
    await settle()
    expect(api.submitNote).toHaveBeenCalledTimes(1)
    await f.port.commitNote('create', { images: [asset] })
    expect(api.submitNote.mock.calls[1][1]).not.toBe(first)
    f.unmount()
  })

  it('rehydrates a restored pending operation that eventually fails and waits for an explicit new save', async () => {
    const handoff = {
      requestId: 'failed-later',
      kind: 'save',
      payload: { id: 5, addedImages: [asset] }
    }
    seed({ handoff })
    api.states.set(handoff.requestId, { requestId: handoff.requestId, status: 'pending' })
    api.waitNote.mockResolvedValue({
      requestId: handoff.requestId,
      status: 'failed',
      error: { code: 'SQL', message: 'refused' }
    })
    const restoreExtra = vi.fn(),
      f = fixture({ restoreExtra })
    await f.mount()
    expect(f.content.value).toBe('retained')
    expect(restoreExtra).toHaveBeenCalledTimes(1)
    expect(api.submitNote).not.toHaveBeenCalled()
    await f.port.commitNote('save', handoff.payload)
    expect(api.submitNote.mock.calls[0][1]).not.toBe(handoff.requestId)
    f.unmount()
  })

  it('reports cleanup/UI failures as committed and opens a fresh owner for continuous creation', async () => {
    const f = fixture({
      resumeAfterCommit: true,
      onCommitted: () => {
        f.content.value = ''
        throw new Error('UI failure')
      }
    })
    await f.mount()
    f.content.value = 'create'
    await f.port.flush()
    const original = api.owners.get('editor')
    api.discardOwner.mockImplementationOnce(async (owner) => {
      api.owners.delete(owner.key)
      return { cancelled: true, cleanupErrors: [{ code: 'EACCES', message: 'cleanup' }] }
    })
    await expect(f.port.commitNote('create', { images: [] })).resolves.toEqual({ id: 17 })
    f.content.value = 'next note'
    expect(await f.port.flush()).toMatchObject({ persisted: true, dirty: true })
    expect(api.owners.get('editor').ownerId).not.toBe(original.ownerId)
    f.unmount()
  })
})

describe('same-launch legacy draft migration', () => {
  it('restores text and all original field values before completing and removing exact v2 bytes', async () => {
    const baseline = ref(0),
      remark = ref(''),
      statusChoice = ref('')
    const source = seedLegacy('note:9', {
      content: 'legacy text',
      initialVersion: 11,
      remark: 'retained remark',
      statusChoice: 'unfinished'
    })
    const content = ref('')
    const restore = vi.fn(async () => {
      expect(storage.getItem(legacyDraftKey(sessionId, 'note:9'))).toBe(source)
      const receipt = JSON.parse(storage.getItem(prefix + 'note:9'))
      expect(receipt.migration.phase).toBe('staging')
      expect(receipt.data).toEqual({})
    })
    const f = fixture({
      key: 'note:9',
      fields: { content, initialVersion: baseline, remark, statusChoice },
      dirty: () => Boolean(content.value),
      extra: () => ({}),
      restoreExtra: restore
    })
    await f.mount()
    expect([content.value, baseline.value, remark.value, statusChoice.value]).toEqual([
      'legacy text',
      11,
      'retained remark',
      'unfinished'
    ])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(storage.getItem(legacyDraftKey(sessionId, 'note:9'))).toBeNull()
    const converted = JSON.parse(storage.getItem(prefix + 'note:9'))
    expect(converted.migration).toMatchObject({
      phase: 'complete',
      sourceHash: await hashLegacyDraft(source)
    })
    expect(converted.data.initialVersion).toBe(11)
    expect(api.stage).not.toHaveBeenCalled()
    expect((await f.port.flush()).persisted).toBe(true)
    f.unmount()
  })

  it('durably binds the candidate before sequential stages and permits real preview during restore', async () => {
    const source = seedLegacy('new:list', {
      content: 'legacy text',
      attachments: {
        addedImages: [legacyImage, { ...legacyImage, name: 'second.png' }],
        deletedImageIds: [8]
      }
    })
    const first = deferred(),
      order = []
    api.stage
      .mockImplementationOnce(async (original, image) => {
        const pending = JSON.parse(storage.getItem(prefix + 'new:list'))
        expect(pending.owner).toEqual(original)
        expect(pending.migration.phase).toBe('staging')
        expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
        expect(image).toEqual(legacyImage)
        order.push('first')
        return first.promise
      })
      .mockImplementationOnce(async () => {
        order.push('second')
        return { ...asset, assetId: 'second' }
      })
    let f
    f = legacyForm({
      restoreExtra: async (data) => {
        f.images.value = data.attachments.addedImages
        expect((await f.port.previewAsset(asset.assetId)).bytes).toEqual(new Uint8Array([1, 2, 3]))
        expect((await f.port.flush()).persisted).toBe(false)
        expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
      }
    })
    const mounting = f.mount()
    // Hashing uses Web Crypto, so wait for the first stage rather than a fixed microtask count.
    await vi.waitFor(() => expect(api.stage).toHaveBeenCalledTimes(1))
    await settle()
    expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
    expect(await window.__prepareEditingDrafts()).toMatchObject({ blocked: true })
    first.resolve(asset)
    await mounting
    expect(order).toEqual(['first', 'second'])
    expect(f.images.value.map((image) => image.assetId)).toEqual(['asset', 'second'])
    expect(
      JSON.parse(storage.getItem(prefix + 'new:list')).data.attachments.deletedImageIds
    ).toEqual([8])
    expect(storage.getItem(prefix + 'new:list')).not.toMatch(/base64|dataUrl|capability/)
    f.unmount()
  })

  it.each(['receipt', 'stage', 'restore', 'restore-false', 'complete-write'])(
    'preserves exact source and cleans only the candidate after %s failure',
    async (mode) => {
      const source = seedLegacy('new:list', {
        content: 'original',
        attachments: { addedImages: [legacyImage], deletedImageIds: [] }
      })
      const originalSet = storage.setItem.getMockImplementation()
      storage.setItem.mockImplementation((key, value) => {
        if (
          key === prefix + 'new:list' &&
          ((mode === 'receipt' && JSON.parse(value).migration?.phase === 'staging') ||
            (mode === 'complete-write' && JSON.parse(value).migration?.phase === 'complete'))
        )
          throw new Error('storage refused')
        originalSet(key, value)
      })
      if (mode === 'stage') api.stage.mockRejectedValueOnce(new Error('stage refused'))
      const f = legacyForm(
        mode === 'restore'
          ? {
              restoreExtra: () => {
                throw new Error('preview refused')
              }
            }
          : mode === 'restore-false'
            ? { restoreExtra: () => false }
            : {}
      )
      await f.mount()
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
      expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
      expect(api.discardOwner).toHaveBeenCalledTimes(1)
      expect(api.discardOwner.mock.calls[0][0].key).toBe('new:list')
      expect(api.stage).toHaveBeenCalledTimes(mode === 'receipt' ? 0 : 1)
      expect(api.submitNote).not.toHaveBeenCalled()
      f.unmount()
      await settle()
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
    }
  )

  it('revokes an interrupted candidate using its full receipt before restaging', async () => {
    const source = seedLegacy('new:list', {
      content: 'original',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    const original = seed({ key: 'new:list', data: {} })
    const staging = JSON.parse(storage.getItem(prefix + 'new:list'))
    staging.migration = legacyMigrationReceipt(
      sessionId,
      'new:list',
      await hashLegacyDraft(source),
      {}
    )
    storage.setItem(prefix + 'new:list', JSON.stringify(staging))
    const f = legacyForm()
    api.stage.mockImplementationOnce(async (candidate) => {
      expect(candidate.ownerId).not.toBe(original.ownerId)
      expect(api.discardOwner).toHaveBeenCalledWith(original)
      return asset
    })
    await f.mount()
    expect(api.openOwner).toHaveBeenNthCalledWith(1, 'new:list', original)
    expect(api.stage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(prefix + 'new:list')).migration.phase).toBe('complete')
    expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBeNull()
    f.unmount()
  })

  it.each(['unknown', 'v3'])(
    'preserves an external %s journal that appears while the first owner response is pending',
    async (format) => {
      const source = seedLegacy('new:list', {
        content: 'legacy source',
        attachments: { addedImages: [legacyImage], deletedImageIds: [] }
      })
      const opening = deferred()
      const candidate = { sessionId, key: 'new:list', ownerId: 'opening-candidate', generation: 1 }
      api.openOwner.mockReturnValueOnce(opening.promise)
      const f = legacyForm(),
        mounting = f.mount()
      await vi.waitFor(() => expect(api.openOwner).toHaveBeenCalledTimes(1))
      const externalOwner = { ...candidate, ownerId: 'external-owner' }
      const external =
        format === 'unknown'
          ? '{"version":99,"original":"external bytes must remain"}'
          : JSON.stringify({
              version: 3,
              sessionId,
              key: 'new:list',
              owner: externalOwner,
              data: { content: 'external draft' }
            })
      storage.setItem(prefix + 'new:list', external)
      // An independent storage writer does not change this composable's instance epoch.
      opening.resolve(candidate)
      await mounting
      expect(storage.getItem(prefix + 'new:list')).toBe(external)
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
      expect(api.stage).not.toHaveBeenCalled()
      expect(api.discardOwner).toHaveBeenCalledExactlyOnceWith(candidate)
      expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
      f.unmount()
      await settle()
      expect(storage.getItem(prefix + 'new:list')).toBe(external)
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
    }
  )

  it.each(['lost-revocation', 'receipt-delete'])(
    'fails closed across remount when %s cannot be confirmed',
    async (mode) => {
      const source = seedLegacy('new:list', {
        content: 'original',
        attachments: { addedImages: [legacyImage], deletedImageIds: [] }
      })
      api.stage.mockRejectedValueOnce(new Error('stage response lost'))
      if (mode === 'lost-revocation')
        api.discardOwner.mockImplementationOnce(async (original) => {
          api.owners.delete(original.key)
          throw new Error('cancel response lost')
        })
      else
        storage.removeItem.mockImplementation((key) => {
          if (key === prefix + 'new:list') throw new Error('delete refused')
          delete storage[key]
        })
      const first = legacyForm()
      await first.mount()
      const receipt = storage.getItem(prefix + 'new:list')
      expect(JSON.parse(receipt).migration.phase).toBe('staging')
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
      first.unmount()
      const replacement = legacyForm()
      await replacement.mount()
      expect(api.stage).toHaveBeenCalledTimes(1)
      expect(storage.getItem(prefix + 'new:list')).toBe(receipt)
      expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(source)
      expect(await replacement.port.flush()).toMatchObject({ blocked: true, persisted: false })
      replacement.unmount()
    }
  )

  it('uses the completed receipt after exact old-source deletion fails without restaging', async () => {
    const location = legacyDraftKey(sessionId, 'new:list')
    const source = seedLegacy('new:list', {
      content: 'original',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    const remove = storage.removeItem.getMockImplementation()
    storage.removeItem.mockImplementation((key) => {
      if (key === location) throw new Error('source delete refused')
      remove(key)
    })
    const first = legacyForm()
    await first.mount()
    expect((await first.port.flush()).persisted).toBe(true)
    expect(JSON.parse(storage.getItem(prefix + 'new:list')).migration.phase).toBe('complete')
    first.unmount()
    storage.removeItem.mockImplementation(remove)
    const replacement = legacyForm()
    await replacement.mount()
    expect(replacement.content.value).toBe('original')
    expect(api.stage).toHaveBeenCalledTimes(1)
    expect(storage.getItem(location)).toBeNull()
    expect(source).toContain('base64')
    replacement.unmount()
  })

  it('detects source changes during stage and never deletes or overwrites the newer raw', async () => {
    const location = legacyDraftKey(sessionId, 'new:list')
    seedLegacy('new:list', {
      content: 'original',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    const changed = JSON.stringify({ updatedAt: 124, data: { content: 'newer raw' } })
    api.stage.mockImplementationOnce(async () => {
      storage.setItem(location, changed)
      return asset
    })
    const f = legacyForm()
    await f.mount()
    expect(storage.getItem(location)).toBe(changed)
    expect(api.discardOwner).toHaveBeenCalledTimes(1)
    expect(f.images.value).toEqual([])
    expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
    f.unmount()
  })

  it.each(['stage', 'restore'])(
    'preserves newer user fields and the old source when typing overlaps %s',
    async (phase) => {
      const location = legacyDraftKey(sessionId, 'new:list')
      const source = seedLegacy('new:list', {
        content: 'old text',
        attachments: { addedImages: [legacyImage], deletedImageIds: [] }
      })
      const pending = deferred()
      const restore = vi.fn(() => pending.promise)
      if (phase === 'stage') api.stage.mockReturnValueOnce(pending.promise)
      const f = legacyForm({ restoreExtra: restore }),
        mounting = f.mount()
      await vi.waitFor(() =>
        expect(phase === 'stage' ? api.stage : restore).toHaveBeenCalledTimes(1)
      )
      f.content.value = 'new input while recovery waits'
      await settle()
      pending.resolve(phase === 'stage' ? asset : true)
      await mounting
      expect(f.content.value).toBe('new input while recovery waits')
      expect(storage.getItem(location)).toBe(source)
      expect(api.discardOwner).toHaveBeenCalledTimes(1)
      expect(await f.port.flush()).toMatchObject({ blocked: true, persisted: false })
      await expect(f.port.commitNote('create', {})).rejects.toThrow('新的编辑')
      expect(api.submitNote).not.toHaveBeenCalled()
      if (phase === 'stage') expect(restore).not.toHaveBeenCalled()
      f.unmount()
    }
  )

  it('retains MonthCreator missing-immediateIntent compatibility while guarding async restoration', async () => {
    const immediateIntent = ref(true),
      content = ref('')
    seedLegacy('new:calendar:2026-10-22', { content: 'scheduled', time: '09:00' })
    const f = fixture({
      key: 'new:calendar:2026-10-22',
      fields: { content, immediateIntent },
      dirty: () => Boolean(content.value),
      extra: () => ({}),
      restoreExtra: (data) => {
        if (typeof data.immediateIntent !== 'boolean') immediateIntent.value = false
      }
    })
    await f.mount()
    expect(immediateIntent.value).toBe(false)
    expect(storage.getItem(legacyDraftKey(sessionId, 'new:calendar:2026-10-22'))).toBeNull()
    expect(await f.port.flush()).toMatchObject({ blocked: false, persisted: true })
    f.unmount()
  })

  it('waits for an unmounted migration to drain its owned stage before the replacement starts', async () => {
    const location = legacyDraftKey(sessionId, 'new:list')
    const source = seedLegacy('new:list', {
      content: 'original',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    const staged = deferred()
    api.stage.mockReturnValueOnce(staged.promise)
    const first = legacyForm(),
      mounting = first.mount()
    await vi.waitFor(() => expect(api.stage).toHaveBeenCalledTimes(1))
    first.unmount()
    const replacement = legacyForm(),
      replacing = replacement.mount()
    await settle()
    expect(api.stage).toHaveBeenCalledTimes(1)
    expect(storage.getItem(location)).toBe(source)
    staged.resolve(asset)
    await Promise.all([mounting, replacing])
    expect(api.discardOwner).toHaveBeenCalledTimes(1)
    expect(api.stage).toHaveBeenCalledTimes(2)
    expect(replacement.content.value).toBe('original')
    replacement.unmount()
  })

  it('seals an in-flight migration on committed global clear and removes only known current v2', async () => {
    const location = legacyDraftKey(sessionId, 'new:list')
    const source = seedLegacy('new:list', {
      content: 'must not return',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    const other = legacyDraftKey('previous-launch', 'new:list')
    const unknown = legacyDraftKey(sessionId, 'unverified')
    storage.setItem(other, source)
    storage.setItem(unknown, source)
    const staged = deferred()
    api.stage.mockReturnValueOnce(staged.promise)
    const first = legacyForm(),
      mounting = first.mount()
    await vi.waitFor(() => expect(api.stage).toHaveBeenCalledTimes(1))
    await window.__clearEditingDrafts()
    expect(storage.getItem(location)).toBeNull()
    expect(storage.getItem(prefix + 'new:list')).toBeNull()
    staged.resolve(asset)
    await mounting
    expect(api.discardOwner).not.toHaveBeenCalled()
    expect(storage.getItem(location)).toBeNull()
    expect(storage.getItem(prefix + 'new:list')).toBeNull()
    expect(storage.getItem(other)).toBe(source)
    expect(storage.getItem(unknown)).toBe(source)
    first.unmount()
    const replacement = legacyForm()
    await replacement.mount()
    expect(replacement.content.value).toBe('')
    expect(api.stage).toHaveBeenCalledTimes(1)
    replacement.unmount()
  })

  it('retains same-key v2/v3 conflicts and other launches without opening or staging', async () => {
    const current = seedLegacy('new:list'),
      original = seed({ key: 'new:list', data: { content: 'v3' } })
    const v3 = storage.getItem(prefix + 'new:list')
    const otherKey = legacyDraftKey('previous-launch', 'new:list')
    storage.setItem(otherKey, current)
    const f = legacyForm()
    await f.mount()
    expect(storage.getItem(legacyDraftKey(sessionId, 'new:list'))).toBe(current)
    expect(storage.getItem(prefix + 'new:list')).toBe(v3)
    expect(storage.getItem(otherKey)).toBe(current)
    expect(api.openOwner).not.toHaveBeenCalled()
    expect(api.owners.get('new:list')).toEqual(original)
    expect(api.stage).not.toHaveBeenCalled()
    f.unmount()
  })

  it('blocks both ambiguous screenshot forms before owner, fields, extra or SQL', async () => {
    seedLegacy('new:capture', {
      content: 'old target',
      attachments: { addedImages: [legacyImage], deletedImageIds: [] }
    })
    seedLegacy('capture:pending-delivery', {
      pendingAsset: {
        sessionId: 'capture-session',
        deliveryId: 'delivery',
        action: 'note',
        dataUrl: 'data:image/png;base64,AQID',
        size: 3
      }
    })
    expect(getLegacyCaptureConflict()).toBe(LEGACY_CAPTURE_CONFLICT)
    const restore = vi.fn(),
      target = legacyForm({ key: 'new:capture', restoreExtra: restore }),
      pending = legacyForm({ key: 'capture:pending-delivery', restoreExtra: restore })
    await Promise.all([target.mount(), pending.mount()])
    expect(target.content.value).toBe('')
    expect(restore).not.toHaveBeenCalled()
    expect(api.openOwner).not.toHaveBeenCalled()
    expect(api.stage).not.toHaveBeenCalled()
    await expect(target.port.commitNote('create', {})).rejects.toMatchObject({
      code: 'DRAFT_LEGACY_CAPTURE_CONFLICT'
    })
    expect(api.submitNote).not.toHaveBeenCalled()
    target.unmount()
    pending.unmount()
  })
})

describe('journal format boundaries', () => {
  it('cleans recognized previous-launch v3 only and rejects credentials, promises and originals', () => {
    const other = 'abandon:editing-draft:v3:old:editor'
    storage.setItem(
      other,
      JSON.stringify({
        version: 3,
        sessionId: 'old',
        key: 'editor',
        owner: { sessionId: 'old', key: 'editor', ownerId: 'old-owner', generation: 1 },
        data: {}
      })
    )
    storage.setItem('abandon:editing-draft:v3:old:unknown', '{"version":4}')
    storage.setItem('abandon:editing-draft:v2:old:editor', '{"data":{"base64":"original"}}')
    removePreviousDraftSessions(storage, sessionId)
    expect(storage.getItem(other)).toBeNull()
    expect(Object.keys(storage)).toHaveLength(2)
    for (const value of [
      { base64: 'original' },
      { owner: { capability: 'private' } },
      { pending: Promise.resolve(true) }
    ])
      expect(() => cloneDraftMetadata(value)).toThrow()
  })
})
