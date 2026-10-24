import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Run the real SFC setup/lifecycle. Child UI and animations are isolated so a
// delayed IPC result can be resumed precisely before or after Vue unmounts.
async function loadComponent(path) {
  const url = new URL('../src/renderer/src/components/' + path, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  let code = compileScript(descriptor, { id: 'renderer-resource-lifecycle' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/modalBlur.js')) dependency = { retainModalBlur: () => vi.fn() }
    else if (name.endsWith('/modalQueue.js')) dependency = { modalQueue: { hold: () => vi.fn() } }
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
    else if (name.endsWith('/useDraftProtection.js'))
      // This suite owns TemplatePage's subscriptions, not the browser journal.
      // The page imports only this reactive invalidation signal.
      dependency = { editingDataGeneration: vue.ref(0) }
    else if (name.endsWith('/useQueuedModal.js'))
      dependency = {
        useQueuedModal: (requested) => ({
          visible: vue.computed(() => Boolean(requested.value)),
          finishLeave() {}
        })
      }
    else if (name.endsWith('/useNotePresenceMotion.js'))
      dependency = {
        useNotePresenceMotion: () => ({
          captureVisibleCardLayout: () => new Map(),
          animateRetainedCards() {},
          animateAuxiliaryIn() {},
          cancelCurrentPresenceExits() {},
          animateCurrentCardsOut: async () => {},
          disposePresenceMotion() {}
        })
      }
    else if (name.endsWith('/modalFocus.js'))
      dependency = {
        captureFocusedElement: () => null,
        focusModal() {},
        restoreFocusedElement() {},
        trapModalTab() {}
      }
    else dependency = await import(new URL(name, url).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name} = dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}

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
const apps = new Set()
function mount(component, initialProps = {}) {
  const props = vue.reactive(initialProps)
  let state
  const wrapped = {
    ...component,
    setup(componentProps, context) {
      state = component.setup(componentProps, context)
      return state
    },
    render: () => vue.h('div')
  }
  const app = renderer.createApp({
    setup: () => () => vue.h(wrapped, { ...props })
  })
  app.mount({})
  apps.add(app)
  return {
    props,
    get state() {
      return state
    },
    unmount() {
      if (apps.delete(app)) app.unmount()
    }
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function flush() {
  for (let index = 0; index < 12; index++) await vue.nextTick()
}
function eventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener)
      if (!listeners.get(name)?.size) listeners.delete(name)
    },
    listenerCount: () => [...listeners.values()].reduce((count, values) => count + values.size, 0)
  }
}
let observers
let api
let templateListeners
beforeEach(() => {
  observers = []
  templateListeners = new Set()
  api = {
    listTemplates: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    onTemplatesChanged: vi.fn((listener) => {
      templateListeners.add(listener)
      return () => templateListeners.delete(listener)
    }),
    listImages: vi.fn(async () =>
      Array.from({ length: 4 }, (_, index) => ({ id: index + 1, file_path: 'image-' + index }))
    ),
    getImageThumbnail: vi.fn(async (path) => 'thumbnail:' + path),
    getImageDimensions: vi.fn(async () => ({ width: 128, height: 128 })),
    getImageThumbnailDetails: vi.fn(async (path) => ({
      data: 'thumbnail:' + path,
      width: 128,
      height: 128
    })),
    getImageBase64: vi.fn(async (path) => 'original:' + path),
    saveImages: vi.fn(async () => [{ id: 100, file_path: 'saved-100', file_size: 3 }])
  }
  vi.stubGlobal('window', { ...eventTarget(), api, innerWidth: 1000, innerHeight: 700 })
  vi.stubGlobal('document', { ...eventTarget(), body: {}, activeElement: null })
  vi.stubGlobal(
    'FileReader',
    class {
      readAsDataURL(file) {
        this.result = file.dataUrl
        queueMicrotask(() => this.onload())
      }
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor() {
        this.disconnected = false
        observers.push(this)
      }
      observe() {}
      disconnect() {
        this.disconnected = true
      }
    }
  )
})
afterEach(async () => {
  for (const app of apps) app.unmount()
  apps.clear()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('template page resource lifetime', () => {
  it('does not register observers or listeners when repeated initial loads finish after unmount', async () => {
    const component = await loadComponent('template/TemplatePage.vue')
    for (let cycle = 0; cycle < 20; cycle++) {
      const read = deferred()
      api.listTemplates.mockReturnValueOnce(read.promise)
      const page = mount(component)
      page.unmount()
      read.resolve([])
      await flush()
    }
    expect(api.listTemplates).toHaveBeenCalledTimes(20)
    expect(api.onTemplatesChanged).not.toHaveBeenCalled()
    expect(templateListeners.size).toBe(0)
    expect(observers).toHaveLength(0)
  })

  it('keeps one live subscription and releases it while an ordinary refresh is still pending', async () => {
    const page = mount(await loadComponent('template/TemplatePage.vue'))
    await flush()
    expect(templateListeners.size).toBe(1)
    const read = deferred()
    api.listTemplates.mockReturnValueOnce(read.promise)
    for (const listener of templateListeners) listener()
    expect(api.listTemplates).toHaveBeenCalledTimes(2)
    page.unmount()
    read.resolve([])
    await flush()
    expect(templateListeners.size).toBe(0)
    expect(observers.every((observer) => observer.disconnected)).toBe(true)
    await page.state.refreshInBackground()
    expect(api.listTemplates).toHaveBeenCalledTimes(2)
  })
})

describe('text-color popover listener lifetime', () => {
  async function colorPopover() {
    const popover = mount(await loadComponent('note/NoteTextColorPopover.vue'), {
      visible: false,
      anchorRect: { left: 100, top: 100, bottom: 120, width: 40 }
    })
    popover.state.popoverRef.value = {
      getBoundingClientRect: () => ({ width: 200, height: 100 })
    }
    return popover
  }
  const count = () => document.listenerCount() + window.listenerCount()

  it('cancels listener installation when unmount interrupts nextTick positioning', async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const popover = await colorPopover()
      popover.props.visible = true
      await vue.nextTick()
      popover.unmount()
      await flush()
      expect(count()).toBe(0)
    }
  })

  it('cancels a pending open and keeps exactly four listeners through repeated valid opens', async () => {
    const popover = await colorPopover()
    popover.props.visible = true
    await vue.nextTick()
    popover.props.visible = false
    await flush()
    expect(count()).toBe(0)
    for (let cycle = 0; cycle < 20; cycle++) {
      popover.props.visible = true
      await flush()
      expect(count()).toBe(4)
      popover.props.visible = false
      await flush()
      expect(count()).toBe(0)
    }
  })
})

describe('image original preview lifetime', () => {
  async function picker(props = { noteId: 1, mode: 'persist', readonly: true }) {
    const result = mount(await loadComponent('note/ImagePicker.vue'), props)
    await flush()
    return result
  }
  function expectClosed(state) {
    expect(state.previewVisible.value).toBe(false)
    expect(state.previewSources.value).toEqual([])
  }
  async function preview(initial = {}) {
    const releases = []
    const resolveSource = vi.fn(async (index) => {
      const release = vi.fn()
      releases.push({ index, release })
      return { src: 'original:' + index, release }
    })
    const page = mount(await loadComponent('note/ImagePreview.vue'), {
      visible: true,
      src: '',
      sources: ['thumb:0', 'thumb:1', 'thumb:2', 'thumb:3'],
      initialIndex: 0,
      resolveSource,
      ...initial
    })
    await flush()
    return { ...page, resolveSource, releases }
  }
  function node(state) {
    const element = {
      dataset: { previewLease: String(state.activeEntry.value.id) },
      isConnected: true
    }
    state.bindImage(element)
    return element
  }

  it('opens with the final sources and initial index when visible is patched first in the same Vue update', async () => {
    const page = await preview({ visible: false, sources: ['thumb:0', 'thumb:1', 'thumb:2'] })
    page.props.visible = true
    page.props.sources = ['thumb:0', 'thumb:1', 'thumb:2', 'thumb:3']
    page.props.initialIndex = 3
    await flush()
    expect(page.resolveSource.mock.calls.map(([index]) => index)).toEqual([3])
    expect(page.state.activeEntry.value.index).toBe(3)
    expect(page.state.activeEntry.value.src).toBe('original:3')
  })

  it.each(['close', 'unmount'])('does not start a scheduled opening after %s', async (action) => {
    const page = await preview({ visible: false })
    page.props.visible = true
    // The parent update has patched visible, while the deferred open still
    // belongs to the nextTick continuation registered by the child watcher.
    await vue.nextTick()
    if (action === 'close') {
      page.state.closeSession()
      page.props.visible = false
    } else page.unmount()
    await flush()
    expect(page.resolveSource).not.toHaveBeenCalled()
    expect(page.state.renderOpen.value).toBe(false)
  })

  it('keeps picker models at thumbnails and reads the original only through the display resolver', async () => {
    const { state } = await picker()
    for (let cycle = 0; cycle < 20; cycle++) {
      for (const image of state.images.value) {
        state.handlePreview(image)
        const source = await state.resolvePreviewSource(state.images.value.indexOf(image))
        expect(source.src).toBe('original:' + image.filePath)
        expect(state.previewSources.value.every((src) => src.startsWith('thumbnail:'))).toBe(true)
        expect(state.images.value.every((item) => !item.fullDataUrl)).toBe(true)
        source.release()
        state.closePreview()
        expectClosed(state)
      }
    }
    expect(state.images.value.map((image) => image.dataUrl)).toEqual([
      'thumbnail:image-0',
      'thumbnail:image-1',
      'thumbnail:image-2',
      'thumbnail:image-3'
    ])
  })

  it.each(['close', 'unmount', 'note-change', 'clear'])(
    'rejects an original from the old picker after %s',
    async (action) => {
      const page = await picker()
      const read = deferred()
      api.getImageBase64.mockReturnValueOnce(read.promise)
      page.state.handlePreview(page.state.images.value[0])
      const pending = page.state.resolvePreviewSource(0)
      const rejected = expect(pending).rejects.toThrow('图片预览已失效')
      if (action === 'close') page.state.closePreview()
      else if (action === 'unmount') page.unmount()
      else if (action === 'clear') page.state.clearImages()
      else {
        page.props.noteId = 2
        await flush()
      }
      read.resolve('original:old-note')
      await rejected
      expectClosed(page.state)
    }
  )

  it('holds connected leaving nodes and coalesces navigation without preparing a third original', async () => {
    const page = await preview()
    const first = node(page.state)
    page.state.showNext()
    await flush()
    node(page.state)
    expect(page.resolveSource.mock.calls.map(([index]) => index)).toEqual([0, 1])
    page.state.showNext()
    page.state.showNext()
    await flush()
    expect(page.resolveSource).toHaveBeenCalledTimes(2)
    await page.state.imageLeft(first) // A cancelled leave with a still-connected node.
    expect(page.releases[0].release).not.toHaveBeenCalled()
    expect(page.resolveSource).toHaveBeenCalledTimes(2)
    first.isConnected = false
    await page.state.imageLeft(first)
    await flush()
    expect(page.resolveSource.mock.calls.map(([index]) => index)).toEqual([0, 1, 3])
    expect(page.releases[0].release).toHaveBeenCalledOnce()
    expect(page.state.leases.size).toBe(2)
  })

  it('drops a superseded prepared result and serves only the latest intent', async () => {
    const page = await preview()
    node(page.state)
    const held = deferred()
    page.resolveSource.mockReturnValueOnce(held.promise)
    page.state.showNext()
    await flush()
    page.state.showNext()
    page.state.showNext()
    expect(page.resolveSource).toHaveBeenCalledTimes(2)
    const release = vi.fn()
    held.resolve({ src: 'original:obsolete', release })
    await flush()
    expect(release).toHaveBeenCalledOnce()
    expect(page.resolveSource.mock.calls.map(([index]) => index)).toEqual([0, 1, 3])
    expect(page.state.activeEntry.value.src).toBe('original:3')
  })

  it('does not call a deferred navigation resolver after a close in the same handler', async () => {
    const page = await preview()
    const first = node(page.state)
    page.state.showNext()
    page.state.onClose()
    await flush()
    expect(page.resolveSource.mock.calls.map(([index]) => index)).toEqual([0])
    expect(page.state.renderOpen.value).toBe(false)
    page.props.visible = false
    first.isConnected = false
    await page.state.overlayLeft()
    expect(page.releases[0].release).toHaveBeenCalledOnce()
  })

  it('serializes close/reopen behind actual overlay removal and ignores its late prepare', async () => {
    const page = await preview()
    const first = node(page.state)
    const held = deferred()
    page.resolveSource.mockReturnValueOnce(held.promise)
    page.state.showNext()
    await flush()
    page.props.visible = false
    await flush()
    page.props.visible = true
    await flush()
    expect(page.releases[0].release).not.toHaveBeenCalled()
    expect(page.resolveSource).toHaveBeenCalledTimes(2)
    first.isConnected = false
    await page.state.overlayLeft()
    const release = vi.fn()
    held.resolve({ src: 'original:closed-session', release })
    await flush()
    expect(release).toHaveBeenCalledOnce()
    expect(page.state.activeEntry.value.src).toBe('original:0')
    expect(page.resolveSource).toHaveBeenCalledTimes(3)
    expect(page.releases[0].release).toHaveBeenCalledOnce()
  })

  it('preserves the wallpaper legacy single-source path and transform controls', async () => {
    const page = await preview({ resolveSource: null, sources: [], src: 'wallpaper:original' })
    expect(page.state.activeSrc.value).toBe('wallpaper:original')
    const event = { deltaY: -1, preventDefault: vi.fn() }
    page.state.onWheel(event)
    page.state.rotate90()
    expect(page.state.scale.value).toBe(1.1)
    expect(page.state.rotate.value).toBe(90)
    page.state.reset()
    expect(page.state.scale.value).toBe(1)
    expect(page.state.rotate.value).toBe(0)
    page.state.onMouseDown({ button: 0, clientX: 10, clientY: 20, preventDefault() {} })
    expect(document.listenerCount()).toBe(2)
    page.state.onKeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    expect(document.listenerCount()).toBe(0)
    page.props.visible = false
    page.props.src = ''
    await flush()
    expect(page.state.activeSrc.value).toBe('wallpaper:original')
    await page.state.overlayLeft()
    expect(page.state.activeSrc.value).toBe('')
  })

  it('preserves draft asset metadata and uses a non-consuming preview lease', async () => {
    const metadata = {
      assetId: 'draft-asset',
      ext: 'png',
      name: 'draft.png',
      size: 3,
      sha256: 'a'.repeat(64)
    }
    const imageGeneration = vue.ref(0)
    const assetPort = {
      imageGeneration,
      stageImage: vi.fn(async () => metadata),
      thumbnailAsset: vi.fn(async () => ({ data: 'thumbnail:draft', width: 128, height: 128 })),
      previewAsset: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), ext: 'png' })),
      releaseAssets: vi.fn(async () => true),
      flush: vi.fn(async () => ({ dirty: true, blocked: false, persisted: true }))
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-original')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { state } = await picker({ mode: 'memory', noteId: null, assetPort })
    await state.addImage('data:image/png;base64,AQID', 'png', 'draft.png', 3)
    state.handlePreview(state.images.value[0])
    const lease = await state.resolvePreviewSource(0)
    expect(state.previewSources.value).toEqual(['thumbnail:draft'])
    imageGeneration.value++
    await flush()
    expectClosed(state)
    expect(revoke).not.toHaveBeenCalled()
    lease.release()
    expect(revoke).toHaveBeenCalledWith('blob:draft-original')
    expect(state.getImages()).toEqual([metadata])
    expect(assetPort.releaseAssets).not.toHaveBeenCalled()
    expect(api.getImageBase64).not.toHaveBeenCalled()
  })

  const upload = (state, method) => {
    const dataUrl = 'data:image/png;base64,AQID'
    return method === 'file'
      ? state.processFiles([{ name: 'upload.png', size: 3, type: 'image/png', dataUrl }])
      : state.addImage(dataUrl, 'png', 'upload.png', 3)
  }
  const writablePicker = () => picker({ noteId: 1, mode: 'persist', readonly: false })

  it.each(['file', 'capture'])(
    'replaces the %s upload original with a stored thumbnail and preview path',
    async (method) => {
      const { state } = await writablePicker()
      const result = await upload(state, method)
      if (method === 'capture') expect(result).toBe(true)
      expect(api.saveImages).toHaveBeenCalledWith(1, [{ base64: 'AQID', ext: 'png' }])
      const saved = state.images.value.find((image) => image.id === 100)
      expect(saved).toMatchObject({
        saved: true,
        dataUrl: 'thumbnail:saved-100',
        filePath: 'saved-100'
      })
      expect(
        state.images.value.some((image) => image.dataUrl === 'data:image/png;base64,AQID')
      ).toBe(false)
      expect(state.busy.value).toBe(false)
      await state.handlePreview(saved)
      expect(
        (
          await state.resolvePreviewSource(
            state.images.value.findIndex((image) => image.id === 100)
          )
        ).src
      ).toBe('original:saved-100')
      state.closePreview()
      expectClosed(state)
    }
  )

  it.each(['file', 'capture'])(
    'keeps a successfully saved %s attachment when thumbnail and dimension reads fail',
    async (method) => {
      const { state } = await writablePicker()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      api.getImageThumbnailDetails.mockRejectedValueOnce(new Error('derived image unavailable'))
      const result = await upload(state, method)
      if (method === 'capture') expect(result).toBe(true)
      expect(state.images.value.find((image) => image.id === 100)).toMatchObject({
        saved: true,
        dataUrl: '',
        filePath: 'saved-100'
      })
      expect(state.images.value).toHaveLength(5)
      expect(state.busy.value).toBe(false)
      expect(errorLog).not.toHaveBeenCalled()
      await state.handlePreview(state.images.value.find((image) => image.id === 100))
      expect(
        (
          await state.resolvePreviewSource(
            state.images.value.findIndex((image) => image.id === 100)
          )
        ).src
      ).toBe('original:saved-100')
    }
  )

  it.each(
    ['file', 'capture'].flatMap((method) =>
      ['save', 'thumbnail'].flatMap((stage) =>
        ['clear', 'unmount', 'note-change'].map((action) => [method, stage, action])
      )
    )
  )('does not apply a late %s upload at %s after %s', async (method, stage, action) => {
    const page = await writablePicker()
    const delayed = deferred()
    if (stage === 'save') api.saveImages.mockReturnValueOnce(delayed.promise)
    else api.getImageThumbnailDetails.mockReturnValueOnce(delayed.promise)
    const pending = upload(page.state, method)
    await flush()
    expect(api.saveImages).toHaveBeenCalledTimes(1)
    if (stage === 'thumbnail')
      expect(api.getImageThumbnailDetails).toHaveBeenCalledWith('saved-100', 512)
    if (action === 'clear') page.state.clearImages()
    else if (action === 'unmount') page.unmount()
    else {
      page.props.noteId = 2
      await flush()
    }
    delayed.resolve(
      stage === 'save'
        ? [{ id: 100, file_path: 'saved-100', file_size: 3 }]
        : { data: 'thumbnail:saved-100', width: 128, height: 128 }
    )
    const result = await pending
    if (method === 'capture') expect(result).toBe(true)
    expect(page.state.images.value.some((image) => image.id === 100)).toBe(false)
    if (action === 'clear') {
      expect(page.state.images.value).toEqual([])
      expect(page.state.busy.value).toBe(false)
    }
  })

  it.each([false, true])(
    'preserves every upload through a same-note refresh (late list: %s)',
    async (lateList) => {
      const page = await writablePicker()
      const stored = []
      const listing = deferred()
      let listedRecords
      api.saveImages.mockImplementation(async () => {
        const record = { id: 100 + stored.length, file_path: 'saved-' + (100 + stored.length) }
        stored.push(record)
        return [record]
      })
      api.listImages.mockImplementation(async () => {
        listedRecords = [
          ...Array.from({ length: 4 }, (_, index) => ({
            id: index + 1,
            file_path: 'image-' + index
          })),
          ...stored
        ]
        return lateList ? listing.promise : listedRecords
      })
      const thumbnail = deferred()
      api.getImageThumbnailDetails.mockImplementation((path) =>
        path === 'saved-100'
          ? thumbnail.promise
          : Promise.resolve({ data: 'thumbnail:' + path, width: 128, height: 128 })
      )
      const pending = page.state.processFiles([
        { name: 'one.png', size: 3, dataUrl: 'data:image/png;base64,AQID' },
        { name: 'two.png', size: 3, dataUrl: 'data:image/png;base64,BAUG' }
      ])
      await flush()
      page.props.refreshKey = 'save-broadcast'
      await vue.nextTick()
      thumbnail.resolve({ data: 'thumbnail:saved-100', width: 128, height: 128 })
      await pending
      if (lateList) listing.resolve(listedRecords)
      await flush()
      expect(api.saveImages).toHaveBeenCalledTimes(2)
      expect(page.state.images.value.map((image) => image.id).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 100, 101
      ])
      expect(page.state.busy.value).toBe(false)
    }
  )
})
