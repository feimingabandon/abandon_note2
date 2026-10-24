import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyImageToClipboard,
  imageClipboardBusy
} from '../src/renderer/src/utils/imageClipboard.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture({ conversion, write = vi.fn(async () => {}) } = {}) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (done) => (conversion ? conversion.promise.then(done) : done({ type: 'image/png' }))
  }
  vi.stubGlobal('navigator', { clipboard: { write } })
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(data) {
        this.data = data
      }
    }
  )
  vi.stubGlobal('document', { createElement: () => canvas })
  const source = {
    src: 'blob:original',
    image: { complete: true, naturalWidth: 640, naturalHeight: 320 },
    release: vi.fn()
  }
  return { canvas, source, write }
}
afterEach(() => vi.unstubAllGlobals())

describe('attachment image clipboard ownership', () => {
  it('admits one conversion and rejects extra original reads without queuing', async () => {
    const conversion = deferred()
    const { source, canvas, write } = fixture({ conversion })
    const first = copyImageToClipboard({ acquire: () => source })
    await Promise.resolve()
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(320)
    const secondAcquire = vi.fn()
    expect(await copyImageToClipboard({ acquire: secondAcquire })).toBe('busy')
    expect(secondAcquire).not.toHaveBeenCalled()
    expect(source.release).not.toHaveBeenCalled()
    conversion.resolve({ type: 'image/png' })
    expect(await first).toBe('copied')
    expect(write).toHaveBeenCalledTimes(1)
    expect(source.release).toHaveBeenCalledTimes(1)
    expect(canvas.width).toBe(0)
    expect(imageClipboardBusy.value).toBe(false)
  })

  it('keeps the original until PNG conversion finishes but cancels stale writes', async () => {
    const conversion = deferred()
    const { source, write } = fixture({ conversion })
    let current = true
    const copy = copyImageToClipboard({ acquire: () => source, isCurrent: () => current })
    await Promise.resolve()
    current = false
    expect(source.release).not.toHaveBeenCalled()
    conversion.resolve({ type: 'image/png' })
    expect(await copy).toBe('cancelled')
    expect(write).not.toHaveBeenCalled()
    expect(source.release).toHaveBeenCalledTimes(1)
  })

  it('releases a late original after its owner disappeared without creating a canvas', async () => {
    const pending = deferred()
    const { source, write } = fixture()
    let current = true
    const copy = copyImageToClipboard({ acquire: () => pending.promise, isCurrent: () => current })
    current = false
    pending.resolve(source)
    expect(await copy).toBe('cancelled')
    expect(write).not.toHaveBeenCalled()
    expect(source.release).toHaveBeenCalledTimes(1)
  })

  it('retains ownership through clipboard failure and frees the next user action', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue()
    const { source } = fixture({ write })
    await expect(copyImageToClipboard({ acquire: () => source })).rejects.toThrow('无法写入剪贴板')
    expect(source.release).toHaveBeenCalledTimes(1)
    expect(imageClipboardBusy.value).toBe(false)
    expect(await copyImageToClipboard({ acquire: () => source })).toBe('copied')
  })
})
