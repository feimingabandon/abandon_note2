import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog } from 'electron'

const require = createRequire(import.meta.url)
const testUserData =
  process.env.ABANDON_TEST_USER_DATA ||
  mkdtempSync(join(tmpdir(), 'abandon-note-logging-actions-e2e-'))
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

let exitCode = 0

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
  app.exit(1)
}

async function runTest() {
  try {
    const window = await waitUntil(getMonthWindow, '月视图主窗口未启动')
    await waitUntil(() => window.isVisible(), '月视图主窗口未显示')

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
    try {
      await window.webContents.executeJavaScript(`document.querySelector('[title="设置"]').click()`)
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
        `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '查看日志').click()`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(`Boolean(document.querySelector('.log-footer'))`),
        '日志窗口未打开'
      )
      for (const range of ['last-hour', 'all']) {
        const filePath = join(testUserData, `export-${range}.jsonl`)
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        const label = range === 'last-hour' ? '导出近一小时日志' : '导出全部日志'
        await window.webContents.executeJavaScript(
          `[...document.querySelectorAll('.log-footer button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`
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
    report(
      'startup, database readback, silent-write mismatch, renderer application, interactions, rejection and all/last-hour exports passed'
    )
  } catch (error) {
    exitCode = 1
    report(error?.stack || String(error))
  } finally {
    app.exit(exitCode)
  }
}
