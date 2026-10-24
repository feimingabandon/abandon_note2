import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

// Exercise the real setup/lifecycle while controlling asynchronous file/IPC
// boundaries. The existing Electron product suite owns actual image decoding.
async function component(name) {
  const url = new URL('../src/renderer/src/components/note/' + name + '.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  let code = compileScript(descriptor, { id: 'image-picker-draft-assets' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    const dependency =
      name === 'vue'
        ? vue
        : name.endsWith('.vue')
          ? { default: {} }
          : name.endsWith('/useMessage.js')
            ? { useMessage: () => ({ showMessage: messages }) }
            : await import(new URL(name, url).href)
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
async function mount(name = 'ImagePicker', initial = {}) {
  const loaded = await component(name)
  const props = vue.reactive({ mode: 'memory', assetPort: port(), ...initial })
  const busy = []
  const counts = []
  let state
  const wrapped = {
    ...loaded,
    setup(p, context) {
      state = loaded.setup(p, context)
      return state
    },
    render: () => vue.h('div')
  }
  const app = renderer.createApp({
    setup: () => () =>
      vue.h(wrapped, {
        ...props,
        onBusyChange: (value) => busy.push(value),
        onCountChange: (value) => counts.push(value)
      })
  })
  app.mount({})
  apps.add(app)
  await flush()
  return {
    props,
    state,
    busy,
    counts,
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
  for (let i = 0; i < 12; i++) await vue.nextTick()
}
const metadata = (assetId = 'asset-1', name = 'draft.png') => ({
  assetId,
  ext: 'png',
  name,
  size: 3,
  sha256: 'a'.repeat(64)
})
const payload = () => ({
  bytes: new Uint8Array([1, 2, 3]),
  ext: 'png',
  size: 3,
  sha256: 'a'.repeat(64)
})
function port() {
  let next = 0
  return {
    stageImage: vi.fn(async (image) => metadata('asset-' + ++next, image.name)),
    previewAsset: vi.fn(async () => payload()),
    thumbnailAsset: vi.fn(async () => thumbnail()),
    releaseAssets: vi.fn(async () => true),
    flush: vi.fn(async () => ({ dirty: true, blocked: true, persisted: true }))
  }
}
const thumbnail = () => ({ data: 'data:image/png;base64,dGh1bWJuYWls', width: 1024, height: 768 })
const dataUrl = 'data:image/png;base64,AQID'
const add = (state, options) => state.addImage(dataUrl, 'png', 'draft.png', 3, options)
let api,
  messages,
  canvases,
  bitmaps,
  createUrl,
  revokeUrl,
  deliveryListener,
  finishedListener,
  deliveryStates
beforeEach(() => {
  deliveryStates = new Set()
  messages = vi.fn()
  canvases = []
  bitmaps = []
  deliveryListener = null
  finishedListener = null
  api = {
    listImages: vi.fn(async () => []),
    getImageThumbnail: vi.fn(async (path) => 'thumbnail:' + path),
    getImageDimensions: vi.fn(async () => ({ width: 100, height: 60 })),
    getImageThumbnailDetails: vi.fn(async (path) => ({
      data: 'thumbnail:' + path,
      width: 100,
      height: 60
    })),
    getImageBase64: vi.fn(async (path) => 'original:' + path),
    saveImages: vi.fn(async () => [{ id: 100, file_path: 'saved-100', file_size: 3 }]),
    deleteImage: vi.fn(async () => true),
    onScreenshotReady: vi.fn(() => vi.fn()),
    onScreenshotDelivery: vi.fn((listener) => {
      deliveryListener = listener
      return vi.fn()
    }),
    onScreenshotFinished: vi.fn((listener) => {
      finishedListener = listener
      return vi.fn()
    }),
    captureScreen: vi.fn(async () => ({ status: 'started' })),
    acknowledgeScreenshot: vi.fn(async () => true),
    reportScreenshotDelivery: vi.fn(async () => true),
    onScreenshotDeliveryState: vi.fn((listener) => {
      deliveryStates.add(listener)
      return vi.fn(() => deliveryStates.delete(listener))
    }),
    invalidateScreenshotSource: vi.fn(async () => true)
  }
  vi.stubGlobal('window', { api })
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (done) => queueMicrotask(() => done(new Blob(['thumbnail'], { type: 'image/png' })))
      }
      canvases.push(canvas)
      return canvas
    })
  })
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
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 1024, height: 768, close: vi.fn() }
      bitmaps.push(bitmap)
      return bitmap
    })
  )
  let url = 0
  createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:picker-' + ++url)
  revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const app of apps) app.unmount()
  apps.clear()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('draft image asset ownership', () => {
  it('loads stored 512px thumbnails and original geometry through one request per image', async () => {
    api.listImages.mockResolvedValueOnce([
      { id: 1, file_path: 'attachments/one.png', file_size: 3 },
      { id: 2, file_path: 'attachments/two.png', file_size: 4 }
    ])
    const page = await mount('ImagePicker', { mode: 'persist', noteId: 41 })
    expect(api.getImageThumbnailDetails.mock.calls).toEqual([
      ['attachments/one.png', 512],
      ['attachments/two.png', 512]
    ])
    expect(api.getImageThumbnail).not.toHaveBeenCalled()
    expect(api.getImageDimensions).not.toHaveBeenCalled()
    expect(page.state.images.value).toHaveLength(2)
    expect(page.state.images.value[0]).toMatchObject({
      dataUrl: 'thumbnail:attachments/one.png',
      _naturalWidth: 100,
      _naturalHeight: 60,
      saved: true
    })
  })

  it('uses one derived request after an upload without retaining the original', async () => {
    const page = await mount('ImagePicker', { mode: 'persist', noteId: 41 })
    expect(await add(page.state)).toBe(true)
    expect(api.getImageThumbnailDetails).toHaveBeenCalledExactlyOnceWith('saved-100', 512)
    expect(api.getImageThumbnail).not.toHaveBeenCalled()
    expect(api.getImageDimensions).not.toHaveBeenCalled()
    expect(page.state.images.value[0]).toMatchObject({
      id: 100,
      dataUrl: 'thumbnail:saved-100',
      _naturalWidth: 100,
      _naturalHeight: 60,
      saved: true
    })
  })

  it('releases only the late cancelled capture asset and its placeholder, retaining unrelated images', async () => {
    const page = await mount()
    expect(await add(page.state)).toBe(true)
    const original = page.state.getImages()
    let active = true
    const staged = deferred()
    const originalPort = page.props.assetPort
    originalPort.stageImage.mockReturnValueOnce(staged.promise)
    const capture = add(page.state, { deliveryOperation: { isCurrent: () => active } })
    active = false
    staged.resolve(metadata('cancelled-asset'))
    expect(await capture).toBe(false)
    expect(originalPort.releaseAssets).toHaveBeenCalledExactlyOnceWith(['cancelled-asset'])
    expect(page.state.getImages()).toEqual(original)
    expect(page.state.images.value.some((image) => image._loading)).toBe(false)
  })

  it('retains a successful original-note save after delivery expiry without updating the stale target', async () => {
    const page = await mount('ImagePicker', { mode: 'persist', noteId: 41 })
    const saved = deferred()
    api.saveImages.mockReturnValueOnce(saved.promise)
    let active = true
    const capture = add(page.state, { deliveryOperation: { isCurrent: () => active } })
    active = false
    saved.resolve([{ id: 101, file_path: 'saved-original-note', file_size: 3 }])
    expect(await capture).toBe(true)
    expect(api.saveImages).toHaveBeenCalledExactlyOnceWith(41, [{ base64: 'AQID', ext: 'png' }])
    expect(api.deleteImage).not.toHaveBeenCalled()
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    expect(page.state.images.value).toEqual([])
  })
  it.each(['file', 'capture'])(
    'reserves the %s slot synchronously and retains only metadata plus a bounded thumbnail',
    async (method) => {
      const page = await mount()
      const held = deferred()
      page.props.assetPort.stageImage.mockReturnValueOnce(held.promise)
      const pending =
        method === 'capture'
          ? add(page.state)
          : page.state.processFiles([{ name: 'draft.png', size: 3, type: 'image/png', dataUrl }])
      expect(page.state.busy.value).toBe(true)
      expect(page.busy.at(-1)).toBe(true)
      expect(page.counts.at(-1)).toBe(1)
      expect(page.state.getImages()).toEqual([])
      held.resolve(metadata())
      await pending
      expect(page.props.assetPort.stageImage).toHaveBeenCalledWith({
        base64: 'AQID',
        ext: 'png',
        name: 'draft.png',
        size: 3
      })
      expect(page.state.getImages()).toEqual([metadata()])
      expect(page.state.images.value[0]).not.toHaveProperty('base64')
      expect(page.state.images.value[0].dataUrl).toBe(thumbnail().data)
      expect(page.props.assetPort.thumbnailAsset).toHaveBeenCalledWith('asset-1', 512)
      expect(canvases).toHaveLength(0)
      expect(bitmaps).toHaveLength(0)
      expect(page.state.busy.value).toBe(false)
      expect(JSON.stringify(page.state.getDraftChanges())).not.toMatch(
        /base64|blob:|capability|dataUrl/
      )
      for (let i = 0; i < 10; i++) page.state.getDraftChanges()
      expect(page.props.assetPort.stageImage).toHaveBeenCalledOnce()
      expect(page.props.assetPort.previewAsset).not.toHaveBeenCalled()
    }
  )

  it('publishes a synchronous receipt with metadata before any target flush can observe it', async () => {
    const page = await mount()
    const receipt = []
    await add(page.state, {
      onStaged: (asset) => {
        expect(page.state.getImages()).toEqual([])
        receipt.push({ deliveryId: 'delivery', assetId: asset.assetId })
      }
    })
    expect({ receipt, images: page.state.getImages() }).toEqual({
      receipt: [{ deliveryId: 'delivery', assetId: 'asset-1' }],
      images: [metadata()]
    })
  })

  it('requires the asset port and preserves accepted images if another stage fails', async () => {
    const missing = await mount('ImagePicker', { assetPort: null })
    expect(await add(missing.state)).toBe(false)
    expect(missing.state.getImages()).toEqual([])
    const page = await mount()
    await add(page.state)
    page.props.assetPort.stageImage.mockRejectedValueOnce(new Error('disk write failed'))
    expect(await add(page.state)).toBe(false)
    expect(page.state.getImages()).toEqual([metadata()])
    expect(page.state.busy.value).toBe(false)
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
  })

  it('does not publish an image if a synchronous receipt callback invalidates the picker', async () => {
    const page = await mount()
    expect(await add(page.state, { onStaged: () => page.state.clearImages() })).toBe(false)
    expect(page.state.getImages()).toEqual([])
    expect(page.props.assetPort.releaseAssets).toHaveBeenCalledWith(['asset-1'])
    expect(createUrl).not.toHaveBeenCalled()
  })

  it.each(['clear', 'unmount', 'note', 'mode', 'port'])(
    'compensates a late staged asset against its captured port after %s',
    async (action) => {
      const page = await mount()
      const originalPort = page.props.assetPort
      const held = deferred()
      originalPort.stageImage.mockReturnValueOnce(held.promise)
      const pending = add(page.state)
      if (action === 'clear') page.state.clearImages()
      else if (action === 'unmount') page.unmount()
      else if (action === 'note') page.props.noteId = 2
      else if (action === 'mode') page.props.mode = 'draft'
      else page.props.assetPort = port()
      await flush()
      held.resolve(metadata())
      expect(await pending).toBe(false)
      expect(page.state.getImages()).toEqual([])
      expect(originalPort.releaseAssets).toHaveBeenCalledWith(['asset-1'])
      if (action === 'port') expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
      expect(createUrl).not.toHaveBeenCalled()
    }
  )

  it('ignores a late main thumbnail and compensates its staged asset after clear', async () => {
    const page = await mount()
    const held = deferred()
    page.props.assetPort.thumbnailAsset.mockReturnValueOnce(held.promise)
    const pending = add(page.state)
    await flush()
    page.state.clearImages()
    held.resolve(thumbnail())
    expect(await pending).toBe(false)
    expect(bitmaps).toHaveLength(0)
    expect(createUrl).not.toHaveBeenCalled()
    expect(page.props.assetPort.releaseAssets).toHaveBeenCalledWith(['asset-1'])
    expect(page.state.images.value).toEqual([])
  })

  it('keeps staged metadata when the bounded main thumbnail is temporarily unavailable', async () => {
    const page = await mount()
    page.props.assetPort.thumbnailAsset.mockResolvedValueOnce(null)
    expect(await add(page.state)).toBe(true)
    expect(page.state.getImages()).toEqual([metadata()])
    expect(page.state.images.value[0].dataUrl).toBe('')
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    expect(bitmaps).toHaveLength(0)
  })

  it('restores a removed image when its metadata journal cannot be persisted', async () => {
    const page = await mount()
    await add(page.state)
    const held = deferred()
    page.props.assetPort.flush.mockReturnValueOnce(held.promise)
    const pending = page.state.handleDelete(page.state.images.value[0], 0)
    expect(page.state.getImages()).toEqual([])
    expect(page.state.busy.value).toBe(true)
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    held.resolve({ dirty: true, blocked: true, persisted: false })
    await pending
    expect(page.state.getImages()).toEqual([metadata()])
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    expect(revokeUrl).not.toHaveBeenCalled()
    expect(page.state.busy.value).toBe(false)
  })

  it('releases only after the metadata removal persists even while its own busy is blocking', async () => {
    const page = await mount()
    await add(page.state)
    const journal = deferred(),
      release = deferred()
    page.props.assetPort.flush.mockReturnValueOnce(journal.promise)
    page.props.assetPort.releaseAssets.mockReturnValueOnce(release.promise)
    const pending = page.state.handleDelete(page.state.images.value[0], 0)
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    journal.resolve({ dirty: false, blocked: true, persisted: true })
    await flush()
    expect(page.props.assetPort.releaseAssets).toHaveBeenCalledWith(['asset-1'])
    expect(revokeUrl).not.toHaveBeenCalled()
    release.resolve(true)
    await pending
    expect(page.state.getImages()).toEqual([])
    expect(createUrl).not.toHaveBeenCalled()
    expect(page.state.busy.value).toBe(false)
  })

  it('keeps a durable logical deletion when later physical cleanup fails', async () => {
    const page = await mount()
    await add(page.state)
    page.props.assetPort.releaseAssets.mockRejectedValueOnce(
      new Error('unlink denied after revoke')
    )
    await page.state.handleDelete(page.state.images.value[0], 0)
    expect(page.state.getImages()).toEqual([])
    expect(page.props.assetPort.releaseAssets).toHaveBeenCalledOnce()
    expect(messages).toHaveBeenCalledWith('warning', 'unlink denied after revoke')
    expect(createUrl).not.toHaveBeenCalled()
    expect(page.state.busy.value).toBe(false)
  })

  it('does not delete the next image when a removal event is delivered twice', async () => {
    const page = await mount()
    await add(page.state)
    await add(page.state)
    const image = page.state.images.value[0]
    const journal = deferred()
    page.props.assetPort.flush.mockReturnValueOnce(journal.promise)
    const pending = page.state.handleDelete(image, 0)
    await page.state.handleDelete(image, 0)
    expect(page.state.getImages()).toEqual([metadata('asset-2')])
    expect(page.props.assetPort.flush).toHaveBeenCalledOnce()
    journal.resolve({ dirty: true, blocked: true, persisted: false })
    await pending
    expect(page.state.getImages()).toEqual([metadata(), metadata('asset-2')])
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
  })

  it('clears only local display and URL ownership without releasing an unsubmitted draft owner', async () => {
    const page = await mount()
    await add(page.state)
    page.state.clearImages()
    expect(page.state.getImages()).toEqual([])
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })
})

