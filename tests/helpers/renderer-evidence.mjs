// executeJavaScript otherwise hides the expression and often reports only
// "Script failed to execute". Keep the failing operation in the runner log.
export function traceRendererExpressions(window, label) {
  const original = window.webContents.executeJavaScript.bind(window.webContents)
  window.webContents.executeJavaScript = async (code, ...args) => {
    try {
      return await original(code, ...args)
    } catch (error) {
      console.error(`[${label}] Failed renderer expression:\n${code}`)
      throw error
    }
  }
}
