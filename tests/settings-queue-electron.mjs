import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/settings-queue-electron.mjs',
  mode: 'electron-ready-real-app-settings-queue-sections',
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    sqlite: 'real-disk',
    resetFailure: 'real-second-view-scope-delete-trigger',
    ordinarySaveFailure: 'real-font-size-insert-and-update-SQLite-triggers',
    failureThemeScreenshots: ['white', 'black', 'complex-wallpaper'],
    viewModes: ['list', 'month', 'week'],
    osAutoStartModified: false,
    nativeBlurEnableVerified: false,
    mainProcessRestart: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-settings-queue-' })
const userData = profile.directory
app.setPath('userData', userData)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(userData, 'app.db'))
seed.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name,key))`)
const put = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false']),
  ['month', 'css', 'font_size_base', '23'],
  ['week', 'css', 'font_size_base', '21']
])
  put.run(...row)
seed.close()

let current,
  completed = false,
  failure = null,
  shuttingDown = false
let reachedWillQuit = false,
  cleanupTimer,
  evidence = { status: 'incomplete' }
const cleanupErrors = [],
  verifiedViews = [],
  layouts = [],
  failureScreenshots = [],
  resetOutcomes = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const js = (source) => current.webContents.executeJavaScript(source)
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(30)
  }
  throw new Error(label)
}
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function section(title) {
  return js(`(() => {
    const heading = [...document.querySelectorAll('.section-title')].find(el => el.textContent.trim() === ${JSON.stringify(title)})
    heading.closest('section').scrollIntoView({block:'center'})
    return Boolean(heading)
  })()`)
}
async function open() {
  await click('.titlebar-btn-settings')
  await until(() => exists('.settings-panel.active'), 'settings did not open')
  await wait(400)
}
async function close() {
  await click('.panel-close-btn')
  await until(async () => !(await exists('.settings-panel')), 'settings did not unmount')
}
async function view(mode) {
  if (current) await js(`window.api.switchMainView(${JSON.stringify(mode)})`)
  const filename = mode === 'list' ? 'index' : mode
  await until(() => {
    current = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/' + filename + '.html')
    )
    return current
  }, mode + ' window')
  await until(() => exists('.titlebar-btn-settings'), mode + ' ready')
}
async function requestReset() {
  await js(
    `Array.from(document.querySelectorAll('.settings-panel .base-btn')).find(button => button.textContent.includes('恢复默认设置')).click()`
  )
  await until(() => exists('.confirm-card.active'), 'reset confirmation')
  await click('.confirm-actions button:last-child')
}

async function captureFailureThemes() {
  const saved = await js(
    `({root:document.documentElement.style.cssText,app:document.querySelector('.app-root').style.cssText})`
  )
  try {
    for (const theme of [
      { name: 'white', background: '255 255 255', text: '#18181b', image: 'none' },
      { name: 'black', background: '16 16 18', text: '#f4f4f5', image: 'none' },
      {
        name: 'complex-wallpaper',
        background: '32 39 51',
        text: '#f4f4f5',
        image:
          'repeating-linear-gradient(135deg,#193e54 0 25px,#916343 25px 50px,#303948 50px 80px)'
      }
    ]) {
      await js(`(()=>{
        document.documentElement.style.setProperty('--bg-color',${JSON.stringify(theme.background)});
        document.documentElement.style.setProperty('--text-color',${JSON.stringify(theme.text)});
        document.querySelector('.app-root').style.backgroundImage=${JSON.stringify(theme.image)};
        const banner=document.querySelector('.settings-save-error');banner.scrollTop=banner.scrollHeight
      })()`)
      await wait(100)
      const bounds = await js(`(()=>{
        const banner=document.querySelector('.settings-save-error'),button=banner.querySelector('[data-settings-save-retry]');
        return {banner:banner.getBoundingClientRect().toJSON(),button:button.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight,
          text:banner.textContent.trim(),color:getComputedStyle(banner).color,background:getComputedStyle(document.querySelector('.settings-panel')).backgroundColor}
      })()`)
      assert.ok(
        bounds.banner.left >= -1 && bounds.banner.right <= bounds.width + 1,
        theme.name + ' save-error overflow'
      )
      assert.ok(
        bounds.button.top >= bounds.banner.top - 1 &&
          bounds.button.bottom <= bounds.banner.bottom + 1 &&
          bounds.button.bottom <= bounds.height + 1,
        theme.name + ' retry must remain visible inside the failure region'
      )
      const file = `settings-queue-save-failure-${theme.name}.png`
      const png = (await current.webContents.capturePage()).toPNG()
      writeFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR || userData, file), png, {
        flag: 'wx'
      })
      failureScreenshots.push({
        theme: theme.name,
        file,
        sha256: createHash('sha256').update(png).digest('hex'),
        bounds,
        scope:
          'temporary CSS-only theme on the real 360px settings panel; original styles restored without saving'
      })
    }
  } finally {
    await js(
      `(()=>{document.documentElement.style.cssText=${JSON.stringify(saved.root)};document.querySelector('.app-root').style.cssText=${JSON.stringify(saved.app)}})()`
    )
  }
}

async function verifyOrdinarySaveFailure() {
  const before = await js(
    'window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.css.fontSizeBase)'
  )
  const requested = before === 20 ? 18 : 20
  const faultDb = new Database(join(userData, 'app.db'))
  const dropTriggers = () =>
    faultDb.exec(
      `DROP TRIGGER IF EXISTS settings_queue_reject_font_insert; DROP TRIGGER IF EXISTS settings_queue_reject_font_update;`
    )
  try {
    faultDb.exec(`
      CREATE TRIGGER settings_queue_reject_font_insert BEFORE INSERT ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected ordinary settings save failure'); END;
      CREATE TRIGGER settings_queue_reject_font_update BEFORE UPDATE ON app_settings
      WHEN NEW.window_name='main' AND NEW.key='font_size_base'
      BEGIN SELECT RAISE(ABORT,'injected ordinary settings save failure'); END;`)
    await section('基础样式')
    await js(`(()=>{
      const input=document.querySelector('[data-diagnostic-action="settings.fontSizeBase"] input');
      input.value=${JSON.stringify(String(requested))};input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
    })()`)
    await until(
      () => exists('.settings-save-error'),
      'automatic ordinary save rejection must be visible'
    )
    assert.equal(
      await js('window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.css.fontSizeBase)'),
      before,
      'failed ordinary write cannot change the real stored value'
    )
    assert.equal(
      await js(
        `Number(document.querySelector('[data-diagnostic-action="settings.fontSizeBase"] input').value)`
      ),
      requested,
      'failed intent stays available to retry'
    )
    assert.equal(
      await js(`document.querySelector('.settings-save-error').textContent.includes('字体大小')`),
      true,
      'failure identifies the actual product setting'
    )
    await click('.panel-close-btn')
    await wait(450)
    assert.equal(
      await exists('.settings-panel.active'),
      true,
      'ordinary save rejection keeps the settings panel open'
    )
    assert.equal(
      await js(`document.querySelector('.settings-controls').disabled`),
      false,
      'rejected close restores interactive controls'
    )
    await captureFailureThemes()
    dropTriggers()
    await click('[data-settings-save-retry]')
    await until(
      async () => !(await exists('.settings-save-error')),
      'explicit save retry must clear the failure'
    )
    await until(
      () =>
        js(
          `window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.css.fontSizeBase===${requested})`
        ),
      'explicit retry persists the original requested value'
    )
    await close()
    await open()
    assert.equal(
      await js(
        `Number(document.querySelector('[data-diagnostic-action="settings.fontSizeBase"] input').value)`
      ),
      requested,
      'saved retry value survives real panel remount'
    )
    assert.equal(await exists('.settings-save-error'), false)
  } finally {
    dropTriggers()
    faultDb.close()
  }
}

async function shutdown(error = null) {
  if (shuttingDown) return
  shuttingDown = true
  failure = error
  process.exitCode = error ? 1 : 0
  clearTimeout(timeout)
  try {
    const output = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
    const summary = {
      completed,
      verifiedViews,
      layouts,
      failureScreenshots,
      resetOutcomes,
      error: error?.stack || null
    }
    if (current && !current.isDestroyed()) {
      const image = await current.webContents.capturePage()
      const png = image.toPNG()
      writeFileSync(join(output, 'settings-queue-final.png'), png, { flag: 'wx' })
      summary.screenshotSha256 = createHash('sha256').update(png).digest('hex')
    }
    writeFileSync(join(output, 'settings-queue-evidence.json'), JSON.stringify(summary, null, 2), {
      flag: 'wx'
    })
    evidence = {
      status: 'complete',
      artifacts: [
        'settings-queue-evidence.json',
        ...failureScreenshots.map(({ file }) => file),
        ...(summary.screenshotSha256 ? ['settings-queue-final.png'] : [])
      ]
    }
  } catch (error) {
    evidence = { status: 'failed', error: error.message }
    process.exitCode = 1
  }
  cleanupTimer = setTimeout(() => app.exit(1), 12000)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch (error) {
      cleanupErrors.push(error.message)
      process.exitCode = 1
    }
  }
  app.quit()
}
app.once('will-quit', () => {
  reachedWillQuit = true
})
app.once('quit', (_event, code) => {
  clearTimeout(cleanupTimer)
  const windowsClosed = BrowserWindow.getAllWindows().every((win) => win.isDestroyed())
  recorder.finish({
    completed,
    error: failure,
    evidence,
    profileOwnership: profile.ownership,
    cleanup: {
      status:
        reachedWillQuit && windowsClosed && !cleanupErrors.length
          ? profile.ownership === 'runner'
            ? 'complete'
            : 'preserved'
          : 'failed',
      reachedWillQuit,
      windowsClosed,
      exitCode: code,
      errors: cleanupErrors,
      scope: 'Real before-quit/window disposal; runner removes owned profile after child exit'
    }
  })
})

async function run() {
  try {
    for (const mode of ['list', 'month', 'week']) {
      await view(mode)
      current.setSize(mode === 'list' ? 360 : 850, 820)
      await open()
      assert.deepEqual(
        await js(
          `Array.from(document.querySelectorAll('[data-settings-category]'), el => el.dataset.settingsCategory)`
        ),
        ['appearance', 'window', 'notes', 'weather', 'system']
      )
      assert.equal(await section('贴边隐藏'), true)
      await wait(100)
      const layout = await js(`(() => {
        const root = document.querySelector('.dock-reveal-mode-selector').closest('section')
        const modes = root.querySelector('.dock-reveal-mode-selector').getBoundingClientRect()
        const label = root.querySelector('.setting-label').getBoundingClientRect()
        const row = root.querySelector('.setting-item')
        const ordinary = document.querySelector('[data-settings-category="appearance"] .setting-item')
        return { viewportWidth: innerWidth, modes: modes.toJSON(), label: label.toJSON(),
          rowBackground: getComputedStyle(row).backgroundColor, ordinaryBackground: getComputedStyle(ordinary).backgroundColor,
          rowFont: getComputedStyle(root.querySelector('.setting-label')).fontSize,
          ordinaryFont: getComputedStyle(ordinary.querySelector('.setting-label')).fontSize,
          buttonLabels: [...root.querySelectorAll('[role="radio"]')].map(button => button.textContent.trim()) }
      })()`)
      layouts.push({ mode, ...layout })
      assert.equal(layout.rowBackground, layout.ordinaryBackground)
      assert.equal(layout.rowFont, layout.ordinaryFont)
      assert.deepEqual(layout.buttonLabels, ['直接唤出', '触边确认', '常显确认'])
      assert.ok(
        layout.modes.left >= 0 && layout.modes.right <= layout.viewportWidth + 1,
        'dock control overflow'
      )
      assert.ok(
        layout.modes.top >= layout.label.bottom - 1 || layout.modes.left >= layout.label.right - 1,
        'dock control overlaps label'
      )

      await js(`document.querySelectorAll('.dock-reveal-mode-selector button')[2].click()`)
      await until(
        () =>
          js(
            `window.api.getSettingsSnapshot().then(snapshot => snapshot.values.dock.revealHandleMode === 'persistent')`
          ),
        'dock mode not persisted'
      )
      const edgesBefore = await js(
        'window.api.getSettingsSnapshot().then(snapshot => snapshot.values.dock.enabledEdges)'
      )
      await click('.dock-edge-selector button:first-child')
      await until(
        () =>
          js(
            `window.api.getSettingsSnapshot().then(snapshot => snapshot.values.dock.enabledEdges.includes('top') === ${!edgesBefore.includes('top')})`
          ),
        'dock edge not persisted'
      )
      assert.equal(
        await js(
          `document.querySelector('.dock-edge-selector button:first-child').getAttribute('aria-pressed')`
        ),
        String(!edgesBefore.includes('top'))
      )

      const stickyVisible = await js(
        `Boolean([...document.querySelectorAll('.section-title')].find(el => el.textContent.trim() === '便利贴'))`
      )
      assert.equal(stickyVisible, mode === 'list')
      if (mode === 'list') {
        await section('便利贴')
        await wait(100)
        const stickyFont = '[data-diagnostic-action="settings.stickyFontSize"] input'
        await js(
          `(() => { const input = document.querySelector(${JSON.stringify(stickyFont)}); input.value='26'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})) })()`
        )
        // Close before 300ms debounce: the queue must still save the final intent.
        await close()
        assert.equal(
          await js(
            'window.api.getSettingsSnapshot().then(snapshot => snapshot.values.sticky.fontSize)'
          ),
          26
        )
        await open()
        await section('便利贴')
        await wait(100)
        const trigger = '.settings-color-control [aria-label^="默认背景颜色："]'
        await click(trigger)
        await until(() => exists('.settings-control-panel .color-hex-input'), 'sticky color popup')
        const initial = await js(
          'window.api.getSettingsSnapshot().then(snapshot => snapshot.values.sticky.backgroundColor)'
        )
        await js(
          `(() => { const input=document.querySelector('.settings-control-panel .color-hex-input'); input.value='#badzzz'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})) })()`
        )
        assert.equal(
          await js(
            `document.querySelector('.settings-control-panel .color-hex-input').classList.contains('has-error')`
          ),
          true
        )
        assert.equal(
          await js(
            'window.api.getSettingsSnapshot().then(snapshot => snapshot.values.sticky.backgroundColor)'
          ),
          initial
        )
        await js(
          `(() => { const input=document.querySelector('.settings-control-panel .color-hex-input'); input.value=' #AbC '; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})) })()`
        )
        await until(
          () =>
            js(
              `window.api.getSettingsSnapshot().then(snapshot => snapshot.values.sticky.backgroundColor === '#aabbcc')`
            ),
          'sticky normalized color not persisted'
        )
        const popupBounds = await js(
          `document.querySelector('.settings-control-panel').getBoundingClientRect().toJSON()`
        )
        assert.ok(
          popupBounds.left >= -1 && popupBounds.right <= layout.viewportWidth + 1,
          'sticky popup overflow'
        )
        await js(
          `document.querySelector('.settings-control-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`
        )
        await until(
          async () => !(await exists('.settings-control-panel')),
          'color popup did not leave'
        )
        assert.equal(await exists('.settings-panel.active'), true)
        assert.equal(await js(`document.activeElement.matches(${JSON.stringify(trigger)})`), true)
        const remembered = await js(`document.querySelector('.panel-body').scrollTop`)
        await close()
        await open()
        assert.ok(
          Math.abs((await js(`document.querySelector('.panel-body').scrollTop`)) - remembered) < 3,
          'section scroll lost on remount'
        )

        await verifyOrdinarySaveFailure()

        // Real DB failure in the view step verifies UI rejection/reload and the next user operation.
        const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
        assert.ok(hooks, 'existing tray integration hook')
        hooks
          .getTrayMenuTemplate()
          .find((item) => item.id === 'toggle-global-shortcuts')
          .click()
        await wait(500)
        const beforeReset = await js('window.api.getSettingsSnapshot()')
        assert.equal(beforeReset.values.shortcuts.enabled, false)
        const faultDb = new Database(join(userData, 'app.db'))
        const readRows = () =>
          faultDb
            .prepare(
              'SELECT window_name,type,key,value,remark FROM app_settings ORDER BY window_name,key'
            )
            .all()
        const beforeRows = readRows()
        const otherRows = beforeRows.filter(
          (row) => row.window_name === 'month' || row.window_name === 'week'
        )
        faultDb.exec(
          `CREATE TRIGGER settings_queue_reject_view_reset BEFORE DELETE ON app_settings WHEN OLD.window_name='main' BEGIN SELECT RAISE(ABORT,'injected settings queue view reset failure'); END;`
        )
        try {
          await requestReset()
          await until(
            () =>
              js(
                `document.querySelector('.settings-panel')?.classList.contains('is-resetting') === false && document.body.textContent.includes('恢复默认设置失败')`
              ),
            'reset error did not restore writable UI'
          )
          const failedReset = await js('window.api.getSettingsSnapshot()')
          assert.equal(
            failedReset.values.sticky.backgroundColor,
            '#aabbcc',
            'application scope must survive failed view reset'
          )
          assert.deepEqual(
            readRows(),
            beforeRows,
            'application, current view, other scopes and geometry must survive failed reset'
          )
          assert.deepEqual(
            failedReset.values,
            beforeReset.values,
            'failed reset must preserve resolved configuration'
          )
          assert.equal(
            failedReset.revision,
            beforeReset.revision,
            'failed reset must not advance runtime revision'
          )
          assert.equal(
            failedReset.values.shortcuts.enabled,
            false,
            'failed reset preserves the session-only gate'
          )
          assert.deepEqual(
            failedReset.runtime.shortcuts,
            beforeReset.runtime.shortcuts,
            'failed reset must not initialize shortcut services'
          )
          assert.equal(
            await js(`Boolean(document.querySelector('.settings-controls:not(:disabled)'))`),
            true
          )
        } finally {
          faultDb.exec('DROP TRIGGER settings_queue_reject_view_reset')
          faultDb.close()
        }
        await section('便利贴')
        await click('[data-diagnostic-action="settings.stickyAlwaysOnTop"]')
        const requested = await js(
          `document.querySelector('[data-diagnostic-action="settings.stickyAlwaysOnTop"]').getAttribute('aria-checked') === 'true'`
        )
        await close()
        assert.equal(
          await js(
            'window.api.getSettingsSnapshot().then(snapshot => snapshot.values.sticky.alwaysOnTop)'
          ),
          requested,
          'next write after reset rejection'
        )
        await open()
        const beforeRetry = await js('window.api.getSettingsSnapshot()')
        await requestReset()
        await until(
          () =>
            js(
              `document.querySelector('.settings-panel')?.classList.contains('is-resetting') === false && document.body.textContent.includes('默认设置已保存，应用结果尚待确认')`
            ),
          'same reset retry did not preserve the saved-but-unconfirmed application result'
        )
        // Reset includes capture theme. Its production port only confirms the
        // invocation, so a successful SQL reset must not claim full application.
        const application = await js('window.api.getSettingsApplicationState()')
        const applicationUi = await js(`(() => {
          const root=document.querySelector('[data-settings-application-status]');
          return { state:root?.dataset.state, text:root?.textContent || '',
            theme:root?.querySelector('[data-application-target="dependency:theme"]')?.textContent || '',
            unsaved:Boolean(document.querySelector('.settings-save-error')) };
        })()`)
        assert.equal(application.ledger.dependencies.theme.status, 'unconfirmed')
        assert.equal(
          application.ledger.dependencies.theme.error,
          '截图主题已请求，宿主未提供应用确认'
        )
        assert.equal(applicationUi.state, 'unconfirmed')
        assert.match(applicationUi.theme, /应用尚待确认/)
        assert.doesNotMatch(applicationUi.text, /已保存，已应用/)
        assert.equal(applicationUi.unsaved, false, 'committed reset is not an unsaved write')
        const retry = await js('window.api.getSettingsSnapshot()')
        resetOutcomes.push({
          mode,
          application,
          applicationUi,
          beforeRevision: beforeRetry.revision,
          revision: retry.revision
        })
        assert.equal(
          retry.values.sticky.backgroundColor,
          createDefaultSettings('list').sticky.backgroundColor
        )
        assert.equal(
          retry.values.shortcuts.enabled,
          false,
          'successful reset preserves session gate'
        )
        assert.ok(retry.revision > beforeRetry.revision, 'successful reset advances revision')
        await wait(1000)
        const verifyDb = new Database(join(userData, 'app.db'), { readonly: true })
        try {
          assert.deepEqual(
            verifyDb
              .prepare(
                "SELECT window_name,type,key,value,remark FROM app_settings WHERE window_name IN ('month','week') ORDER BY window_name,key"
              )
              .all(),
            otherRows,
            'successful current-view reset keeps other views'
          )
          assert.deepEqual(
            verifyDb
              .prepare(
                "SELECT key FROM app_settings WHERE window_name='main' AND key IN ('pos_x','pos_y','width','height')"
              )
              .all(),
            [],
            'reset cancels geometry timers and does not reinsert cleared geometry'
          )
        } finally {
          verifyDb.close()
        }
        await close()
        const welcome = '[aria-label="欢迎使用 Abandon 便签"]'
        if (await exists(welcome)) {
          await js(
            `Array.from(document.querySelectorAll('.app-modal-footer button')).find(button => button.textContent.includes('已阅读')).click()`
          )
          await until(
            async () => !(await exists(welcome)),
            'welcome completion after successful reset'
          )
        }
        await open()
      }
      const searchWord = mode === 'list' ? '便利贴' : '隐藏后的唤出方式'
      await js(
        `(() => { const input=document.querySelector('.settings-search input'); input.value=${JSON.stringify(searchWord)}; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
      )
      await until(() => exists('.settings-search-results button'), 'section search result')
      await click('.settings-search-results button')
      await until(
        () => js(`Boolean(document.activeElement.closest('.settings-section'))`),
        'section search focus'
      )
      await close()
      verifiedViews.push(mode)
    }
    completed = true
    await shutdown()
  } catch (error) {
    console.error(error)
    await shutdown(error)
  }
}
const timeout = setTimeout(() => void shutdown(new Error('Settings queue GUI timed out')), 90000)
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk, 'built main chunk')
require(resolve('out/main/chunks', chunk))
