import { describe, expect, it } from 'vitest'
import { allowImageClipboardWrite } from '../src/main/ipc/image-clipboard-permission.js'

describe('image clipboard permission', () => {
  const url = 'file:///app/index.html'
  const owner = { isDestroyed: () => false, getURL: () => url }
  const mainWindow = { isDestroyed: () => false, webContents: owner }
  const request = {
    webContents: owner,
    mainWindow,
    permission: 'clipboard-sanitized-write',
    details: { isMainFrame: true, requestingUrl: url },
    isTrustedDocumentUrl: (candidate) => candidate === url
  }
  it('allows only the current trusted main document to write', () => {
    expect(allowImageClipboardWrite(request)).toBe(true)
    for (const change of [
      { permission: 'clipboard-read' },
      { permission: 'deprecated-sync-clipboard-read' },
      { permission: 'media' },
      { webContents: null },
      { webContents: { ...owner } },
      { mainWindow: null },
      { mainWindow: { ...mainWindow, isDestroyed: () => true } },
      { details: { ...request.details, isMainFrame: false } },
      { details: { requestingUrl: url } },
      { details: { isMainFrame: true, requestingUrl: 'file:///app/old.html' } },
      { details: { isMainFrame: true, requestingUrl: '' } },
      { details: undefined },
      { isTrustedDocumentUrl: () => false },
      {
        isTrustedDocumentUrl: () => {
          throw new Error('invalid URL')
        }
      },
      { isTrustedDocumentUrl: undefined }
    ])
      expect(allowImageClipboardWrite({ ...request, ...change })).toBe(false)
  })
})
