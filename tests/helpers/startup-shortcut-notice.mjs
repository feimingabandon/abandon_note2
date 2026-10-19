const NOTICE = '[aria-label="快捷键启用提示"]'

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

/** Dismiss a real startup conflict notice without bypassing its product handler. */
export async function dismissStartupShortcutNotice(window) {
  // This read waits for the product's startupPromise, including native shortcut
  // registration. Another running copy may already own F1/F2 on this desktop.
  const hasConflicts = await window.webContents.executeJavaScript(
    'window.api.getShortcutStartupNotice().then(items => items.length > 0)'
  )
  if (!hasConflicts) return false

  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector(${JSON.stringify(NOTICE)})
        return Array.from(dialog?.querySelectorAll('.app-modal-footer button') || [])
          .some(button => button.textContent.trim() === '稍后处理' && !button.disabled)
      })()`),
    'Startup shortcut conflict notice did not offer its real defer button'
  )
  await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector(${JSON.stringify(NOTICE)})
    const button = Array.from(dialog.querySelectorAll('.app-modal-footer button'))
      .find(target => target.textContent.trim() === '稍后处理' && !target.disabled)
    button.click()
  })()`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
        const scenes = Array.from(document.querySelectorAll('.app-scene, .month-scene'))
        return !document.querySelector(${JSON.stringify(NOTICE)}) && scenes.length > 0 &&
          scenes.every(scene => !scene.inert)
      })()`),
    'Startup shortcut notice did not finish leaving or release the product scene'
  )
  return true
}
