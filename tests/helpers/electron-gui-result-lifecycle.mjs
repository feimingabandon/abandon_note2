import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createAssertionRecorder, prepareTestProfile } from './test-result-recorder.cjs'

/** Result protocol for a real app GUI suite; normal quit still owns product shutdown. */
export function createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite,
  mode,
  prefix,
  metadata,
  timeoutMs = 90000
}) {
  const recorder = createAssertionRecorder({ suite, mode, metadata })
  const profile = prepareTestProfile({ prefix })
  let closing = false
  let completed = false
  let failure = null
  let reachedWillQuit = false
  let evidence = { status: 'incomplete' }
  let cleanupTimeout
  const cleanupErrors = []
  const timeout = setTimeout(
    () => void finish({ error: new Error(suite + ' timed out') }),
    timeoutMs
  )

  async function finish({
    completed: businessCompleted = false,
    error = null,
    window,
    summary = {},
    restore
  } = {}) {
    if (closing) return
    closing = true
    completed = businessCompleted
    failure = error
    clearTimeout(timeout)
    process.exitCode = error ? 1 : 0
    try {
      await restore?.()
    } catch (restoreError) {
      cleanupErrors.push(restoreError.stack || restoreError.message)
      process.exitCode = 1
    }
    try {
      const root = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
      const report = {
        ...summary,
        completed,
        error: error?.stack || error?.message || null,
        counts: recorder.report({ cleanup: { status: 'preserved' } }).assertions
      }
      let screenshotSha256
      if (window && !window.isDestroyed()) {
        report.finalUrl = window.webContents.getURL()
        report.finalBounds = window.getBounds()
        let captureTimeout
        const screenshot = await Promise.race([
          window.webContents.capturePage(),
          new Promise((_, reject) => {
            captureTimeout = setTimeout(() => reject(new Error('Final screenshot timed out')), 3000)
          })
        ]).finally(() => clearTimeout(captureTimeout))
        const png = screenshot.toPNG()
        writeFileSync(join(root, 'gui-final.png'), png, { flag: 'wx' })
        screenshotSha256 = createHash('sha256').update(png).digest('hex')
        report.screenshotSha256 = screenshotSha256
      }
      writeFileSync(join(root, 'gui-evidence.json'), JSON.stringify(report, null, 2), {
        flag: 'wx'
      })
      evidence = {
        status: 'complete',
        artifacts: ['gui-evidence.json', ...(screenshotSha256 ? ['gui-final.png'] : [])],
        scope:
          'Actual assertion calls, real app window and final screenshot; product shutdown uses normal quit'
      }
    } catch (evidenceError) {
      evidence = { status: 'failed', error: evidenceError.stack || evidenceError.message }
      process.exitCode = 1
    }
    cleanupTimeout = setTimeout(() => app.exit(1), 12000)
    for (const target of BrowserWindow.getAllWindows()) {
      try {
        if (!target.isDestroyed()) target.destroy()
      } catch (closeError) {
        cleanupErrors.push(closeError.stack || closeError.message)
        process.exitCode = 1
      }
    }
    app.quit()
  }
  app.once('will-quit', () => {
    reachedWillQuit = true
  })
  app.once('quit', (_event, code) => {
    clearTimeout(timeout)
    clearTimeout(cleanupTimeout)
    const windowsClosed = BrowserWindow.getAllWindows().every((window) => window.isDestroyed())
    const clean = reachedWillQuit && windowsClosed && cleanupErrors.length === 0
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence,
        profileOwnership: profile.ownership,
        cleanup: {
          status:
            clean && profile.ownership === 'runner' ? 'complete' : clean ? 'preserved' : 'failed',
          reachedWillQuit,
          windowsClosed,
          errors: cleanupErrors,
          exitCode: code,
          preservedProfile:
            profile.ownership === 'script' || failure ? profile.directory : undefined,
          scope:
            'Normal main before-quit/windows/process; runner removes its owned profile after exit'
        }
      })
    } catch (reportError) {
      console.error(reportError)
      process.exitCode = 1
    }
  })
  return { assert: recorder.assert, root: profile.directory, finish }
}
