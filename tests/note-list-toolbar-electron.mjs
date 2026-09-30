import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { localDateKey } from '../src/shared/calendar/calendar-date-rules.js'
import { weatherLocationKey } from '../src/shared/weather-rules.js'

const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'abandon-toolbar-'))
const output = resolve('tmp/note-list-toolbar')
mkdirSync(output, { recursive: true })
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const report = (message) => process.stderr.write(`[list-toolbar] ${message}\n`)
let noteQueries = 0
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, (event, ...args) => {
    if (channel.startsWith('notes:query-')) noteQueries++
    return listener(event, ...args)
  })
async function until(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}
function seed() {
  const location = {
    id: 440100,
    name: '广州市',
    admin1: '广东省',
    country: '中国',
    countryCode: 'CN',
    latitude: 23.12911,
    longitude: 113.26439,
    timezone: 'Asia/Shanghai'
  }
  const now = Date.now()
  const db = new Database(join(profile, 'app.db'))
  db.exec(
    'CREATE TABLE app_settings (window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT, remark TEXT DEFAULT "", created_at INTEGER, updated_at INTEGER, PRIMARY KEY (window_name, key))'
  )
  const insert = db.prepare(
    'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
  )
  for (const row of [
    ['application', 'application', 'active_view', 'list'],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['application', 'weather', 'enabled', 'true'],
    ['application', 'weather', 'location', JSON.stringify(location)],
    ['main', 'system', 'blur_enabled', 'false']
  ])
    insert.run(...row)
  db.close()
  mkdirSync(join(profile, 'cache'), { recursive: true })
  writeFileSync(
    join(profile, 'cache/weather.json'),
    JSON.stringify({
      version: 2,
      forecasts: {
        [`${weatherLocationKey(location)}|cma_grapes_global`]: {
          location,
          fetchedAt: now,
          timezone: location.timezone,
          current: null,
          days: [
            {
              date: localDateKey(now),
              weatherCode: 3,
              dailyWeatherCode: 3,
              label: '阴',
              icon: '☁️',
              temperatureMin: 26,
              temperatureMax: 34,
              precipitation: 2.5,
              precipitationProbability: 70,
              windSpeedMax: 12
            }
          ],
          source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' }
        }
      }
    })
  )
}
let win
const js = (code) => win.webContents.executeJavaScript(code)
async function move(selector) {
  const point = selector
    ? await js(
        `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)} })()`
      )
    : { x: 2, y: 400 }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await wait(30)
  return point
}
async function click(selector) {
  const point = await move(selector)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
const geometry = () =>
  js(`(() => {
  const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON()
  return {toolbar:rect('.nl-toolbar'),group:rect('.sg-root'),taiji:rect('.sg-btn--taiji'),weather:rect('.nl-toolbar-left'),almanac:rect('.nl-toolbar-right')}
})()`)
async function run() {
  try {
    win = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && /\/index\.html(?:$|[?#])/.test(w.webContents.getURL())
        ),
      '列表未启动'
    )
    win.setSize(480, 760)
    win.show()
    win.focus()
    await until(
      () =>
        js(
          "Boolean(document.querySelector('.sg-root') && document.querySelector('.almanac-brief__line'))"
        ),
      '工具栏未就绪'
    )
    await wait(600)
    await js(`(() => {
      const dialog = document.querySelector('.shortcut-conflict-notice')?.closest('[role="dialog"]')
      if (dialog) [...dialog.querySelectorAll('button')].find(b => ['稍后处理', '完成'].includes(b.textContent.trim()))?.click()
    })()`)
    await until(
      () => js("!document.querySelector('.shortcut-conflict-notice')"),
      '测试快捷键提示未关闭'
    )
    await js("window.api.createNote({content:'工具栏局部检查'})")
    await wait(600)
    await move(null)
    await wait(450)
    const closed = await geometry()
    assert.ok(Math.abs(closed.group.x - closed.toolbar.x) < 1, '左侧不能有补偿空白')
    assert.ok(closed.group.width < closed.taiji.width + 10, '收起仅占太极宽度')
    writeFileSync(join(output, 'left-closed.png'), (await win.webContents.capturePage()).toPNG())
    const queries = noteQueries
    await move('.sg-btn--taiji')
    await wait(420)
    const open = await geometry()
    assert.ok(Math.abs(open.taiji.x - closed.taiji.x) < 1, '太极位置固定')
    assert.ok(
      closed.weather.width - open.weather.width > 30 &&
        closed.almanac.width - open.almanac.width > 30,
      '两块摘要必须同时被挤压'
    )
    assert.ok(Math.abs(open.weather.width - open.almanac.width) < 1, '摘要平分剩余空间')
    assert.ok(
      open.weather.x >= open.group.right && open.almanac.x >= open.weather.right,
      '文字不能交叠'
    )
    assert.ok(Math.abs(open.toolbar.height - closed.toolbar.height) < 1, '展开不能顶动列表')
    assert.equal(noteQueries, queries, '悬停不能触发刷新')
    assert.deepEqual(
      await js("[...document.querySelectorAll('.sg-btn--side')].map(b=>b.textContent.trim())"),
      ['标签', '状态', '时间线']
    )
    assert.equal(
      await js("document.querySelectorAll('.sg-root .app-icon').length"),
      1,
      '仅保留太极图标'
    )
    writeFileSync(join(output, 'left-open.png'), (await win.webContents.capturePage()).toPNG())

    await click('.sg-btn--tags')
    await until(() => js("Boolean(document.querySelector('.nl-tags'))"), '标签按钮失效')
    await move(null)
    await wait(400)
    assert.ok(
      await js("document.querySelector('.sg-root').classList.contains('is-expanded')"),
      '标签面板打开时移出不能收起'
    )
    await click('.sg-btn--status')
    await until(() => js("Boolean(document.querySelector('.nl-status-filter'))"), '状态按钮失效')
    await move('.nl-status-filter')
    await wait(450)
    assert.equal(
      await js("document.querySelector('.sg-root').classList.contains('is-expanded')"),
      true
    )
    assert.ok(
      await js("Boolean(document.querySelector('.nl-status-filter'))"),
      '状态面板与按钮组应保持展开'
    )
    await move('.sg-btn--taiji')
    await wait(420)
    await click('.sg-btn--taiji')
    await until(() => js("!document.querySelector('.nl-panel-wrap')"), '太极应收起筛选')
    await wait(400)

    await click('.sg-btn--mode')
    await until(
      () => js("Boolean(document.querySelector('.nl-panel-wrap .nl-mode-panel'))"),
      '模式应使用下方内联面板'
    )
    assert.ok(await js("!document.querySelector('.nl-mode-menu')"), '不能保留下拉菜单')
    await wait(350)
    writeFileSync(join(output, 'mode-panel.png'), (await win.webContents.capturePage()).toPNG())
    // 选择后保留面板，并同步更新工具栏模式名称。
    for (const [index, selector] of [
      [1, '.nl-custom'],
      [2, '.nl-tag-groups'],
      [0, '.nl-timeline']
    ]) {
      const option = '.nl-mode-option:nth-child(' + (index + 1) + ')'
      await move(option)
      await wait(180)
      assert.ok(
        await js("document.querySelector('.sg-root').classList.contains('is-expanded')"),
        '模式面板操作期间必须保持展开'
      )
      assert.ok(
        await js(
          `(() => {const el=document.querySelector(${JSON.stringify(option)}),r=el.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el})()`
        ),
        '模式选项点击区域被遮挡'
      )
      await click(option)
      await until(
        () => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
        '模式选择没有生效'
      )
      assert.ok(await js("!document.querySelector('.app-editor-dialog')"), '不能穿透打开便签')
      await move(null)
      await wait(500)
      assert.ok(
        await js(
          "document.querySelector('.sg-root').classList.contains('is-expanded') && Boolean(document.querySelector('.nl-mode-panel'))"
        ),
        '选择模式及鼠标离开后仍保持展开'
      )
      assert.equal(
        await js("document.querySelector('.sg-btn--mode').textContent.trim()"),
        ['时间线', '自定义', '标签分组'][index]
      )
    }
    await click('.sg-btn--mode')
    await move(null)
    await wait(100)
    assert.ok(
      await js("document.querySelector('.sg-root').classList.contains('is-expanded')"),
      '面板退出动画结束前不能先收回按钮'
    )
    await wait(750)
    const restored = await geometry()
    assert.ok(
      Math.abs(restored.weather.width - closed.weather.width) < 1 &&
        Math.abs(restored.almanac.width - closed.almanac.width) < 1,
      '收起应归还全部空间'
    )
    writeFileSync(
      join(output, 'left-evidence.json'),
      JSON.stringify({ closed, open, restored }, null, 2)
    )
    report('PASS 模式名称同步、内联模式面板、三个面板移出保持展开及关闭后收回')
    app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed())
      writeFileSync(join(output, 'left-failure.png'), (await win.webContents.capturePage()).toPNG())
    report(error?.stack || String(error))
    app.exit(1)
  }
}

try {
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seed()
  require(resolve('out/main/index.js'))
  const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk)
  require(resolve('out/main/chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  report(error?.stack || String(error))
  app.exit(1)
}