describe('draft image restoration and preview', () => {
  it('waits for every asset thumbnail, preserves saved deletions, and never stages or flushes a half restore', async () => {
    api.listImages.mockResolvedValue([
      { id: 10, file_path: 'ten' },
      { id: 20, file_path: 'twenty' }
    ])
    const page = await mount('ImagePicker', { mode: 'draft', noteId: 1 })
    const held = deferred()
    page.props.assetPort.thumbnailAsset.mockReturnValueOnce(held.promise)
    const pending = page.state.restoreDraft({ addedImages: [metadata()], deletedImageIds: [10] })
    await flush()
    expect(page.state.busy.value).toBe(true)
    expect(page.state.getImages()).toEqual([])
    held.resolve(thumbnail())
    expect(await pending).toBe(true)
    expect(page.state.images.value.map((image) => image.id || image.assetId)).toEqual([
      20,
      'asset-1'
    ])
    expect(page.state.getDraftChanges()).toEqual({
      addedImages: [metadata()],
      deletedImageIds: [10]
    })
    expect(page.props.assetPort.stageImage).not.toHaveBeenCalled()
    expect(page.props.assetPort.flush).not.toHaveBeenCalled()
    expect(page.state.busy.value).toBe(false)
    expect(revokeUrl).not.toHaveBeenCalled()
  })

  it('keeps the current image set and frees partial thumbnails if restoration fails', async () => {
    const page = await mount()
    await add(page.state)
    page.props.assetPort.thumbnailAsset
      .mockResolvedValueOnce(thumbnail())
      .mockRejectedValueOnce(new Error('asset read failed'))
    await expect(
      page.state.restoreDraft({ addedImages: [metadata('new-1'), metadata('new-2')] })
    ).rejects.toThrow('asset read failed')
    expect(page.state.getImages()).toEqual([metadata()])
    expect(createUrl).not.toHaveBeenCalled()
    expect(page.state.images.value[0].dataUrl).toBe(thumbnail().data)
    expect(page.state.busy.value).toBe(false)
  })

  it.each(['clear', 'unmount', 'port', 'restore'])(
    'ignores old restoration after %s',
    async (action) => {
      const page = await mount()
      const held = deferred()
      page.props.assetPort.thumbnailAsset.mockReturnValueOnce(held.promise)
      const pending = page.state.restoreDraft({ addedImages: [metadata('old')] })
      await flush()
      if (action === 'clear') page.state.clearImages()
      else if (action === 'unmount') page.unmount()
      else if (action === 'port') {
        page.props.assetPort = port()
        await flush()
      } else await page.state.restoreDraft({ addedImages: [metadata('new')] })
      held.resolve(thumbnail())
      expect(await pending).toBe(false)
      expect(page.state.getImages()).toEqual(action === 'restore' ? [metadata('new')] : [])
      expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
    }
  )

  it('hands original URL ownership to the actual preview node without changing card thumbnails', async () => {
    const page = await mount()
    await add(page.state)
    page.state.handlePreview(page.state.images.value[0])
    const lease = await page.state.resolvePreviewSource(0)
    expect(lease.src).toBe('blob:picker-1')
    expect(page.state.previewSources.value).toEqual([thumbnail().data])
    page.state.closePreview()
    // ImagePreview owns the connected/retiring DOM reader, rather than the picker.
    expect(revokeUrl).not.toHaveBeenCalled()
    lease.release()
    lease.release()
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:picker-1')
    expect(page.state.images.value[0].dataUrl).toBe(thumbnail().data)
    expect(page.props.assetPort.releaseAssets).not.toHaveBeenCalled()
  })

  it('does not allocate or reopen an original preview URL after close', async () => {
    const page = await mount()
    await add(page.state)
    page.state.handlePreview(page.state.images.value[0])
    const held = deferred()
    page.props.assetPort.previewAsset.mockReturnValueOnce(held.promise)
    const pending = page.state.resolvePreviewSource(0)
    const rejected = expect(pending).rejects.toThrow('图片预览已失效')
    page.state.closePreview()
    held.resolve(payload())
    await rejected
    expect(page.state.previewVisible.value).toBe(false)
    expect(page.state.previewSources.value).toEqual([])
    expect(createUrl).not.toHaveBeenCalled()
  })
})

