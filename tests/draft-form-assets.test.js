import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Execute the product setup functions. The controls and asset transport are
// isolated so failures can be held at the actual form/receiver await boundaries.
const renderer = vue.createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null
})
const apps = []
const generation = vue.ref(0)
let ports, showMessage, delivery, frames, events, getLegacyCaptureConflict, deliveryStates
const image = {
  assetId: 'target-image',
  ext: 'png',
  name: 'capture.png',
  size: 3,
  sha256: 'a'.repeat(64)
}
const sourceImage = { ...image, assetId: 'pending-image' }
const receipt = { sessionId: 'capture-session', deliveryId: 'delivery-one' }
const sourceAsset = { ...receipt, action: 'note', dataUrl: 'data:image/png;base64,YWJj', size: 3 }

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  for (let index = 0; index < 12; index++) await vue.nextTick()
}
function draftPort(options) {
  const port = {
    options,
    snapshots: [],
    commitLocked: vue.ref(false),
    flush: vi.fn(async () => {
      events.push(options.key + ':flush')
      const data = {
        ...Object.fromEntries(
          Object.entries(options.fields).map(([key, value]) => [key, value.value])
        ),
        ...options.extra?.()
      }
      port.snapshots.push(JSON.parse(JSON.stringify(data)))
      return { dirty: options.dirty(), blocked: options.busy?.() || false, persisted: true }
    }),
    clear: vi.fn(async () => {
      events.push(options.key + ':clear')
      return true
    }),
    resume: vi.fn(async () => true),
    stageImage: vi.fn(async () => sourceImage),
    previewAsset: vi.fn(async () => ({ bytes: new Uint8Array([97, 98, 99]), ext: 'png', size: 3 })),
    releaseAssets: vi.fn(async () => true),
    commitNote: vi.fn(async () => {
      const result = { id: 12 }
      await options.onCommitted?.(result, { recovered: false })
      return result
    })
  }
  ports.set(options.key, port)
  return port
}
async function componentAt(path) {
  const url = new URL('../src/renderer/src/components/' + path, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  let code = compileScript(descriptor, { id: 'draft-form-assets' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = [],
    declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/useDraftProtection.js'))
      dependency = {
        editingDataGeneration: generation,
        getLegacyCaptureConflict,
        useDraftProtection: draftPort
      }
    else if (name.endsWith('/useMessage.js')) dependency = { useMessage: () => ({ showMessage }) }
    else if (name.endsWith('/useScreenCapture.js'))
      dependency = await import(new URL(name, url).href)
    else if (name.endsWith('/useQueuedModal.js'))
      dependency = {
        useModalRequest: () => ({ requested: vue.ref(false) }),
        useQueuedModal: (value) => ({
          visible: vue.computed(() => Boolean(value.value)),
          finishLeave: vi.fn()
        })
      }
    else if (name.endsWith('/useNewNotePreferences.js'))
      dependency = {
        useNewNotePreferences: () => ({
          durationKind: vue.ref('single_day'),
          durationDays: vue.ref(1),
          tagIds: vue.ref([]),
          reminderChannels: vue.ref(0),
          isPinned: vue.ref(false),
          statusChoice: vue.ref('in_progress')
        })
      }
    else if (name.endsWith('/useNoteStateDraft.js'))
      dependency = {
        parseNoteDraftTime: (value) => (value ? new Date(value).getTime() : null),
        useNoteStateDraft: () => ({
          status: vue.ref('in_progress'),
          statusOptions: vue.ref([]),
          currentTime: vue.ref(Date.now()),
          stateHint: vue.ref(''),
          canScheduleNotification: vue.ref(false),
          chooseStatus: vi.fn(),
          submissionFields: () => ({ status: 'in_progress', effectiveAt: null })
        })
      }
    else if (name.endsWith('/settingsSnapshots.js'))
      dependency = {
        getSettingsSnapshotStore: () => ({ latest: () => null, acceptCommitted: vi.fn() })
      }
    else dependency = await import(new URL(name, url).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name}=dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}
async function mount(path, props = {}) {
  const component = await componentAt(path)
  let state, exposed
  const emitted = []
  const app = renderer.createApp(
    {
      ...component,
      setup(componentProps, context) {
        state = component.setup(componentProps, {
          ...context,
          expose: (value) => {
            exposed = value
            context.expose(value)
          },
          emit: (name, ...values) => {
            emitted.push([name, ...values])
            context.emit(name, ...values)
          }
        })
        return state
      },
      render: () => vue.h('div')
    },
    props
  )
  apps.push(app)
  app.mount({})
  await flush()
  return { state, app, emitted, exposed }
}
function attachPicker(state, port) {
  const images = []
  const picker = {
    getImages: vi.fn(() => images),
    getDraftChanges: vi.fn(() => ({ addedImages: images, deletedImageIds: [] })),
    clearImages: vi.fn(async () => {
      images.splice(0)
    }),
    restoreDraft: vi.fn(async (data) => {
      images.splice(0, images.length, ...(data?.addedImages || []))
    }),
    addCapture: vi.fn(async (_asset, options) => {
      // The real picker calls this synchronously before publishing its metadata.
      options.onStaged(image)
      images.push(image)
      return (await port.flush()).persisted
    })
  }
  state.imagePickerRef.value = picker
  return { picker, images }
}

beforeEach(() => {
  deliveryStates = new Set()
  generation.value = 0
  ports = new Map()
  frames = new Map()
  events = []
  showMessage = vi.fn()
  getLegacyCaptureConflict = vi.fn(() => null)
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    const id = frames.size + 1
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
  vi.stubGlobal('window', {
    api: {
      onScreenshotDelivery: vi.fn((callback) => {
        delivery = callback
        return vi.fn()
      }),
      onScreenshotDeliveryState: vi.fn((callback) => {
        deliveryStates.add(callback)
        return vi.fn(() => deliveryStates.delete(callback))
      }),
      reportScreenshotDelivery: vi.fn(async () => true),
      acknowledgeScreenshot: vi.fn(async () => true)
    },
    __prepareEditingDrafts: vi.fn(async () => ({ dirty: false, blocked: false })),
    __confirmEditingDrafts: vi.fn(async () => true)
  })
  vi.stubGlobal(
    'FileReader',
    class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
          this.onload()
        })
      }
    }
  )
})

