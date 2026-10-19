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
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
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
  const originals = (state) =>
    state.previewSources.value.filter((src) => src.startsWith('original:'))
  function expectClosed(state) {
    expect(state.previewVisible.value).toBe(false)
    expect(state.previewSources.value).toEqual([])
  }

  it('keeps only the current original and releases it on every close without changing thumbnails', async () => {
    const { state } = await picker()
    for (let cycle = 0; cycle < 20; cycle++) {
      for (const image of state.images.value) {
        await state.handlePreview(image)
        expect(state.previewVisible.value).toBe(true)
        expect(originals(state)).toHaveLength(1)
        expect(state.images.value.every((item) => !item.fullDataUrl)).toBe(true)
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
    'ignores a late original after %s',
    async (action) => {
      const page = await picker()
      const read = deferred()
      api.getImageBase64.mockReturnValueOnce(read.promise)
      const preview = page.state.handlePreview(page.state.images.value[0])
      if (action === 'close') page.state.closePreview()
      else if (action === 'unmount') page.unmount()
      else if (action === 'clear') page.state.clearImages()
      else {
        page.props.noteId = 2
        await flush()
      }
      read.resolve('original:old-note')
      await preview
      await flush()
      expectClosed(page.state)
      expect(page.state.images.value.every((image) => !image.fullDataUrl)).toBe(true)
    }
  )

  it('does not reopen when close falls between the original completion and opening continuation', async () => {
    const { state } = await picker()
    const read = deferred()
    api.getImageBase64.mockReturnValueOnce(read.promise)
    const preview = state.handlePreview(state.images.value[0])
    void read.promise.then(() => state.closePreview())
    read.resolve('original:late')
    await preview
    expectClosed(state)
  })

  it('coalesces navigation behind one original read and drops superseded targets', async () => {
    const { state } = await picker()
    await state.handlePreview(state.images.value[0])
    const read = deferred()
    api.getImageBase64.mockReturnValueOnce(read.promise)
    state.onPreviewChange(1)
    state.onPreviewChange(2)
    state.onPreviewChange(3)
    expect(api.getImageBase64).toHaveBeenCalledTimes(2)
    read.resolve('original:image-1')
    await flush()
    expect(api.getImageBase64.mock.calls.map(([path]) => path)).toEqual([
      'image-0',
      'image-1',
      'image-3'
    ])
    expect(originals(state)).toEqual(['original:image-3'])
    expect(state.previewIndex.value).toBe(3)
  })

  it('does not let a closed session overwrite a new preview waiting for its read', async () => {
    const { state } = await picker()
    const read = deferred()
    api.getImageBase64.mockReturnValueOnce(read.promise)
    const oldPreview = state.handlePreview(state.images.value[0])
    state.closePreview()
    const nextPreview = state.handlePreview(state.images.value[2])
    expect(api.getImageBase64).toHaveBeenCalledTimes(1)
    read.resolve('original:old-session')
    await Promise.all([oldPreview, nextPreview])
    expect(state.previewVisible.value).toBe(true)
    expect(originals(state)).toEqual(['original:image-2'])
    expect(state.previewIndex.value).toBe(2)
  })

  it('preserves draft image data and can reopen it without reading a stored original', async () => {
    const { state } = await picker({ mode: 'memory', noteId: null })
    const dataUrl = 'data:image/png;base64,AQID'
    await state.addImage(dataUrl, 'png', 'draft.png', 3)
    await state.handlePreview(state.images.value[0])
    expect(state.previewSources.value).toEqual([dataUrl])
    state.closePreview()
    expectClosed(state)
    expect(state.getImages()).toEqual([{ base64: 'AQID', ext: 'png', name: 'draft.png', size: 3 }])
    expect(state.images.value[0].dataUrl).toBe(dataUrl)
    await state.handlePreview(state.images.value[0])
    expect(state.previewVisible.value).toBe(true)
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
      expect(originals(state)).toEqual(['original:saved-100'])
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
      api.getImageThumbnail.mockRejectedValueOnce(new Error('thumbnail unavailable'))
      api.getImageDimensions.mockRejectedValueOnce(new Error('dimensions unavailable'))
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
      expect(originals(state)).toEqual(['original:saved-100'])
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
    else api.getImageThumbnail.mockReturnValueOnce(delayed.promise)
    const pending = upload(page.state, method)
    await flush()
    expect(api.saveImages).toHaveBeenCalledTimes(1)
    if (stage === 'thumbnail') expect(api.getImageThumbnail).toHaveBeenCalledWith('saved-100', 512)
    if (action === 'clear') page.state.clearImages()
    else if (action === 'unmount') page.unmount()
    else {
      page.props.noteId = 2
      await flush()
    }
    delayed.resolve(
      stage === 'save' ? [{ id: 100, file_path: 'saved-100', file_size: 3 }] : 'thumbnail:saved-100'
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
      api.getImageThumbnail.mockImplementation((path) =>
        path === 'saved-100' ? thumbnail.promise : Promise.resolve('thumbnail:' + path)
      )
      const pending = page.state.processFiles([
        { name: 'one.png', size: 3, dataUrl: 'data:image/png;base64,AQID' },
        { name: 'two.png', size: 3, dataUrl: 'data:image/png;base64,BAUG' }
      ])
      await flush()
      page.props.refreshKey = 'save-broadcast'
      await vue.nextTick()
      thumbnail.resolve('thumbnail:saved-100')
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
