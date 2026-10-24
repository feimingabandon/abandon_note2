import { createImageDecodeRuntime } from './image-decode-runtime.js'

/** One application owner for stored and draft image preparation. Ports contain
 * fixed main functions; requests contain bounded source metadata only. */
export function createImageReadService(options = {}) {
  const ports = new Map()
  const suspensions = new Set()
  let generation = 0
  let disposed = false
  const runtime = createImageDecodeRuntime({
    ...options,
    start: ({ port, source }) => port.start(source)
  })

  function invalidate() {
    generation++
    for (const port of ports.values()) port.onInvalidate?.()
  }

  function createPort({ name, start, isCurrent = () => true, onInvalidate }) {
    if (
      disposed ||
      typeof name !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      ports.has(name) ||
      typeof start !== 'function' ||
      typeof isCurrent !== 'function' ||
      (onInvalidate !== undefined && typeof onInvalidate !== 'function')
    )
      throw new TypeError('Image read port requires a unique main-owned name and functions')
    const port = { start, isCurrent, onInvalidate }
    ports.set(name, port)
    return Object.freeze({
      request(key, source) {
        if (disposed || suspensions.size) return Promise.resolve(null)
        if (typeof key !== 'string' || key.length > 128 * 1024)
          throw new TypeError('Image read key exceeds its metadata budget')
        const capturedGeneration = generation
        return runtime.request(
          JSON.stringify([name, capturedGeneration, key]),
          { port, source },
          () =>
            !disposed &&
            !suspensions.size &&
            generation === capturedGeneration &&
            port.isCurrent(source)
        )
      }
    })
  }

  return Object.freeze({
    createPort,
    invalidate,
    generation: () => generation,
    isCurrent: (capturedGeneration) =>
      !disposed && !suspensions.size && capturedGeneration === generation,
    suspend(owner) {
      suspensions.add(owner)
      invalidate()
      return runtime.cancelAll('suspended')
    },
    resume(owner) {
      return !disposed && suspensions.delete(owner)
    },
    dispose() {
      if (!disposed) {
        disposed = true
        invalidate()
      }
      return runtime.dispose()
    },
    snapshot: () => ({
      ...runtime.snapshot(),
      generation,
      suspended: suspensions.size > 0,
      disposed
    })
  })
}

export const imageReadService = createImageReadService({
  onDiagnostic: (details) => console.warn('[images] 图片读取预算:', details)
})