function rejectDelivery(ids = receipt) {
  for (const callback of [...deliveryStates])
    callback({ ...ids, state: 'rejected', message: 'controlled delivery cancellation' })
}
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('draft form asset consumers', () => {
  it('locks a pending create against external images and discard while keeping result queries available', async () => {
    const form = await mount('list/NewNotePanel.vue', { draftKey: 'new:capture' })
    const port = ports.get('new:capture')
    const { picker } = attachPicker(form.state, port)
    port.commitLocked.value = true
    port.commitNote.mockRejectedValueOnce(new Error('原创建结果尚未确认'))
    expect(form.state.canCreate.value).toBe(false)
    expect(form.state.commitLocked.value).toBe(true)
    expect(form.state.submitLabel.value).toBe('查询创建结果')
    expect(await form.state.addCapture(sourceAsset)).toBe(false)
    expect(await form.exposed.discard()).toBe(false)
    expect(picker.addCapture).not.toHaveBeenCalled()
    expect(port.clear).not.toHaveBeenCalled()
    await form.state.handleCreate()
    expect(port.commitNote).toHaveBeenCalledExactlyOnceWith('create', {})
    expect(form.state.commitLocked.value).toBe(true)
    expect(form.state.submitState.value).toBe('idle')
    const source = readFileSync(
      new URL('../src/renderer/src/components/list/NewNotePanel.vue', import.meta.url),
      'utf8'
    )
    expect(source).toContain(':inert="submitState !== \'idle\' || commitLocked"')
  })

  it.each([
    [
      'note/NoteEditor.vue',
      {
        note: {
          id: 31,
          content: '原正文',
          status: 'in_progress',
          effective_at: Date.now(),
          editVersion: 'v1'
        }
      },
      'note:31',
      'handleSave',
      'save'
    ],
    [
      'month/MonthNoteCreator.vue',
      { dateKey: '2026-10-14' },
      'new:calendar:2026-10-14',
      'create',
      'create'
    ]
  ])(
    'keeps %s locked while querying the accepted request without revalidating a new payload',
    async (path, props, key, method, kind) => {
      const form = await mount(path, props)
      const port = ports.get(key)
      port.commitLocked.value = true
      port.commitNote.mockRejectedValueOnce(new Error('原结果尚未确认'))
      form.state.tagIds.value = [1, 2]
      await form.state[method]()
      expect(port.commitNote).toHaveBeenCalledExactlyOnceWith(kind, {})
      expect(form.state.commitLocked.value).toBe(true)
      await form.state.requestClose()
      expect(form.emitted).toEqual([])
      expect(port.clear).not.toHaveBeenCalled()
      const source = readFileSync(
        new URL('../src/renderer/src/components/' + path, import.meta.url),
        'utf8'
      )
      expect(source).toContain(':inert="saving || commitLocked"')
    }
  )

  it('keeps a locked editor snapshot intact when the successful SQL broadcast replaces its note prop', async () => {
    const note = {
      id: 31,
      content: '原正文',
      status: 'in_progress',
      effective_at: Date.now(),
      editVersion: 'v1'
    }
    const form = await mount('note/NoteEditor.vue', { note })
    const port = ports.get('note:31')
    form.state.content.value = '已提交正文'
    port.commitLocked.value = true
    form.app._instance.props.note = { ...note, content: '数据库提交后的广播', editVersion: 'v2' }
    await flush()
    expect(form.state.content.value).toBe('已提交正文')
    expect(form.state.initialVersion.value).toBe('v1')
    port.commitLocked.value = false
    form.app._instance.props.note = { ...note, content: '明确加载的最新正文', editVersion: 'v3' }
    await flush()
    expect(form.state.content.value).toBe('明确加载的最新正文')
    expect(form.state.initialVersion.value).toBe('v3')
  })

  it('submits opaque metadata and waits for local reset before announcing continuous-create success', async () => {
    const { state, emitted } = await mount('list/NewNotePanel.vue')
    const port = ports.get('new:list')
    const { picker, images } = attachPicker(state, port)
    images.push(image)
    state.content.value = '当前正文'
    state.remark.value = '当前备注'
    const clearing = deferred()
    picker.clearImages.mockReturnValueOnce(clearing.promise)
    const creating = state.handleCreate()
    await flush()
    expect(port.commitNote).toHaveBeenCalledExactlyOnceWith(
      'create',
      expect.objectContaining({
        options: expect.objectContaining({ content: '当前正文', remark: '当前备注' }),
        images: [image]
      })
    )
    expect(emitted).toEqual([])
    expect(state.submitState.value).toBe('creating')
    expect(port.options.resumeAfterCommit).toBe(true)
    expect(port.clear).not.toHaveBeenCalled()
    expect(port.resume).not.toHaveBeenCalled()
    clearing.resolve()
    await creating
    expect(emitted).toEqual([['create']])
    expect(state.content.value).toBe('')
    expect(state.remark.value).toBe('')
    expect(state.submitState.value).toBe('idle')
    expect(JSON.stringify(port.commitNote.mock.calls)).not.toContain('base64')
  })

  it('persists capture identity in the same snapshot as image metadata and reuses it after remount', async () => {
    const first = await mount('list/NewNotePanel.vue', { draftKey: 'new:capture' })
    const firstPort = ports.get('new:capture')
    const firstPicker = attachPicker(first.state, firstPort)
    expect(await first.state.addCapture(sourceAsset)).toBe(true)
    const snapshotsWithImage = firstPort.snapshots.filter(
      (value) => value.attachments?.addedImages.length
    )
    expect(snapshotsWithImage.length).toBeGreaterThan(0)
    for (const snapshot of snapshotsWithImage)
      expect(snapshot.captureReceipts).toEqual([{ ...receipt, assetId: image.assetId }])
    const saved = snapshotsWithImage.at(-1)
    first.app.unmount()
    const second = await mount('list/NewNotePanel.vue', { draftKey: 'new:capture' })
    const secondPort = ports.get('new:capture')
    const secondPicker = attachPicker(second.state, secondPort)
    // The composable's recovery is covered separately; use its actual fields and
    // restoreExtra contract to deliver the recorded metadata to the remount.
    secondPort.options.fields.captureReceipts.value = saved.captureReceipts
    await secondPort.options.restoreExtra(saved)
    expect(second.state.hasCapture(receipt)).toBe(true)
    expect(await second.state.addCapture(receipt)).toBe(true)
    expect(secondPicker.picker.addCapture).not.toHaveBeenCalled()
    expect(secondPicker.images).toEqual([image])
    expect(firstPicker.picker.addCapture).toHaveBeenCalledOnce()
  })

  it('keeps a successful SQL result successful when a stale form is already gone', async () => {
    const form = await mount('list/NewNotePanel.vue')
    const port = ports.get('new:list')
    attachPicker(form.state, port)
    form.app.unmount()
    await port.options.onCommitted({ id: 9 }, { recovered: true })
    expect(form.emitted).toEqual([])
    expect(showMessage).not.toHaveBeenCalled()
  })
})

