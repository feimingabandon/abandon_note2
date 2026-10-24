import { mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron'
import { DEFAULT_STICKY_WIDTH } from '../src/main/sticky/stickyConstants.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'

const require = createRequire(import.meta.url)
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/logging-actions-electron.mjs',
  mode: 'electron-real-app-diagnostic-actions-cross-window-export',
  prefix: 'abandon-note-logging-actions-',
  timeoutMs: 120000,
  metadata: {
    actualApp: true,
    realSqliteAndAttachments: true,
    actualChromiumWheel: true,
    controlledMainAndRendererDelay: true,
    humanPerformanceRootCause: false,
    systemSaveDialog: 'controlled-response',
    applicationRestart: false
  }
})
const { assert } = lifecycle
const testUserData = lifecycle.root
const testEvidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || testUserData
const report = (message) => process.stderr.write(`[logging-actions-e2e] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}

function seedApplicationSettings() {
  mkdirSync(testUserData, { recursive: true })
  const db = new Database(join(testUserData, 'app.db'))
  db.exec(`
    CREATE TABLE app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
  const insert = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'month', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getMonthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function verifyAttachmentRecoveryOutsider() {
  const outsider = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await outsider.loadURL('data:text/html,<html><body>Recovery IPC outsider</body></html>')
    const result = await outsider.webContents.executeJavaScript(`(async () => {
      try { await window.api.getAttachmentRecoveryReport(); return { accepted: true } }
      catch (error) { return { accepted: false, message: error.message } }
    })()`)
    assert.equal(result.accepted, false, '非主窗口不得读取附件诊断')
    assert.match(result.message, /无权访问/)
    result.retry = await outsider.webContents.executeJavaScript(`(async () => {
      try { await window.api.retryAttachmentRecovery(); return { accepted: true } }
      catch (error) { return { accepted: false, message: error.message } }
    })()`)
    assert.equal(result.retry.accepted, false, '非主窗口不得执行附件恢复')
    assert.match(result.retry.message, /无权访问/)
    return result
  } finally {
    outsider.destroy()
  }
}

