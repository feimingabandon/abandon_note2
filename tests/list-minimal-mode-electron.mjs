import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[list-minimal-e2e] ${message}\n`)

app.commandLine.appendSwitch('disable-gpu')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const database = new Database(join(userDataPath, 'app.db'))
  database.exec(`
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
  const insert = database.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  database.close()
}

function getViewWindow(mode) {
  const fileName = mode === 'list' ? 'index' : mode
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      new RegExp(`/${fileName}\\.html(?:$|[?#])`).test(window.webContents.getURL())
  )
}

async function waitForView(mode) {
  const window = await waitUntil(() => getViewWindow(mode), `${mode} 主视图没有创建`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__trigger[data-active-view="${mode}"]'))`
      ),
    `${mode} 主视图尚未渲染完成`
  )
  return window
}

async function chooseView(window, mode) {
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__trigger').click()`
  )
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__menu [data-view="${mode}"]'))`
      ),
    `视图菜单中没有 ${mode}`
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__menu [data-view="${mode}"]').click()`
  )
}

async function dispatchDoubleClick(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) return false
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      detail: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }))
    return true
  })()`)
}

async function quickEdit(window, { selector, content, renderedContent }) {
  assert.equal(await dispatchDoubleClick(window, selector), true, `找不到双击目标：${selector}`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.activeElement?.matches('.quick-note-editor textarea') === true`
      ),
    '双击后没有聚焦快速正文编辑器'
  )
  await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.quick-note-editor textarea')
    textarea.value = ${JSON.stringify(content)}
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.app-titlebar, .month-toolbar, body').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    )
  })()`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.quick-note-editor') && Array.from(document.querySelectorAll('.msg-toast'), (node) => node.textContent.trim()).some((text) => text.includes('便签已保存'))`
      ),
    '失焦保存后没有关闭编辑器并显示成功提醒'
  )
  await waitUntil(
    () => window.webContents.executeJavaScript(renderedContent),
    '保存后的正文没有刷新到当前视图'
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-list-minimal-'))

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
  app.once('ready', () => void runMinimalModeTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runMinimalModeTest() {
  try {
    const win = await waitForView('list')
    win.setSize(600, 780)
    const js = (code) => win.webContents.executeJavaScript(code)
    const until = (code, message) => waitUntil(() => js(code), message)
    const ids = await js(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3284b4'; ctx.fillRect(0, 0, 320, 160)
      ctx.fillStyle = '#f4bd59'; ctx.fillRect(80, 20, 120, 100)
      const image = { base64: canvas.toDataURL('image/png').split(',')[1], ext: 'png' }
      const text = await window.api.createNote({ content: '极简开关正文' })
      await window.api.updateNote(text.id, { remark: '辅助备注' })
      const long = await window.api.createNote({ content: Array.from({length: 12}, (_, i) => '长正文第 ' + (i + 1) + ' 行').join('\\n') })
      const mixed = await window.api.createNoteWithAssets({ options: { content: '图片与正文均保留' }, images: [image], tagIds: [] })
      const picture = await window.api.createNoteWithAssets({ options: { content: '' }, images: [image], tagIds: [] })
      return { text: text.id, long: long.id, mixed: mixed.id, picture: picture.id }
    })()`)
    await until(`document.querySelectorAll('.nl-card').length === 4`, '便签未加载')
    const card = (id) => `.nl-card[data-note-id="${id}"]`
    await until(
      `document.querySelector(${JSON.stringify(card(ids.picture) + ' img')})?.naturalWidth > 0`,
      '图片正文未加载'
    )
    const before = await js(`(() => {
      const c = document.querySelector(${JSON.stringify(card(ids.text))})
      return { text: c.querySelector('.nl-card-text').textContent, ring: c.querySelector('.sr-control').getBoundingClientRect().width }
    })()`)
    await js(`document.querySelector('.titlebar-btn-settings').click()`)
    await until(
      `document.querySelector('[data-diagnostic-action="settings.minimalMode"]')?.getAttribute('aria-checked') === 'false'`,
      '设置开关默认值错误'
    )
    await js(`document.querySelector('[data-diagnostic-action="settings.minimalMode"]').click()`)
    await until(
      `document.querySelectorAll('.nl-card--minimal').length === 4 && !document.querySelector('.nl-card-meta, .nl-card-remark-text')`,
      '极简开关未隐藏辅助信息'
    )
    const db = new Database(join(testUserData, 'app.db'), { readonly: true })
    assert.equal(
      db
        .prepare("SELECT value FROM app_settings WHERE window_name='main' AND key='minimal_mode'")
        .get()?.value,
      '1'
    )
    db.close()
    await js(`document.querySelector('.panel-close-btn').click()`)
    await wait(450)
    assert.deepEqual(
      await js(`(() => {
      const c = document.querySelector(${JSON.stringify(card(ids.text))})
      return { text: c.querySelector('.nl-card-text').textContent, ring: c.querySelector('.sr-control').getBoundingClientRect().width }
    })()`),
      before,
      '正文或圆环被极简开关改变'
    )
    await until(
      `document.querySelector(${JSON.stringify(card(ids.mixed) + ' .nl-image-panel-shell--expanded img')})?.naturalWidth > 0`,
      '图文便签附件无法查看'
    )
    // The hidden disclosure remains available from the context menu.
    await js(`(() => {
      const c = document.querySelector(${JSON.stringify(card(ids.long))}); c.scrollIntoView()
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 200 }))
    })()`)
    await until(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).some(b => b.textContent.trim() === '展开内容')`,
      '右键展开入口缺失'
    )
    await js(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).find(b => b.textContent.trim() === '展开内容').click()`
    )
    await wait(500)
    assert.equal(
      await js(
        `document.querySelector(${JSON.stringify(card(ids.long) + ' .nl-card-text-shell')}).classList.contains('nl-card-text-shell--collapsed')`
      ),
      false
    )
    await quickEdit(win, {
      selector: card(ids.text),
      content: '极简模式仍可编辑',
      renderedContent: `document.querySelector(${JSON.stringify(card(ids.text) + ' .nl-card-text')})?.textContent.trim() === '极简模式仍可编辑'`
    })
    await js(`document.querySelector(${JSON.stringify(card(ids.text) + ' .sr-control')}).click()`)
    await until(
      `window.api.getNote(${ids.text}).then(n => n.status === 'completed')`,
      '圆环状态操作失效'
    )
    await wait(800)
    for (const mode of ['custom', 'tag-group', 'timeline']) {
      await js(
        `window.api.setSettingValue('listFilter', { listMode: '${mode}', tagIds: [], statusFilter: [] })`
      )
      if (mode === 'tag-group') {
        await until(`Boolean(document.querySelector('.nl-tag-group-toggle'))`, '标签组未加载')
        await js(`document.querySelector('.nl-tag-group-toggle').click()`)
      }
      await until(
        `document.querySelectorAll('.nl-card--minimal').length === 4`,
        mode + ' 模式未应用极简设置'
      )
      await wait(150)
      assert.equal(await js(`Boolean(document.querySelector('.nl-card-meta'))`), false)
    }
    win.webContents.reload()
    await waitForView('list')
    await until(
      `document.querySelectorAll('.nl-card--minimal').length === 4`,
      '重新加载后未保留开关'
    )
    const output = resolve('tmp', 'list-minimal-mode')
    mkdirSync(output, { recursive: true })
    win.setSize(480, 760)
    for (const [theme, bg, fg] of [
      ['white', '255 255 255', '#202020'],
      ['black', '0 0 0', '#ffffff']
    ]) {
      await js(
        `(async () => { await window.api.setSettingValue('css.bgColor', '${bg}'); await window.api.setSettingValue('css.textColor', '${fg}'); })()`
      )
      await wait(300)
      writeFileSync(join(output, theme + '.png'), (await win.webContents.capturePage()).toPNG())
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('.nl-card')).every(c => c.getBoundingClientRect().right <= innerWidth)`
        ),
        true
      )
    }
    await js(`(async () => {
      await window.api.setSettingValue('css.textColor', '#202020')
      await window.api.setSettingValue('css.bgColor', '255 255 255')
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 760
      const ctx = canvas.getContext('2d')
      for(let y=0; y<760; y+=40) for(let x=0; x<480; x+=40) {
        ctx.fillStyle = (x+y)%80 ? '#c1ddce' : '#e2cfb8'; ctx.fillRect(x,y,40,40)
      }
      const image = { base64: canvas.toDataURL('image/png').split(',')[1], ext: 'png' }
      const wallpaper = await window.api.saveWallpaper({ original: image, cropped: image, crop: { x: 0, y: 0, width: 480, height: 760, scale: 1 } })
      await window.api.activateWallpaper(wallpaper.id)
    })()`)
    await wait(500)
    writeFileSync(join(output, 'wallpaper.png'), (await win.webContents.capturePage()).toPNG())
    await chooseView(win, 'month')
    await waitForView('month')
    await js(`document.querySelector('.titlebar-btn-settings').click()`)
    await until(`Boolean(document.querySelector('.panel-close-btn'))`, '月视图设置未打开')
    assert.equal(
      await js(
        `Boolean(document.querySelector('[data-diagnostic-action="settings.minimalMode"]'))`
      ),
      false,
      '月视图不应显示列表开关'
    )
    assert.equal(
      await js(`window.api.getSettingsSnapshot().then(s => s.values.listAppearance.minimalMode)`),
      false,
      '列表开关不应写入月视图'
    )
    await js(`document.querySelector('.panel-close-btn').click()`)
    await wait(450)
    await chooseView(win, 'list')
    await waitForView('list')
    await until(`document.querySelectorAll('.nl-card--minimal').length === 4`, '切回列表后开关丢失')
    await js(`document.querySelector('.titlebar-btn-settings').click()`)
    await until(
      `document.querySelector('[data-diagnostic-action="settings.minimalMode"]')?.getAttribute('aria-checked') === 'true'`,
      '重新打开设置状态错误'
    )
    await js(`document.querySelector('[data-diagnostic-action="settings.minimalMode"]').click()`)
    await until(
      `document.querySelectorAll('.nl-card-meta').length === 4 && Boolean(document.querySelector('.nl-card-remark-text'))`,
      '关闭后辅助信息未恢复'
    )
    report(
      'PASS UI toggle, SQLite persistence, reload, all list layouts, ring, text, images, context expansion, editing, view isolation and narrow themes'
    )
    app.exit(0)
  } catch (error) {
    const activeWindow = getViewWindow('list')
    if (activeWindow)
      report(
        JSON.stringify(
          await activeWindow.webContents.executeJavaScript(`(async () => ({
      cards: document.querySelectorAll('.nl-card').length,
      metadata: document.querySelectorAll('.nl-card-meta').length,
      remarks: document.querySelectorAll('.nl-card-remark-text').length,
      setting: (await window.api.getSettingsSnapshot()).values.listAppearance,
      toggle: document.querySelector('[data-diagnostic-action="settings.minimalMode"]')?.getAttribute('aria-checked')
    }))()`)
        )
      )
    report(`failed: ${error?.stack || error}`)
    app.exit(1)
  }
}
