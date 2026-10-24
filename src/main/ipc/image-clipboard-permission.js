/** Allow image writes only from the current trusted top-level application page. */
export function allowImageClipboardWrite({
  webContents,
  permission,
  details,
  mainWindow,
  isTrustedDocumentUrl
}) {
  if (
    permission !== 'clipboard-sanitized-write' ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    webContents !== mainWindow.webContents ||
    webContents.isDestroyed() ||
    details?.isMainFrame !== true ||
    typeof details.requestingUrl !== 'string' ||
    !details.requestingUrl ||
    details.requestingUrl !== webContents.getURL()
  )
    return false
  try {
    return isTrustedDocumentUrl?.(details.requestingUrl) === true
  } catch {
    return false
  }
}
