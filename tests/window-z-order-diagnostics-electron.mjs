import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/window-z-order-diagnostics-electron.mjs',
  mode: 'electron-native-zorder-failure-to-daily-log',
  prefix: 'abandon-zorder-diagnostic-log-',
  metadata: {
    nativeApiInvalidHwnd: true,
    actualLoggerWorker: true,
    fullApplicationBootstrap: false,
    installerFirstLaunch: false,
    changesRealWindowOrder: false
  }
})
const { assert } = lifecycle
app.setPath('userData', lifecycle.root)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
// The source bridge uses the same CommonJS native dependencies as its Vite output.
globalThis.require = createRequire(import.meta.url)

app.whenReady().then(async () => {
  let failure
  try {
    const { createZOrderRuntime } = await import('../src/main/windows/z-order-runtime.js')
    const { withOperation } = await import('../src/main/logging/operation-context.js')
    const { logger, flushLogs, getLogDirectory } = await import('../src/main/logging/logger.js')
    const { getWindowZOrderFailureDiagnostic } = await import('../src/main/bridge/blur_bridge.js')
    const fakeWindow = {
      isDestroyed: () => false,
      isAlwaysOnTop: () => false,
      setAlwaysOnTop: () => {},
      getNativeWindowHandle: () => Buffer.alloc(8)
    }
    const actions = ['zorder-diagnostic-action-one', 'zorder-diagnostic-action-two']
    for (const actionId of actions) {
      const runtime = createZOrderRuntime({
        getMainWindow: () => fakeWindow,
        getActiveVisualWindow: () => fakeWindow,
        getApplicationWindows: () => [fakeWindow],
        getSettings: () => ({ window: { zOrderMode: 'normal' } }),
        readBlurState: () => ({ initialized: false, config: { enabled: false } }),
        readDockState: () => ({ isSliding: false, isDockHidden: false }),
        isWindowLocked: () => false,
        runBlurRuntimeOperation: () => {},
        refreshResolvedSettings: () => {},
        getResolvedSettingsSnapshot: () => ({}),
        broadcastSettingsChanged: () => {},
        sendAppMessage: () => {},
        logger
      })
      runtime.syncResolved()
      await assert.rejects(
        withOperation({ actionId }, () => runtime.setWindowZOrderMode('bottom')),
        (error) =>
          error.nativeCode === -1 && error.nativeFailure.stage === 'invalid-requested-window'
      )
      assert.equal(runtime.mode, 'normal')
    }
    const history = getWindowZOrderFailureDiagnostic()
    assert.equal(history.supported, true)
    assert.equal(history.failureCount, 2)
    assert.equal(history.firstFailure.sequence, 1)
    assert.equal(history.lastFailure.sequence, 2)
    const flushed = await flushLogs()
    assert.equal(flushed.incomplete, false, 'failure evidence must reach the actual log writer')
    const logDirectory = getLogDirectory()
    const records = readdirSync(logDirectory)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => readFileSync(join(logDirectory, name), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const failures = records.filter((record) => record.scope === 'window.z-order-failure')
    assert.equal(failures.length, 2, 'two same-stack failures must retain separate native evidence')
    assert.deepEqual(
      failures.map((record) => record.actionId),
      actions
    )
    assert.deepEqual(
      failures.map((record) => record.metadata.nativeFailure.sequence),
      [1, 2]
    )
    assert.notEqual(failures[0].metadata.diagnosticId, failures[1].metadata.diagnosticId)
    for (const record of failures) {
      assert.equal(record.metadata.nativeCode, -1)
      assert.equal(record.metadata.nativeFailure.stage, 'invalid-requested-window')
      assert.equal(record.metadata.nativeFailure.win32Error, null)
      assert.equal(record.metadata.nativeFailure.windows.requested.valid, false)
      assert.equal(record.metadata.truncated, undefined)
      const rollback = records.filter(
        (candidate) =>
          candidate.scope === 'window.z-order-rollback-state' &&
          candidate.actionId === record.actionId
      )
      assert.deepEqual(
        rollback.map((candidate) => candidate.stage),
        ['before-rollback', 'after-rollback']
      )
      assert.ok(
        rollback.every(
          (candidate) => candidate.metadata.diagnosticId === record.metadata.diagnosticId
        )
      )
    }
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    await lifecycle.finish({ completed: !failure, error: failure })
  }
})
