import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** A token belongs to one live main document, never to the reused BrowserWindow alone. */
export function createSettingsWriteSource({
  getMainWindow,
  getActiveWindowName,
  getActiveRendererLocation,
  assertCanWrite = () => {},
  createToken = randomUUID
}) {
  let current = null
  // Keep the last issued document number after invalidation. Navigation can
  // require a newer lease without issuing a replacement for an old notification.
  let generation = 0
  let stopped = false
  const observed = new WeakSet()

  function rejectSource() {
    const error = new Error('设置请求所属页面已失效，请在当前页面重试')
    error.code = 'SETTINGS_SOURCE_EXPIRED'
    throw error
  }

  function documentUrl(value) {
    const url = new URL(value)
    url.hash = ''
    return url.href
  }

  function readSource(event) {
    const window = getMainWindow()
    if (stopped || !window || window.isDestroyed()) return rejectSource()
    const contents = window.webContents
    const frame = event?.senderFrame
    if (
      event?.sender !== contents ||
      contents.isDestroyed() ||
      contents.isCrashed() ||
      !frame ||
      frame.isDestroyed() ||
      frame !== contents.mainFrame
    )
      return rejectSource()
    const location = getActiveRendererLocation()
    const expected = location.type === 'file' ? pathToFileURL(location.value).href : location.value
    if (documentUrl(frame.url) !== documentUrl(expected)) return rejectSource()
    return { contents, frame, url: documentUrl(frame.url), scope: getActiveWindowName() }
  }

  function observe(contents) {
    if (observed.has(contents)) return
    observed.add(contents)
    const invalidate = () => {
      if (current?.contents === contents) current = null
    }
    // A navigation request may be prevented while the original document remains usable.
    // did-navigate commits a new main document; in-page navigation does not emit it.
    contents.on('did-navigate', invalidate)
    contents.on('render-process-gone', invalidate)
    contents.once('destroyed', () => {
      invalidate()
      contents.removeListener('did-navigate', invalidate)
      contents.removeListener('render-process-gone', invalidate)
    })
  }

  function assertDocument(event, context) {
    const source = readSource(event)
    if (
      !current ||
      !context ||
      context.token !== current.token ||
      context.scope !== current.scope ||
      current.contents !== source.contents ||
      current.frame !== source.frame ||
      current.url !== source.url ||
      current.scope !== source.scope
    )
      return rejectSource()
    return { scope: current.scope, generation: current.generation }
  }

  return {
    issue(event) {
      const source = readSource(event)
      observe(source.contents)
      if (
        !current ||
        current.contents !== source.contents ||
        current.frame !== source.frame ||
        current.url !== source.url ||
        current.scope !== source.scope
      )
        current = { ...source, token: createToken(), generation: ++generation }
      return Object.freeze({ token: current.token, scope: current.scope })
    },
    assertDocument,
    captureCurrent() {
      if (!current) return null
      const context = Object.freeze({ token: current.token, scope: current.scope })
      try {
        // Read the existing lease; a broadcast must never issue a new document token.
        assertDocument({ sender: current.contents, senderFrame: current.frame }, context)
        return context
      } catch {
        return null
      }
    },
    readGeneration: () => generation,
    assert(event, context) {
      const { scope } = assertDocument(event, context)
      assertCanWrite()
      return scope
    },
    stop() {
      stopped = true
      current = null
    }
  }
}