async function captureAttachmentRecoverySurfaces(window) {
  window.show()
  window.focus()
  await waitUntil(() => window.isFocused(), '附件诊断视觉检查主窗口未获得焦点')
  await window.webContents.executeJavaScript(`Promise.allSettled(
    ['.settings-panel', '.diagnostics-content'].flatMap(selector =>
      document.querySelector(selector).getAnimations().map(animation => animation.finished)))`)
  const visuals = []
  try {
    for (const variant of [
      { name: 'white', bg: '255 255 255', text: '#1d1d1f', backdrop: '#fff', marker: 37 },
      { name: 'black', bg: '0 0 0', text: '#f5f5f7', backdrop: '#000', marker: 73 },
      {
        name: 'complex',
        bg: '255 255 255',
        text: '#1d1d1f',
        marker: 109,
        backdrop: 'repeating-conic-gradient(#063b72 0% 25%, #f7c957 0% 50%) 0 0 / 80px 80px'
      },
      {
        name: 'narrow-large',
        bg: '255 255 255',
        text: '#1d1d1f',
        backdrop: '#fff',
        marker: 149,
        narrow: true
      }
    ]) {
      const paint = waitForFixtureFrame({
        webContents: window.webContents,
        name: 'attachment-recovery-' + variant.name,
        marker: [variant.marker, variant.marker, variant.marker],
        palette:
          variant.name === 'black' ? 'black' : variant.name === 'complex' ? 'complex' : 'white',
        viewport: await window.webContents.executeJavaScript(
          '({width:innerWidth,height:innerHeight})'
        )
      })
      try {
        const css = `:root{--bg-color:${variant.bg}!important;--text-color:${variant.text}!important;}
          body,.settings-wrapper{background:${variant.backdrop}!important;}
          /* Test-only drawing probe identifies the presented CSS generation. */
          #recovery-paint-marker{position:fixed;left:8px;top:160px;width:4px;height:4px;pointer-events:none;z-index:var(--z-global-critical);background:rgb(${variant.marker} ${variant.marker} ${variant.marker})!important;}
          ${variant.narrow ? '.settings-panel{width:340px!important;max-width:100%!important;left:0!important;right:auto!important;--fs-secondary:16px!important;}' : ''}`
        await window.webContents.executeJavaScript(`(() => {
          document.getElementById('recovery-test-visual')?.remove()
          document.getElementById('recovery-paint-marker')?.remove()
          const style = document.createElement('style'); style.id='recovery-test-visual'; style.textContent=${JSON.stringify(css)}
          document.head.append(style)
          const marker = document.createElement('div'); marker.id='recovery-paint-marker'; document.body.append(marker)
          document.querySelector('.attachment-recovery-status').scrollIntoView({block:'center',behavior:'instant'})
        })()`)
        const presented = await paint.ready
        assert.equal(paint.trace.cleanupError, undefined)
        const metrics = await window.webContents.executeJavaScript(`(() => {
          const root=document.querySelector('.attachment-recovery-status'), r=root.getBoundingClientRect()
          const button=root.querySelector('button'), b=button.getBoundingClientRect(), reading=root.closest('.panel-body').getBoundingClientRect()
          return {top:r.top,bottom:r.bottom,readingTop:reading.top,readingBottom:reading.bottom,
            width:root.clientWidth,scrollWidth:root.scrollWidth,backgroundToken:getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim(),
            hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('button')===button}
        })()`)
        assert.equal(metrics.backgroundToken, variant.bg)
        assert.equal(
          metrics.hit,
          true,
          variant.name + ' report action must be visible and unoccluded'
        )
        assert.ok(
          metrics.top >= metrics.readingTop - 1 && metrics.bottom <= metrics.readingBottom + 1,
          variant.name + ' report must fit inside its scrollable reading surface'
        )
        assert.ok(metrics.scrollWidth <= metrics.width + 1)
        const file = `attachment-recovery-${variant.name}.png`
        writeFileSync(join(testEvidenceRoot, file), presented.toPNG(), { flag: 'wx' })
        visuals.push({ file, metrics, frame: paint.trace })
      } finally {
        paint.close()
      }
    }
    return visuals
  } finally {
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('recovery-test-visual')?.remove()
      document.getElementById('recovery-paint-marker')?.remove()
    })()`)
  }
}

async function verifyDestroyedWindowConsole(mainWindow) {
  const marker = `destroyed-console-e2e-${Date.now()}`
  const messages = [
    { level: 'warning', message: `${marker}-warning` },
    { level: 'error', message: `${marker}-error` }
  ]
  const observed = []
  const uncaught = []
  const observeUncaught = (error, origin) => {
    uncaught.push({ message: error?.message || String(error), origin })
  }
  // Monitoring does not handle the exception or suppress Electron's error dialog.
  process.on('uncaughtExceptionMonitor', observeUncaught)
  let fixture
  try {
    // The running product's browser-window-created listener attaches its bundled
    // window-capture module. No source-module import or replacement logger is used.
    fixture = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: marker
      }
    })
    const fixtureId = fixture.id
    const contentsId = fixture.webContents.id
    assert.ok(
      fixture.webContents.listenerCount('console-message') > 0,
      '实际应用没有为新窗口安装 Chromium 日志采集'
    )
    fixture.webContents.on('console-message', (details) => {
      if (messages.some((item) => item.message === details.message)) {
        observed.push({ level: details.level, message: details.message, receivedAt: Date.now() })
      }
    })
    await fixture.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
            '<title>Destroyed window console regression</title>'
        )
    )
    await fixture.webContents.executeJavaScript(
      `console.warn(${JSON.stringify(messages[0].message)}); console.error(${JSON.stringify(messages[1].message)}); true`
    )
    await waitUntil(() => observed.length === 2, '真实 Chromium 警告和错误没有进入窗口采集')
    assert.deepEqual(
      observed.map(({ level, message }) => ({ level, message })),
      messages
    )
    const destroyedAt = Date.now()
    assert.ok(
      destroyedAt - observed[0].receivedAt < 1250,
      '必须在 Chromium 日志的延迟回调到期前销毁真实窗口'
    )
    fixture.destroy()
    assert.equal(fixture.isDestroyed(), true)
    await wait(1500)
    assert.ok(Date.now() - destroyedAt > 1250, '未跨过原始 Chromium 日志延迟回调期限')
    assert.equal(
      await mainWindow.webContents.executeJavaScript('Promise.resolve("main-loop-responsive")'),
      'main-loop-responsive',
      '销毁窗口后主进程和实际应用 IPC 必须继续响应'
    )
    const fallbackLogs = await waitUntil(async () => {
      const result = await mainWindow.webContents.executeJavaScript(
        `window.api.queryLogs({ search: ${JSON.stringify(marker)}, limit: 20 })`
      )
      const rows = result.items.filter((row) => row.scope === 'renderer.console')
      return rows.length >= 2 ? rows : null
    }, '已销毁窗口的 Chromium 警告或错误没有安全写入实际日志')
    assert.equal(fallbackLogs.length, 2, '销毁后延迟回调不应重复写入同一条 Chromium 日志')
    assert.deepEqual(
      new Set(fallbackLogs.map((row) => `${row.level}:${row.message}`)),
      new Set([`warn:${messages[0].message}`, `error:${messages[1].message}`])
    )
    for (const row of fallbackLogs) {
      assert.equal(row.webContentsId, contentsId, '销毁后必须保留真实 WebContents 身份')
      assert.equal(row.metadata.browserWindowId, fixtureId, '销毁后必须保留真实窗口身份')
    }
    assert.deepEqual(uncaught, [], '销毁窗口后不应产生未捕获异常')
    return {
      fixtureId,
      contentsId,
      observed,
      destroyedAt,
      waitedMs: Date.now() - destroyedAt,
      fallbackMessages: fallbackLogs.map(({ level, message }) => ({ level, message })),
      uncaught
    }
  } finally {
    if (fixture && !fixture.isDestroyed()) fixture.destroy()
    process.removeListener('uncaughtExceptionMonitor', observeUncaught)
  }
}

let activeWindow = null
let failureUi = null

try {
  app.setPath('userData', testUserData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve(
    'native_blur',
    'build',
    'bin',
    'blur_engine.dll'
  )
  seedApplicationSettings()

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  void lifecycle.finish({ error })
}

async function runTest() {
  let failure = null
  let completed = false
  let destroyedConsoleRegression = null
  let attachmentRecoveryEvidence = null
  try {
    const window = await waitUntil(getMonthWindow, '月视图主窗口未启动')
    activeWindow = window
    await waitUntil(() => window.isVisible(), '月视图主窗口未显示')
    await waitUntil(
      () => window.webContents.executeJavaScript(`Boolean(window.api?.getDiagnosticState)`),
      '诊断桥未就绪'
    )
    await dismissStartupShortcutNotice(window)
    const initialState = await window.webContents.executeJavaScript(
      `window.api.getDiagnosticState()`
    )
    assert.equal(initialState.mode, 'daily', '每次启动必须默认日常模式')
    const initialRecovery = await window.webContents.executeJavaScript(
      `window.api.getAttachmentRecoveryReport()`
    )
    assert.equal(initialRecovery.scope, 'pending-attachment-recovery-round')
    assert.equal(initialRecovery.phase, 'finished')
    assert.equal(initialRecovery.partial, false)
    assert.equal(initialRecovery.status, 'completed')
    assert.equal(initialRecovery.operations.length, 0)
    let expectedRecovery = initialRecovery
    const deepState = await window.webContents.executeJavaScript(
      `window.api.startDeepDiagnostics()`
    )
    assert.equal(deepState.mode, 'deep')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.getDiagnosticPolicy().mode === 'deep'`),
      '页面未应用深度策略'
    )

    // 真实 Chromium 滚轮输入与可控长任务：验证采集管线，不冒充用户机器卡顿复现。
    await window.webContents.executeJavaScript(`(() => {
      const fixture = document.createElement('div')
      fixture.id = 'performance-scroll-fixture'
      Object.assign(fixture.style, { position: 'fixed', left: '40px', top: '140px',
        width: '260px', height: '180px', overflowY: 'auto', zIndex: '999999', background: '#fff' })
      const content = document.createElement('div')
      content.style.height = '2400px'
      content.textContent = 'performance-private-content-must-not-be-logged'
      fixture.appendChild(content)
      document.body.appendChild(fixture)
      fixture.scrollTop = 400
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 180 })
    window.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: 100,
      y: 180,
      deltaY: 120,
      canScroll: true
    })
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.getElementById('performance-scroll-fixture').scrollTop !== 400`
        ),
      '真实滚轮未推动内容'
    )
    await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => {
      const end = performance.now() + 240
      while (performance.now() < end) { /* 受控 Renderer 主线程阻塞 */ }
      resolve()
    }, 50))`)
    await waitUntil(async () => {
      const logs = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'performance.renderer', limit: 40 })`
      )
      return logs.items.some(
        (row) =>
          row.scope === 'performance.renderer' &&
          row.metadata.wheelEvents > 0 &&
          row.metadata.scrollEvents > 0 &&
          row.metadata.longTasks.maxMs >= 200 &&
          row.metadata.frameIntervals.maxMs >= 100
      )
    }, '滚动/长任务/帧间隔没有形成汇总日志')
    await window.webContents.executeJavaScript(
      `document.getElementById('performance-scroll-fixture').remove()`
    )

    // 主进程受控阻塞应出现在独立时钟采样，不依赖 Renderer 自报。
    const blockUntil = performance.now() + 1250
    while (performance.now() < blockUntil) {
      /* 受控主进程阻塞 */
    }
    await waitUntil(async () => {
      const logs = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'performance.main', limit: 40 })`
      )
      return logs.items.some(
        (row) =>
          row.metadata.mainLoopDelay?.maxMs > 100 &&
          row.metadata.processes?.some((process) => process.cpuPercentOneCore !== null) &&
          row.metadata.nativeZOrder?.supported === true
      )
    }, '主进程采样没有包含阻塞、资源和原生状态')

    const result = await window.webContents.executeJavaScript(`(async () => {
      await window.api.setSettingValue('notes.tagColorEnabled', false)
      console.error('[diagnostic-e2e] structured renderer failure', new Error('fixture failure'))
      await new Promise((resolve) => setTimeout(resolve, 80))
      const actionLogs = await window.api.queryLogs({ search: 'settings.value.set', limit: 20 })
      const consoleLogs = await window.api.queryLogs({ search: '[diagnostic-e2e]', limit: 20 })
      return {
        actionLogs: actionLogs.items.filter((record) => record.eventName === 'settings.value.set'),
        consoleLogs: consoleLogs.items
      }
    })()`)

    const actionIds = new Set(result.actionLogs.map((record) => record.actionId).filter(Boolean))
    assert.equal(actionIds.size, 1, 'Renderer 与主进程没有复用同一个 actionId')
    assert.deepEqual(
      new Set(
        result.actionLogs.map((record) => `${record.process}:${record.phase}:${record.stage || ''}`)
      ),
      new Set([
        'renderer:start:',
        'main:received:ipc-handler',
        'main:returned:ipc-handler',
        'renderer:returned:'
      ]),
      '设置操作没有形成完整的 Renderer → IPC → Renderer 链路'
    )
    assert.equal(result.consoleLogs.length, 1, '结构化 Renderer 错误仍被 console-message 重复记录')
    assert.equal(result.consoleLogs[0].scope, 'month-renderer.console-error')
    const evidence = await window.webContents.executeJavaScript(`(async () => {
      const persisted = await window.api.queryLogs({ search: 'settings.persisted', limit: 50 })
      const settings = await window.api.getSettingsSnapshot()
      const note = await window.api.createNote({ content: 'diagnostic-private-original' })
      await window.api.updateNote(note.id, { content: 'diagnostic-private-modified' })
      let rejected = false
      try { await window.api.setSettingValue('nonexistent.setting', true) } catch { rejected = true }
      return { persisted: persisted.items, settings, id: note.id, rejected }
    })()`)
    assert.equal(evidence.settings.values.notes.tagColorEnabled, false)
    assert.ok(
      evidence.persisted.some(
        (row) =>
          row.actionId === [...actionIds][0] &&
          row.outcome === 'verified' &&
          row.metadata.scope === 'application' &&
          row.metadata.stored === '0'
      )
    )
    assert.equal(evidence.rejected, true)
    const noteLogs = await waitUntil(async () => {
      const rows = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'view.data-applied', limit: 100 })`
      )
      return rows.items.some((row) => row.metadata.notes?.some((note) => note.id === evidence.id))
        ? rows.items
        : null
    }, '月视图没有输出包含便签的实际数据应用证据')
    const persistedNotes = await window.webContents.executeJavaScript(
      `window.api.queryLogs({ search: 'note.persisted', limit: 100 })`
    )
    const updateEvidence = persistedNotes.items.find(
      (row) => row.metadata.id === evidence.id && row.metadata.before
    )
    assert.ok(updateEvidence?.metadata.changedFields.includes('content'))
    assert.ok(
      noteLogs.some((row) => row.metadata.causeActionIds?.includes(updateEvidence.actionId)),
      '数据库变更没有关联到月视图刷新'
    )
    assert.ok(!JSON.stringify(persistedNotes).includes('diagnostic-private-'), '便签读回泄漏了原文')

    // 用真实附件读写/解码、SQLite 读取和 Win32 层级调用验证归因，而非伪造日志。
    const imageBase64 = nativeImage
      .createFromBitmap(Buffer.alloc(16, 128), { width: 2, height: 2 })
      .toPNG()
      .toString('base64')
    const imageEvidence = await window.webContents.executeJavaScript(`(async () => {
      const images = await window.api.saveImages(${evidence.id}, [{ base64: ${JSON.stringify(imageBase64)}, ext: 'png' }])
      const path = images[0].file_path
      await window.api.getImageThumbnail(path, 123)
      await window.api.getImageThumbnail(path, 123)
      const size = await window.api.getImageDimensions(path)
      const original = await window.api.getImageBase64(path)
      const notes = await window.api.queryRecentNotes({cutoffTime: 0})
      await window.api.setWindowZOrderMode('top')
      await window.api.setWindowZOrderMode('normal')
      return { size, originalLoaded: Boolean(original), count: notes.length }
    })()`)
    assert.deepEqual(imageEvidence.size, { width: 2, height: 2 })
    assert.ok(imageEvidence.originalLoaded && imageEvidence.count > 0)

    // 真 SQLite 故障注入：吞掉 UPDATE 但不抛异常，必须发现读回不一致。
    const fixtureDb = new Database(join(testUserData, 'app.db'))
    try {
      fixtureDb.exec(`CREATE TRIGGER diagnostic_ignore_setting BEFORE UPDATE ON app_settings
        WHEN NEW.key = 'tag_color_enabled' BEGIN SELECT RAISE(IGNORE); END;`)
      await window.webContents.executeJavaScript(
        `window.api.setSettingValue('notes.tagColorEnabled', true)`
      )
      const mismatch = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'settings.persisted', limit: 100 })`
      )
      assert.ok(
        mismatch.items.some(
          (row) => row.outcome === 'mismatch' && row.metadata.id === 'notes.tagColorEnabled'
        )
      )
    } finally {
      fixtureDb.exec('DROP TRIGGER IF EXISTS diagnostic_ignore_setting')
      fixtureDb.close()
    }
    // 同一个文件内包含重启前的正常操作和窗口之外的旧日志，验证按时间而非会话/错误级别筛选。
    const logDirectory = join(testUserData, 'logs')
    const logFile = readdirSync(logDirectory).find((name) => name.endsWith('.jsonl'))
    assert.ok(logFile)
    const now = Date.now()
    appendFileSync(
      join(logDirectory, logFile),
      [
        {
          time: new Date(now - 30 * 60_000).toISOString(),
          sessionId: 'previous-run',
          level: 'info',
          message: 'export-fixture-recent'
        },
        {
          time: new Date(now - 2 * 3_600_000).toISOString(),
          sessionId: 'older-run',
          level: 'error',
          message: 'export-fixture-old'
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n'
    )
    const originalSaveDialog = dialog.showSaveDialog
    // Sticky creation intentionally rejects overlap with the visible main
    // window. Reserve real desktop space on the 1024px-wide Windows runner.
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea
    const mainBounds = {
      x: workArea.x + 24,
      y: workArea.y + 24,
      width: Math.min(window.getBounds().width, workArea.width - DEFAULT_STICKY_WIDTH - 48),
      height: Math.min(window.getBounds().height, workArea.height - 48)
    }
    const [minimumWidth, minimumHeight] = window.getMinimumSize()
    assert.ok(
      mainBounds.width >= minimumWidth && mainBounds.height >= minimumHeight,
      `测试桌面无法同时容纳主窗口和真实便利贴：${JSON.stringify({ workArea, mainBounds })}`
    )
    window.setBounds(mainBounds)
    await waitUntil(() => {
      const bounds = window.getBounds()
      return Object.keys(mainBounds).every((key) => bounds[key] === mainBounds[key])
    }, '诊断主窗口没有为真实便利贴留出桌面空间')
    await window.webContents.executeJavaScript(`window.api.createSticky(${evidence.id})`)
    const sticky = await waitUntil(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes('/sticky.html')
        ),
      '便利贴测试窗口未创建'
    )
    const stickyBounds = sticky.getBounds()
    assert.ok(
      stickyBounds.x >= mainBounds.x + mainBounds.width ||
        stickyBounds.x + stickyBounds.width <= mainBounds.x ||
        stickyBounds.y >= mainBounds.y + mainBounds.height ||
        stickyBounds.y + stickyBounds.height <= mainBounds.y,
      '真实便利贴必须出现在主窗口外部'
    )
    await waitUntil(
      () =>
        sticky.webContents.executeJavaScript(
          `window.stickyAPI?.getDiagnosticPolicy().mode === 'deep'`
        ),
      '新便利贴未继承深度模式'
    )
    try {
      await window.webContents.executeJavaScript(`document.querySelector('[title="设置"]').click()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.diagnostics-toggle'))`
          ),
        '设置页高级诊断入口未挂载'
      )
      await window.webContents.executeJavaScript(`(() => {
        const toggle = document.querySelector('.diagnostics-toggle')
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
      })()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.attachment-recovery-status')?.textContent.includes('本轮未发现待恢复操作')`
          ),
        '附件恢复报告未通过真实SettingsPanel读取'
      )
      const recoveryUi = await window.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('.attachment-recovery-status')
        element.scrollIntoView({ block: 'center' })
        return { text: element.textContent, buttons: [...element.querySelectorAll('button')].map(b => b.textContent.trim()) }
      })()`)
      assert.match(recoveryUi.text, /不是全部附件完整性检查/)
      assert.ok(recoveryUi.buttons.includes('重新读取报告'))
      assert.ok(recoveryUi.buttons.includes('查看日志'))
      assert.ok(recoveryUi.buttons.includes('尝试恢复'))
      assert.equal(
        recoveryUi.buttons.some((label) => /重试恢复|重新恢复/.test(label)),
        false
      )
      const recoveryVisuals = await captureAttachmentRecoverySurfaces(window)
      await window.webContents.executeJavaScript(`(() => {
        const reread = Array.from(document.querySelectorAll('.attachment-recovery-status button')).find(button => button.textContent.trim() === '重新读取报告')
        reread.click()
      })()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `!document.querySelector('.attachment-recovery-status button').disabled`
          ),
        '附件恢复报告手动读取未结束'
      )
      assert.deepEqual(
        await window.webContents.executeJavaScript(`window.api.getAttachmentRecoveryReport()`),
        initialRecovery
      )
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.attachment-recovery-status button')).find(button => button.textContent.trim() === '尝试恢复').click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.attachment-recovery-status')?.textContent.includes('本轮附件恢复已结束')`
          ),
        '真实设置页附件恢复未结束'
      )
      expectedRecovery = await window.webContents.executeJavaScript(
        `window.api.getAttachmentRecoveryReport()`
      )
      assert.notEqual(expectedRecovery.roundId, initialRecovery.roundId)
      assert.equal(expectedRecovery.scope, 'pending-attachment-recovery-round')
      assert.equal(expectedRecovery.phase, 'finished')
      assert.equal(expectedRecovery.partial, false)
      assert.equal(expectedRecovery.operations.length, 0)
      attachmentRecoveryEvidence = {
        initialRecovery,
        retriedRecovery: expectedRecovery,
        recoveryUi,
        visuals: recoveryVisuals
      }
      report(
        await window.webContents.executeJavaScript(`JSON.stringify({
        phase: 'before-log-open',
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => el.getAttribute('aria-label'))
      })`)
      )
      const interactions = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'ui.interaction', limit: 20 })`
      )
      assert.ok(
        interactions.items.some((row) => row.phase === 'intent'),
        '控件点击没有留下交互日志'
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `Boolean([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '查看日志'))`
          ),
        '设置页日志入口未出现'
      )
      await window.webContents.executeJavaScript(
        `[...document.querySelectorAll('.attachment-recovery-status button')].find((button) => button.textContent.trim() === '查看日志').click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(`Boolean(document.querySelector('.log-footer'))`),
        '日志窗口未打开'
      )
      for (const range of ['last-hour', 'all']) {
        const filePath = join(testEvidenceRoot, `export-${range}.jsonl`)
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        const label = range === 'last-hour' ? '导出近一小时日志' : '导出全部日志'
        await window.webContents.executeJavaScript(
          `document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
          [...document.querySelectorAll('.log-footer button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`
        )
        await waitUntil(
          () =>
            window.webContents.executeJavaScript(
              `!document.querySelector('.log-footer button').disabled`
            ),
          '导出未完成'
        )
        const exportedRecords = readFileSync(filePath, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        assert.ok(exportedRecords.some((record) => record.message === 'export-fixture-recent'))
        assert.equal(
          exportedRecords.some((record) => record.message === 'export-fixture-old'),
          range === 'all'
        )
        assert.equal(exportedRecords.at(-1).type, 'diagnostic-system')
        assert.deepEqual(exportedRecords.at(-1).snapshot.attachmentRecovery, expectedRecovery)
        const completion = exportedRecords.find((record) => record.type === 'diagnostic-complete')
        assert.equal(completion.exportFinished, true)
        assert.ok(
          completion.manifest.capture.windows.some(
            (item) => item.webContentsId === sticky.webContents.id && item.status === 'complete'
          ),
          '导出没有等待便利贴提交'
        )
        assert.ok(
          exportedRecords.some(
            (record) =>
              record.scope === 'performance.renderer' &&
              record.metadata.wheelEvents > 0 &&
              record.metadata.longTasks.maxMs >= 200
          ),
          '导出缺少滚动期间的性能证据'
        )
        assert.ok(
          exportedRecords.some((record) => record.scope === 'performance.main'),
          '导出缺少主进程性能采样'
        )
        assert.ok(
          exportedRecords.some(
            (record) =>
              record.scope === 'performance.renderer' &&
              record.metadata.reason === 'export' &&
              record.metadata.wheelEvents > 0
          ),
          '点击导出没有补交尚未满 5 秒的 Renderer 批次'
        )
        assert.ok(
          exportedRecords.at(-1).snapshot.runtime.performance.recentSamples.length > 0,
          '系统快照缺少近期采样'
        )
        const operationEntries = exportedRecords
          .filter((record) => record.scope === 'performance.operations')
          .flatMap((record) => record.metadata.entries)
        for (const category of ['ipc', 'database', 'image', 'scheduler', 'logging', 'native']) {
          assert.ok(
            operationEntries.some((entry) => entry.category === category && entry.count > 0),
            `导出缺少 ${category} 耗时归因`
          )
        }
        assert.ok(
          operationEntries.some(
            (entry) => entry.operation === 'thumbnail.decode' && entry.metrics.cacheHits?.total > 0
          )
        )
        assert.ok(
          operationEntries.some(
            (entry) =>
              entry.operation === 'thumbnail.decode' && entry.metrics.cacheMisses?.total > 0
          )
        )
        const renderWork = exportedRecords.filter(
          (record) => record.scope === 'performance.render-work'
        )
        assert.ok(
          renderWork.some((record) =>
            record.metadata.entries.some((entry) => entry.operation === 'refresh.work.month')
          )
        )
        assert.ok(
          renderWork.some((record) =>
            record.metadata.entries.some((entry) => entry.operation === 'layout.calendar-capacity')
          )
        )
        const performanceRecords = exportedRecords.filter((record) =>
          record.scope?.startsWith('performance.')
        )
        assert.ok(!JSON.stringify(performanceRecords).includes(imageBase64), '性能日志泄漏图片数据')
        assert.ok(
          !JSON.stringify(performanceRecords).includes('diagnostic-private-'),
          '性能日志泄漏便签正文'
        )
        assert.equal(
          JSON.stringify(
            exportedRecords.filter((record) => record.scope?.startsWith('performance.'))
          ).includes('performance-private-content-must-not-be-logged'),
          false
        )
        assert.equal(
          exportedRecords[0].metadata.exportScope,
          range === 'all' ? 'all-retained-logs' : 'last-hour'
        )
      }
      dialog.showSaveDialog = async () => ({ canceled: true })
      const canceled = await window.webContents.executeJavaScript(
        "window.api.exportLogs({ range: 'last-hour' })"
      )
      assert.equal(canceled.canceled, true)
      if (process.env.ABANDON_LOG_UI_CAPTURE) {
        // 等待设置页和日志弹窗的入场动画结束后再检查背景适配。
        await wait(900)
        for (const [theme, background] of [
          ['white', '#fff'],
          ['black', '#000'],
          [
            'wallpaper',
            'repeating-linear-gradient(45deg, #457fbb, #ba94c9 80px, #dbbc70 140px, #33424b 200px)'
          ]
        ]) {
          await window.webContents.executeJavaScript(
            `document.body.style.background = ${JSON.stringify(background)}`
          )
          await window.webContents.capturePage()
          await wait(300)
          writeFileSync(
            join(process.env.ABANDON_LOG_UI_CAPTURE, `log-${theme}.png`),
            (await window.webContents.capturePage()).toPNG()
          )
        }
      }
      await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.log-search input')
        input.value = 'search-mode-regression'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await wait(450)
      const countdownBefore = await window.webContents.executeJavaScript(
        `document.querySelector('.log-mode strong').textContent`
      )
      await wait(2200)
      const countdownAfter = await window.webContents.executeJavaScript(
        `document.querySelector('.log-mode strong').textContent`
      )
      assert.notEqual(countdownAfter, countdownBefore, '搜索后深度倒计时停止更新')
      // 从弹窗外改变策略，不能依赖按钮回调或再次查询来刷新界面。
      await window.webContents.executeJavaScript(`window.api.stopDeepDiagnostics()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.log-mode strong').textContent.includes('日常记录')`
          ),
        '搜索后未接收外部停止采集的策略更新'
      )
      await window.webContents.executeJavaScript(`window.api.startDeepDiagnostics()`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.log-mode strong').textContent.includes('深度排查')`
          ),
        '搜索后未接收外部开始采集的策略更新'
      )
      await window.webContents.executeJavaScript(
        `[...document.querySelectorAll('.log-mode button')].find((button) => button.textContent.trim() === '停止采集').click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(`window.api.getDiagnosticPolicy().mode === 'daily'`),
        '停止按钮没有恢复日常'
      )
      await waitUntil(
        () =>
          sticky.webContents.executeJavaScript(
            `window.stickyAPI.getDiagnosticPolicy().mode === 'daily'`
          ),
        '便利贴未停止深度采集'
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.log-mode button')?.textContent.includes('开启深度排查') && !document.querySelector('.log-mode button').disabled`
          ),
        '日常模式按钮未恢复'
      )
      await window.webContents.executeJavaScript(
        `document.querySelector('.log-mode button').click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(`window.api.getDiagnosticPolicy().mode === 'deep'`),
        '开始按钮未开启深度采集'
      )
    } finally {
      dialog.showSaveDialog = originalSaveDialog
    }
    // 复用同一个真实主窗口，覆盖列表/月/周及原生窗口前后状态证据。
    for (const mode of ['list', 'week']) {
      await window.webContents.executeJavaScript(`window.api.switchMainView('${mode}')`)
      const page = mode === 'list' ? 'index' : mode
      await waitUntil(
        () =>
          !window.webContents.isLoadingMainFrame() &&
          window.webContents.getURL().endsWith('/' + page + '.html'),
        `${mode} 视图没有加载`
      )
      await waitUntil(() => window.isVisible(), `${mode} 窗口没有显示`)
      const performanceReady = await window.webContents.executeJavaScript(
        `window.api.queryLogs({ search: 'performance.renderer-ready', limit: 40 })`
      )
      assert.ok(
        performanceReady.items.some((row) => row.metadata.page === page + '.html'),
        `${mode} 视图未安装性能采集`
      )
      if (mode === 'list') {
        await waitUntil(
          () =>
            window.webContents.executeJavaScript(
              `Boolean(document.querySelector('[data-note-id="${evidence.id}"] [data-diagnostic-action="note.status.change"]'))`
            ),
          '列表未显示测试便签'
        )
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-note-id="${evidence.id}"] [data-diagnostic-action="note.status.change"]').click()`
        )
        await waitUntil(
          async () =>
            (await window.webContents.executeJavaScript(`window.api.getNote(${evidence.id})`))
              ?.status === 'completed',
          '真实状态控件未完成便签'
        )
      } else {
        await window.webContents.executeJavaScript(
          `window.api.updateNote(${evidence.id}, { content: 'diagnostic-private-week' })`
        )
      }
      await waitUntil(async () => {
        const logs = await window.webContents.executeJavaScript(
          `window.api.queryLogs({ search: 'view.data-applied', limit: 100 })`
        )
        return logs.items.some(
          (row) =>
            row.metadata.view === mode &&
            row.metadata.causeActionIds?.length &&
            row.metadata.notes?.some(
              (note) => note.id === evidence.id && (mode !== 'list' || note.status === 'completed')
            )
        )
      }, `${mode} 视图变更没有形成数据应用证据`)
    }
    const windowLogs = await window.webContents.executeJavaScript(
      `window.api.queryLogs({ search: 'view.switch', limit: 100 })`
    )
    assert.ok(
      windowLogs.items.some(
        (row) =>
          row.process === 'main' && row.phase === 'received' && row.metadata.windowState?.bounds
      )
    )
    assert.ok(
      windowLogs.items.some(
        (row) =>
          row.process === 'main' && row.phase === 'returned' && row.metadata.windowState?.bounds
      )
    )
    const stopped = await window.webContents.executeJavaScript(`window.api.stopDeepDiagnostics()`)
    assert.equal(stopped.mode, 'daily')
    assert.equal(stopped.diagnostics.writer.status, 'ready')
    assert.ok(stopped.producers.some((producer) => producer.windowRole === 'sticky'))
    const closedId = sticky.webContents.id
    await sticky.webContents.executeJavaScript(`
      window.stickyAPI.reportLog({ level: 'info', scope: 'close-prime', message: 'prime transport interval' })
      window.stickyAPI.reportLog({ level: 'error', scope: 'close-pending-error', message: 'pending before close' })
      void window.stickyAPI.close(); true
    `)
    await waitUntil(() => sticky.isDestroyed(), '便利贴未关闭')
    const closeLogs = await window.webContents.executeJavaScript(
      `window.api.queryLogs({ search: 'close-pending-error', limit: 100 })`
    )
    assert.equal(
      closeLogs.items.filter((row) => row.scope === 'close-pending-error').length,
      1,
      '关闭前被限频的错误没有提交'
    )
    async function exportAfterClose(name) {
      const filePath = join(testEvidenceRoot, name + '.jsonl')
      const saveDialog = dialog.showSaveDialog
      try {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        await window.webContents.executeJavaScript(`window.api.exportLogs({ range: 'all' })`)
      } finally {
        dialog.showSaveDialog = saveDialog
      }
      return readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse)
    }
    const afterClose = await exportAfterClose('after-normal-close')
    assert.equal(afterClose.filter((row) => row.scope === 'close-pending-error').length, 1)
    const closeCompletion = afterClose.find((row) => row.type === 'diagnostic-complete')
    assert.equal(closeCompletion.complete, true, '正常关闭后没有恢复准确的完整导出状态')
    assert.ok(
      closeCompletion.manifest.capture.windows.some(
        (item) =>
          item.webContentsId === closedId &&
          item.lifecycle === 'destroyed' &&
          item.status === 'complete'
      ),
      '正常关闭的便利贴没有保留最终提交确认'
    )

    await window.webContents.executeJavaScript(`window.api.createSticky(${evidence.id})`)
    const forced = await waitUntil(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes('/sticky.html')
        ),
      '强制关闭测试窗口未创建'
    )
    const forcedId = forced.webContents.id
    await waitUntil(async () => {
      const state = await window.webContents.executeJavaScript(`window.api.getDiagnosticState()`)
      return state.producers.some((item) => item.webContentsId === forcedId)
    }, '强制关闭测试窗口未注册诊断')
    forced.destroy()
    const afterForced = await exportAfterClose('after-forced-close')
    const forcedCompletion = afterForced.find((row) => row.type === 'diagnostic-complete')
    assert.equal(forcedCompletion.complete, false, '未确认提交的窗口销毁仍被标为完整导出')
    assert.ok(
      forcedCompletion.manifest.capture.windows.some(
        (item) => item.webContentsId === forcedId && item.status === 'partial'
      ),
      '导出未列出已销毁窗口的缺失状态'
    )
    // A deliberately destroyed outsider also owns a diagnostic producer. Create
    // it after the normal/forced-close completeness assertions, preserving both.
    attachmentRecoveryEvidence.outsiderRecovery = await verifyAttachmentRecoveryOutsider()
    destroyedConsoleRegression = await verifyDestroyedWindowConsole(window)
    report(
      'queued Chromium warning/error survive real BrowserWindow destruction without uncaught errors'
    )
    report(
      'daily/deep transitions, search countdown/policy updates, sticky close drain, forced-close completeness, database readback, performance sampling and cross-window exports passed'
    )
    report(
      JSON.stringify({
        phase: 'before-final-evidence',
        visible: window.isVisible(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        bounds: window.getBounds(),
        url: window.webContents.getURL(),
        renderer: await window.webContents.executeJavaScript(
          `({visibility: document.visibilityState, focused: document.hasFocus()})`
        )
      })
    )
    // Prepare fresh foreground frames before evidence capture; a visible/focused
    // window alone does not establish that the compositor has presented a frame.
    window.show()
    window.focus()
    window.webContents.invalidate()
    await waitUntil(() => window.isFocused(), '最终截图主窗口未进入前台')
    await window.webContents.executeJavaScript(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    report(
      JSON.stringify({
        phase: 'final-evidence-ready',
        focused: window.isFocused(),
        renderer: await window.webContents.executeJavaScript(
          `({visibility: document.visibilityState, focused: document.hasFocus()})`
        )
      })
    )
    completed = true
  } catch (error) {
    failure = error
    report(error?.stack || String(error))
    if (activeWindow && !activeWindow.isDestroyed()) {
      failureUi = await activeWindow.webContents
        .executeJavaScript(
          `(async () => ({
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({
          label: el.getAttribute('aria-label'),
          buttons: [...el.querySelectorAll('button')].map(button => button.textContent.trim())
        })),
        holidayNotice: await window.api.getHolidayDataNotice()
      }))()`
        )
        .catch((error) => ({ collectionError: error.message }))
      report(JSON.stringify(failureUi))
    }
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      window: activeWindow,
      summary: {
        failureUi,
        destroyedConsoleRegression,
        attachmentRecoveryEvidence,
        exports: [
          'export-last-hour.jsonl',
          'export-all.jsonl',
          'after-normal-close.jsonl',
          'after-forced-close.jsonl'
        ]
      }
    })
  }
}