describe('screenshot target persistence', () => {
  it('passes the live operation into addImage and skips a new journal write after cancellation', async () => {
    const page = await mount('ScreenshotPicker')
    const staged = deferred()
    const addImage = vi.fn(() => staged.promise)
    page.state.imagePickerRef.value = { addImage }
    const capture = page.state.onScreenshot()
    const token = api.captureScreen.mock.calls[0][0].token
    const ids = { sessionId: 'session', deliveryId: 'delivery' }
    const receiving = deliveryListener({ ...ids, token, action: 'source', dataUrl, size: 3 })
    await flush()
    expect(addImage.mock.calls[0][4].deliveryOperation.isCurrent()).toBe(true)
    for (const callback of [...deliveryStates]) callback({ ...ids, state: 'rejected' })
    staged.resolve(true)
    await receiving
    expect(page.props.assetPort.flush).not.toHaveBeenCalled()
    expect(api.acknowledgeScreenshot).not.toHaveBeenCalled()
    finishedListener({ token, status: 'cancelled' })
    await capture
  })

  it('ACKs only after stage and target metadata persistence, accepting persisted despite its own busy', async () => {
    const page = await mount('ScreenshotPicker')
    const staged = deferred(),
      journal = deferred()
    page.state.imagePickerRef.value = { addImage: vi.fn(() => staged.promise) }
    page.props.assetPort.flush.mockReturnValueOnce(journal.promise)
    const capture = page.state.onScreenshot()
    const token = api.captureScreen.mock.calls[0][0].token
    const delivery = deliveryListener({
      token,
      action: 'source',
      dataUrl,
      size: 3,
      sessionId: 'session',
      deliveryId: 'delivery'
    })
    expect(api.acknowledgeScreenshot).not.toHaveBeenCalled()
    staged.resolve(true)
    await flush()
    expect(page.props.assetPort.flush).toHaveBeenCalledOnce()
    expect(api.acknowledgeScreenshot).not.toHaveBeenCalled()
    journal.resolve({ dirty: true, blocked: true, persisted: true })
    await delivery
    expect(api.acknowledgeScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'delivery', accepted: true })
    )
    finishedListener({ token, status: 'delivered' })
    await capture
    expect(page.state.busy.value).toBe(false)
  })

  it('does not accept a capture if its target journal fails', async () => {
    const page = await mount('ScreenshotPicker')
    page.state.imagePickerRef.value = { addImage: vi.fn(async () => true) }
    page.props.assetPort.flush.mockResolvedValueOnce({
      dirty: true,
      blocked: true,
      persisted: false
    })
    expect(await page.state.addCapture({ dataUrl, size: 3 })).toBe(false)
  })

  it('keeps a programmatic target busy through its journal write', async () => {
    const page = await mount('ScreenshotPicker')
    const staged = deferred(),
      journal = deferred()
    page.state.imagePickerRef.value = { addImage: vi.fn(() => staged.promise) }
    page.props.assetPort.flush.mockReturnValueOnce(journal.promise)
    const pending = page.state.addCapture({ dataUrl, size: 3 })
    expect(page.state.busy.value).toBe(true)
    expect(page.busy.at(-1)).toBe(true)
    staged.resolve(true)
    await flush()
    expect(page.state.busy.value).toBe(true)
    journal.resolve({ dirty: true, blocked: true, persisted: true })
    expect(await pending).toBe(true)
    expect(page.state.busy.value).toBe(false)
  })

  it('passes a receipt callback before flush and rejects a stale capture continuation', async () => {
    const page = await mount('ScreenshotPicker')
    const onStaged = vi.fn()
    const journal = deferred()
    page.state.imagePickerRef.value = {
      addImage: vi.fn(async (_url, _ext, _name, _size, options) => {
        options.onStaged(metadata())
        return true
      }),
      clearImages: vi.fn()
    }
    page.props.assetPort.flush.mockImplementationOnce(() => {
      expect(onStaged).toHaveBeenCalledWith(metadata())
      return journal.promise
    })
    const pending = page.state.addCapture({ dataUrl, size: 3 }, { onStaged })
    await flush()
    page.state.clearImages()
    journal.resolve({ dirty: true, blocked: true, persisted: true })
    expect(await pending).toBe(false)
  })
})