describe('capture pending-to-target ownership', () => {
  it.each(['note', 'background'])(
    'keeps a restored %s journal hidden in a new receiver until the user explicitly recovers it',
    async (action) => {
      const original = await mount('capture/CaptureDelivery.vue')
      const firstPort = ports.get('capture:pending-delivery')
      original.state.pendingAsset.value = { ...receipt, action, image: sourceImage }
      await firstPort.flush()
      const saved = JSON.parse(JSON.stringify(firstPort.snapshots[0].pendingAsset))
      original.app.unmount()

      const restored = await mount('capture/CaptureDelivery.vue')
      const port = ports.get('capture:pending-delivery')
      restored.state.pendingAsset.value = saved
      await port.options.restoreExtra()
      expect(restored.state.noteVisible.value).toBe(false)
      expect(restored.state.background.value).toBe('')
      expect(restored.state.recoveryPending.value).toBe(true)
      expect(restored.state.pendingAsset.value).toEqual(saved)
      expect(port.stageImage).not.toHaveBeenCalled()
      expect(port.previewAsset).not.toHaveBeenCalled()
      expect(port.clear).not.toHaveBeenCalled()
      expect(port.releaseAssets).not.toHaveBeenCalled()
      expect(window.api.reportScreenshotDelivery).not.toHaveBeenCalled()
      expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()

      await restored.state.recoverPendingCapture()
      expect(port.flush).toHaveBeenCalledOnce()
      expect(restored.state.recoveryPending.value).toBe(false)
      expect(restored.state.pendingAsset.value).toEqual(saved)
      expect(port.stageImage).not.toHaveBeenCalled()
      if (action === 'background') {
        expect(restored.state.background.value).toBe(sourceAsset.dataUrl)
        expect(restored.state.noteVisible.value).toBe(false)
        expect(port.previewAsset).toHaveBeenCalledExactlyOnceWith(sourceImage.assetId)
        expect(port.clear).not.toHaveBeenCalled()
      } else {
        expect(restored.state.noteVisible.value).toBe(true)
        expect(port.previewAsset).not.toHaveBeenCalled()
        const target = {
          draftState: vi.fn(async () => ({ persisted: true })),
          hasCapture: vi.fn(() => false),
          addCapture: vi.fn(async () => true)
        }
        restored.state.noteRef.value = target
        await restored.state.importPendingCapture()
        expect(target.addCapture).toHaveBeenCalledExactlyOnceWith({
          ...receipt,
          dataUrl: sourceAsset.dataUrl,
          size: sourceImage.size
        })
        expect(port.previewAsset).toHaveBeenCalledExactlyOnceWith(sourceImage.assetId)
        expect(port.clear).toHaveBeenCalledOnce()
        expect(restored.state.pendingAsset.value).toBeNull()
      }
      expect(port.stageImage).not.toHaveBeenCalled()
      expect(port.releaseAssets).not.toHaveBeenCalled()
      expect(firstPort.clear).not.toHaveBeenCalled()
      expect(firstPort.releaseAssets).not.toHaveBeenCalled()
    }
  )

  it('reports its actual user wait and cancels only the confirmation owned by this delivery', async () => {
    const dialog = await mount('system/EditingDraftDialog.vue')
    window.__prepareEditingDrafts.mockResolvedValue({ dirty: true, blocked: false })
    const form = await mount('capture/CaptureDelivery.vue')
    const receiving = delivery(sourceAsset)
    await flush()
    expect(dialog.state.visible.value).toBe(true)
    expect(window.api.reportScreenshotDelivery.mock.calls.map(([value]) => value.state)).toEqual([
      'received',
      'processing',
      'awaiting-user'
    ])
    rejectDelivery()
    await receiving
    expect(dialog.state.visible.value).toBe(false)
    expect(ports.get('capture:pending-delivery').stageImage).not.toHaveBeenCalled()
    expect(form.state.noteVisible.value).toBe(false)
    expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()
    expect(deliveryStates.size).toBe(0)
  })

  it('does not share or close a navigation confirmation owned by another caller', async () => {
    const dialog = await mount('system/EditingDraftDialog.vue')
    const navigation = window.__confirmEditingDrafts('退出', { owner: 'navigation' })
    expect(window.__confirmEditingDrafts('退出', { owner: 'navigation' })).toBe(navigation)
    window.__prepareEditingDrafts.mockResolvedValue({ dirty: true, blocked: false })
    await mount('capture/CaptureDelivery.vue')
    await delivery(sourceAsset)
    expect(dialog.state.visible.value).toBe(true)
    window.__cancelEditingDraftConfirmation('capture:unrelated')
    expect(dialog.state.visible.value).toBe(true)
    window.__cancelEditingDraftConfirmation('navigation')
    expect(await navigation).toBe(false)
    expect(dialog.state.visible.value).toBe(false)
    expect(ports.get('capture:pending-delivery').stageImage).not.toHaveBeenCalled()
  })

  it('retains the default confirmation cancellation used by the main page-leave owner', async () => {
    const dialog = await mount('system/EditingDraftDialog.vue')
    const confirmation = window.__confirmEditingDrafts('退出')
    window.__cancelEditingDraftConfirmation()
    expect(await confirmation).toBe(false)
    expect(dialog.state.visible.value).toBe(false)
  })

  it('resumes processing after its own actual confirmation before staging the image', async () => {
    const dialog = await mount('system/EditingDraftDialog.vue')
    window.__prepareEditingDrafts.mockResolvedValue({ dirty: true, blocked: false })
    const form = await mount('capture/CaptureDelivery.vue')
    const receiving = delivery(sourceAsset)
    await flush()
    expect(dialog.state.visible.value).toBe(true)
    dialog.state.finish(true)
    await receiving
    expect(window.api.reportScreenshotDelivery.mock.calls.map(([value]) => value.state)).toEqual([
      'received',
      'processing',
      'awaiting-user',
      'processing'
    ])
    expect(form.state.noteVisible.value).toBe(true)
  })

  it('releases a cancelled late stage without publishing a journal or editor', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const staged = deferred()
    port.stageImage.mockReturnValueOnce(staged.promise)
    const receiving = delivery(sourceAsset)
    await flush()
    rejectDelivery()
    staged.resolve(sourceImage)
    await receiving
    expect(port.releaseAssets).toHaveBeenCalledExactlyOnceWith([sourceImage.assetId])
    expect(port.flush).not.toHaveBeenCalled()
    expect(form.state.pendingAsset.value).toBeNull()
    expect(form.state.noteVisible.value).toBe(false)
    expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()
  })

  it('retains a late persisted journal for explicit recovery without opening the expired editor', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const journal = deferred()
    port.flush.mockReturnValueOnce(journal.promise)
    const receiving = delivery(sourceAsset)
    await flush()
    expect(form.state.pendingAsset.value.image).toEqual(sourceImage)
    rejectDelivery()
    journal.resolve({ persisted: true })
    await receiving
    expect(form.state.noteVisible.value).toBe(false)
    expect(form.state.recoveryPending.value).toBe(true)
    expect(form.state.pendingAsset.value.image).toEqual(sourceImage)
    expect(form.state.importError.value).toContain('已暂存')
    expect(port.clear).not.toHaveBeenCalled()
    expect(port.releaseAssets).not.toHaveBeenCalled()
    expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()
    await form.state.recoverPendingCapture()
    expect(form.state.noteVisible.value).toBe(true)
    expect(form.state.recoveryPending.value).toBe(false)
  })

  it('retains the journal without opening an editor when main refuses its final positive ACK', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    window.api.acknowledgeScreenshot.mockResolvedValueOnce(false)
    await delivery(sourceAsset)
    expect(form.state.noteVisible.value).toBe(false)
    expect(form.state.pendingAsset.value.image).toEqual(sourceImage)
    expect(form.state.recoveryPending.value).toBe(true)
    expect(port.releaseAssets).not.toHaveBeenCalled()
    expect(port.clear).not.toHaveBeenCalled()
    expect(window.api.acknowledgeScreenshot).toHaveBeenCalledOnce()
  })

  it('keeps a background journal restored after delivery cancellation for explicit recovery', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const resume = deferred()
    port.resume.mockImplementationOnce(async () => {
      await resume.promise
      form.state.pendingAsset.value = { ...receipt, action: 'background', image: sourceImage }
      await port.options.restoreExtra()
    })
    const receiving = delivery({ ...sourceAsset, action: 'background' })
    await flush()
    rejectDelivery()
    resume.resolve()
    await receiving
    expect(form.state.background.value).toBe('')
    expect(form.state.pendingAsset.value.image).toEqual(sourceImage)
    expect(form.state.recoveryPending.value).toBe(true)
    expect(port.stageImage).not.toHaveBeenCalled()
    expect(port.previewAsset).not.toHaveBeenCalled()
    expect(port.clear).not.toHaveBeenCalled()
    expect(port.releaseAssets).not.toHaveBeenCalled()
    await form.state.recoverPendingCapture()
    expect(form.state.background.value).toBe(sourceAsset.dataUrl)
    expect(port.previewAsset).toHaveBeenCalledExactlyOnceWith(sourceImage.assetId)
    expect(port.stageImage).not.toHaveBeenCalled()
  })

  it('does not revive a pending journal that the user released before a late flush returned', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const journal = deferred()
    port.flush.mockReturnValueOnce(journal.promise)
    const receiving = delivery(sourceAsset)
    await flush()
    rejectDelivery()
    await form.state.clearPending()
    journal.resolve({ persisted: true })
    await receiving
    expect(form.state.pendingAsset.value).toBeNull()
    expect(form.state.noteVisible.value).toBe(false)
    expect(form.state.recoveryPending.value).toBe(false)
  })

  it('does not let an old stage clear a newer generation pending image or receipt', async () => {
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const staged = deferred()
    port.stageImage.mockReturnValueOnce(staged.promise)
    const old = delivery(sourceAsset)
    await flush()
    generation.value++
    await flush()
    const nextAsset = { ...sourceAsset, deliveryId: 'delivery-two' }
    const nextImage = { ...sourceImage, assetId: 'next-pending-image' }
    port.stageImage.mockResolvedValueOnce(nextImage)
    await delivery(nextAsset)
    staged.resolve(sourceImage)
    await old
    expect(form.state.pendingAsset.value).toEqual({
      sessionId: nextAsset.sessionId,
      deliveryId: nextAsset.deliveryId,
      action: 'note',
      image: nextImage
    })
    expect(form.state.noteVisible.value).toBe(true)
    expect(port.releaseAssets).toHaveBeenCalledExactlyOnceWith([sourceImage.assetId])
  })

  it.each(['opened', 'retry'])(
    'retains ambiguous legacy sources without importing through the %s entry',
    async (entry) => {
      const conflict = '检测到两份旧截图草稿，无法确认是否已交接，原始记录已保留，暂不能重复加载。'
      getLegacyCaptureConflict.mockReturnValue(conflict)
      const { state } = await mount('capture/CaptureDelivery.vue')
      const port = ports.get('capture:pending-delivery')
      expect(state.noteVisible.value).toBe(true)
      expect(state.importError.value).toBe(conflict)
      expect(state.legacyCaptureConflict.value).toBe(conflict)
      const originalPending = { ...receipt, action: 'note', image: sourceImage }
      const target = {
        draftState: vi.fn(),
        hasCapture: vi.fn(),
        addCapture: vi.fn(),
        discard: vi.fn()
      }
      state.pendingAsset.value = originalPending
      state.noteRef.value = target
      const source = readFileSync(
        new URL('../src/renderer/src/components/capture/CaptureDelivery.vue', import.meta.url),
        'utf8'
      )
      const template = parse(source).descriptor.template.content
      const binding =
        entry === 'opened'
          ? template.match(/@opened="([^"]+)"/)
          : template.match(/<button[\s\S]*?@click="([^"]+)"/)
      expect(binding?.[1]).toBe('importPendingCapture')
      await state[binding[1]]()
      expect(state.pendingAsset.value).toEqual(originalPending)
      expect(state.noteVisible.value).toBe(true)
      expect(state.importError.value).toBe(conflict)
      expect(state.importing.value).toBe(false)
      expect(port.resume).not.toHaveBeenCalled()
      expect(port.stageImage).not.toHaveBeenCalled()
      expect(port.previewAsset).not.toHaveBeenCalled()
      expect(port.flush).not.toHaveBeenCalled()
      expect(port.clear).not.toHaveBeenCalled()
      for (const method of Object.values(target)) expect(method).not.toHaveBeenCalled()
      expect(template).toContain(':disabled="importing || !!legacyCaptureConflict"')
      expect(template).toContain('v-if="noteVisible && !legacyCaptureConflict"')
    }
  )

  it('preserves pending ownership when the target refuses discard during an unconfirmed commit', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    state.pendingAsset.value = { ...receipt, action: 'note', image: sourceImage }
    state.noteVisible.value = true
    state.noteRef.value = { discard: vi.fn(async () => false) }
    await state.discard()
    expect(state.noteVisible.value).toBe(true)
    expect(state.pendingAsset.value).not.toBeNull()
    expect(port.clear).not.toHaveBeenCalled()
  })

  it('reports completed creation even if post-commit pending cleanup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const form = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    form.state.noteVisible.value = true
    port.clear.mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(form.state.created()).resolves.toBeUndefined()
    expect(form.state.noteVisible.value).toBe(false)
    expect(form.emitted).toEqual([['created']])
    expect(showMessage).toHaveBeenCalledWith('warning', expect.stringContaining('便签已创建'))
  })

  it('retains the pending source while the mounted target is still restoring its journal', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    state.pendingAsset.value = { ...receipt, action: 'note', image: sourceImage }
    state.noteVisible.value = true
    const target = {
      draftState: vi.fn(async () => ({ persisted: false, blocked: true })),
      hasCapture: vi.fn(),
      addCapture: vi.fn()
    }
    state.noteRef.value = target
    await state.importPendingCapture()
    expect(state.pendingAsset.value).not.toBeNull()
    expect(state.importError.value).toContain('仍在恢复')
    expect(port.clear).not.toHaveBeenCalled()
    expect(port.previewAsset).not.toHaveBeenCalled()
    expect(target.addCapture).not.toHaveBeenCalled()
  })

  it('waits for staging and durable metadata before its positive ACK', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    const staged = deferred(),
      persisted = deferred()
    port.stageImage.mockReturnValueOnce(staged.promise)
    port.flush.mockReturnValueOnce(persisted.promise)
    const receiving = delivery(sourceAsset)
    await flush()
    expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()
    staged.resolve(sourceImage)
    await flush()
    expect(state.pendingAsset.value).toEqual({ ...receipt, action: 'note', image: sourceImage })
    expect(JSON.stringify(state.pendingAsset.value)).not.toContain('dataUrl')
    expect(window.api.acknowledgeScreenshot).not.toHaveBeenCalled()
    persisted.resolve({ dirty: true, blocked: true, persisted: true })
    await receiving
    expect(window.api.acknowledgeScreenshot).toHaveBeenCalledExactlyOnceWith({
      ...receipt,
      accepted: true,
      message: ''
    })
    expect(state.noteVisible.value).toBe(true)
  })

  it('rejects late receipt completion after data clear without recreating its pending draft', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery'),
      staged = deferred()
    port.stageImage.mockReturnValueOnce(staged.promise)
    const receiving = delivery(sourceAsset)
    await flush()
    generation.value++
    await flush()
    staged.resolve(sourceImage)
    await receiving
    expect(state.pendingAsset.value).toBeNull()
    expect(state.noteVisible.value).toBe(false)
    expect(port.flush).not.toHaveBeenCalled()
    expect(window.api.acknowledgeScreenshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...receipt,
        accepted: false
      })
    )
  })

  it('keeps the original pending owner on target persistence failure and retries without adding twice', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery')
    state.pendingAsset.value = { ...receipt, action: 'note', image: sourceImage }
    state.noteVisible.value = true
    let imported = false
    const target = {
      draftState: vi.fn(async () => ({ dirty: true, blocked: false, persisted: true })),
      hasCapture: vi.fn(() => imported),
      addCapture: vi.fn(async () => {
        imported = true
        return true
      })
    }
    target.draftState
      .mockResolvedValueOnce({ persisted: true })
      .mockResolvedValueOnce({ persisted: false })
    state.noteRef.value = target
    await state.importPendingCapture()
    expect(state.pendingAsset.value).not.toBeNull()
    expect(port.clear).not.toHaveBeenCalled()
    expect(state.importError.value).toContain('草稿暂存失败')
    await state.importPendingCapture()
    expect(target.addCapture).toHaveBeenCalledOnce()
    expect(port.previewAsset).toHaveBeenCalledOnce()
    expect(port.clear).toHaveBeenCalledOnce()
    expect(state.pendingAsset.value).toBeNull()
  })

  it('releases the pending owner only after the restored target confirms its receipt', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery'),
      release = deferred(),
      durable = deferred()
    state.pendingAsset.value = { ...receipt, action: 'note', image: sourceImage }
    state.noteVisible.value = true
    const target = {
      hasCapture: vi.fn(() => true),
      addCapture: vi.fn(),
      draftState: vi.fn(async () => ({ persisted: true }))
    }
    target.draftState
      .mockResolvedValueOnce({ persisted: true })
      .mockReturnValueOnce(durable.promise)
    port.clear.mockReturnValueOnce(release.promise)
    state.noteRef.value = target
    const importing = state.importPendingCapture()
    await flush()
    expect(port.clear).not.toHaveBeenCalled()
    durable.resolve({ persisted: true, blocked: false })
    await flush()
    expect(port.clear).toHaveBeenCalledOnce()
    expect(state.pendingAsset.value).not.toBeNull()
    // The target is already durable, but receiver ownership cleanup still blocks
    // page leave. A visible thumbnail or positive native ACK is not this barrier.
    expect(state.importing.value).toBe(true)
    expect(port.options.busy()).toBe(true)
    expect(await port.flush()).toMatchObject({ blocked: true })
    release.resolve(true)
    await importing
    expect(state.pendingAsset.value).toBeNull()
    expect(state.legacyCaptureConflict.value).toBeNull()
    expect(state.importing.value).toBe(false)
    expect(port.options.busy()).toBe(false)
    expect(await port.flush()).toMatchObject({ blocked: false })
    expect(target.addCapture).not.toHaveBeenCalled()
    expect(port.previewAsset).not.toHaveBeenCalled()
  })

  it('waits for both asynchronous discards before closing the capture editor', async () => {
    const { state } = await mount('capture/CaptureDelivery.vue')
    const port = ports.get('capture:pending-delivery'),
      sourceClear = deferred(),
      targetClear = deferred()
    state.noteVisible.value = true
    port.clear.mockReturnValueOnce(sourceClear.promise)
    state.noteRef.value = { discard: vi.fn(() => targetClear.promise) }
    const discarding = state.discard()
    expect(state.noteVisible.value).toBe(true)
    sourceClear.resolve(true)
    await flush()
    expect(state.noteVisible.value).toBe(true)
    targetClear.resolve(true)
    await discarding
    expect(state.noteVisible.value).toBe(false)
  })
})
