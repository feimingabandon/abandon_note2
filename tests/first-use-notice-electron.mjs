import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[first-use-e2e] ${message}\n`)
const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-first-use-e2e-'))

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
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
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getMainWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

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
  seedListView(testUserData)
  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  if (app.isReady()) void runFirstUseTests()
  else app.once('ready', () => void runFirstUseTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runFirstUseTests() {
  let exitCode = 0
  try {
    report('electron app ready')
    const mainWindow = await waitUntil(() => getMainWindow(), '列表主窗口未创建')
    report('list window created')
    await waitUntil(() => mainWindow.isVisible(), '列表主窗口未显示')
    report('list window visible')
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="欢迎使用 Abandon 便签"]'))`
        ),
      '首次使用须知没有显示'
    )

    const initialUi = await mainWindow.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('[aria-label="欢迎使用 Abandon 便签"] h2')?.textContent?.trim(),
      hasClose: Boolean(document.querySelector('[aria-label="欢迎使用 Abandon 便签"] .app-modal-close')),
      openingYear: document.querySelector('.opening-year')?.textContent?.trim(),
      openingCopy: document.querySelector('.opening-copy')?.textContent?.trim(),
      hasRealNotice: document.body.innerText.includes('最后，还有几件真正需要告诉你的事'),
      buttons: Array.from(document.querySelectorAll('.app-modal-footer button'), (button) => button.textContent.trim())
    }))()`)
    assert.equal(initialUi.title, '欢迎使用 Abandon 便签')
    assert.equal(initialUi.hasClose, false)
    assert.equal(initialUi.openingYear, '2025')
    assert.equal(initialUi.openingCopy, '年，是一切罪恶的开始。')
    assert.equal(initialUi.hasRealNotice, true)
    assert.match(initialUi.buttons[0], /赞赏作者/)
    assert.equal(initialUi.buttons[1], '白嫖一下，已阅读')

    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await wait(120)
    assert.equal(
      await mainWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="欢迎使用 Abandon 便签"]'))`
      ),
      true,
      'Escape 不应跳过首次须知'
    )

    await mainWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('.mission-line')?.scrollIntoView({ block: 'center' })
    })()`)
    await wait(720)

    await mainWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-modal-footer button'))
        .find((candidate) => candidate.textContent.includes('赞赏作者'))
      button?.click()
    })()`)
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="感谢你的支持"]')) && document.querySelectorAll('.qr-card img').length === 2`
        ),
      '赞赏页面没有显示'
    )
    const supportUi = await mainWindow.webContents.executeJavaScript(`(() => ({
      qrCount: document.querySelectorAll('.qr-card img').length,
      labels: Array.from(document.querySelectorAll('.qr-card figcaption strong'), (node) => node.textContent.trim()),
      buttons: Array.from(document.querySelectorAll('.app-modal-footer button'), (button) => button.textContent.trim())
    }))()`)
    assert.equal(supportUi.qrCount, 2)
    assert.deepEqual(supportUi.labels, ['微信赞赏', '支付宝'])
    assert.deepEqual(supportUi.buttons, ['返回须知', '完成，进入 Abandon'])

    await mainWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-modal-footer button'))
        .find((candidate) => candidate.textContent.includes('完成，进入 Abandon'))
      button?.click()
    })()`)
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `!document.querySelector('[aria-label="感谢你的支持"]')`
        ),
      '完成赞赏流程后首次须知没有关闭'
    )

    const db = new Database(join(testUserData, 'app.db'), { readonly: true })
    const stored = db
      .prepare(
        `SELECT value FROM app_settings
         WHERE window_name = 'application' AND key = 'first_use_notice_version'`
      )
      .get()
    db.close()
    assert.equal(stored?.value, '1')

    const toastText = await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.msg-toast')?.textContent || ''`
    )
    assert.match(toastText, /感谢你的支持/)
    const toastLayout = await mainWindow.webContents.executeJavaScript(`(() => {
      const text = document.querySelector('.msg-text')
      const toast = document.querySelector('.msg-toast')
      const style = text ? getComputedStyle(text) : null
      return {
        whiteSpace: style?.whiteSpace,
        overflowWrap: style?.overflowWrap,
        toastHeight: toast?.getBoundingClientRect().height || 0,
        textHeight: text?.getBoundingClientRect().height || 0,
        lineHeight: style ? Number.parseFloat(style.lineHeight) : 0
      }
    })()`)
    assert.equal(toastLayout.whiteSpace, 'pre-wrap')
    assert.equal(toastLayout.overflowWrap, 'anywhere')
    assert.ok(toastLayout.textHeight > toastLayout.lineHeight, '长消息应自然换成多行')
    assert.ok(toastLayout.toastHeight > 44, '多行消息应随内容增加高度')

    await mainWindow.webContents.executeJavaScript(`window.api.resetSettings()`)
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="欢迎使用 Abandon 便签"]'))`
        ),
      '恢复默认设置后首次使用须知没有重新显示'
    )

    const resetDb = new Database(join(testUserData, 'app.db'), { readonly: true })
    const resetStored = resetDb
      .prepare(
        `SELECT window_name, type, key, value FROM app_settings
         WHERE window_name = 'application' AND key = 'first_use_notice_version'`
      )
      .get()
    resetDb.close()
    assert.deepEqual(resetStored, {
      window_name: 'application',
      type: 'onboarding',
      key: 'first_use_notice_version',
      value: '0'
    })
    report('all assertions passed')
  } catch (error) {
    exitCode = 1
    report(error?.stack || String(error))
  } finally {
    process.exitCode = exitCode
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      try {
        rmSync(testUserData, { recursive: true, force: true })
      } catch {
        // Crashpad 可能仍持有临时目录，不能让清理失败覆盖真实测试结果。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}
