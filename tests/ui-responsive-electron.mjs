import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
const require = createRequire(import.meta.url)
const profile = process.env.UI_RESP_PROFILE || mkdtempSync(join(tmpdir(), 'abandon-ui-responsive-'))
const restart = process.env.UI_RESP_RESTART === '1'
const evidence = resolve(
  process.env.UI_TEST_EVIDENCE_DIR || 'docs/testing/evidence/2026-09-30-ui-consistency'
)
mkdirSync(evidence, { recursive: true })
app.setPath('userData', profile)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
if (!restart) {
  const db = new Database(join(profile, 'app.db'))
  db.exec(
    "CREATE TABLE app_settings(window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))"
  )
  const insert = db.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
  for (const [type, key, value] of [
    ['application', 'active_view', 'list'],
    ['remote', 'receive_notices', 'false'],
    ['remote', 'upload_device_info', 'false'],
    ['onboarding', 'first_use_notice_version', '1']
  ])
    insert.run('application', type, key, value)
  for (const view of ['main', 'month', 'week']) {
    insert.run(view, 'system', 'blur_enabled', 'false')
    for (const [key, value] of [
      ['width', '900'],
      ['height', '640'],
      ['pos_x', '100'],
      ['pos_y', '100']
    ])
      insert.run(view, 'geometry', key, value)
  }
  db.close()
}
const results = []
let win
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (code) => win.webContents.executeJavaScript(code)
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await pause(50)
  }
  throw Error(message)
}
async function click(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await pause(450)
}
async function pointerClick(selector) {
  const point = await js(
    `(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`
  )
  assert.equal(point.hit, true, `Pointer target blocked: ${selector} ${JSON.stringify(point)}`)
  for (const type of ['mouseDown', 'mouseUp'])
    win.webContents.sendInputEvent({
      type,
      button: 'left',
      clickCount: 1,
      x: Math.round(point.x),
      y: Math.round(point.y)
    })
  await pause(450)
}
async function set(id, value) {
  await js(`window.api.setSettingValue(${JSON.stringify(id)},${JSON.stringify(value)})`)
  await pause(140)
}
async function capture(name) {
  writeFileSync(join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  process.stderr.write('[responsive] passed ' + name + '\n')
}
async function run() {
  try {
    win = await until(
      () =>
        BrowserWindow.getAllWindows().find((w) =>
          /\/(index|month|week)\.html/.test(w.webContents.getURL())
        ),
      'main window missing'
    )
    await until(() => js(`!!document.querySelector('.app-titlebar')`), 'renderer missing')
    // Another running application may own the default shortcuts. Dismiss its real
    // startup notice before testing header hit targets; do not click through it.
    const shortcutNotice = await js('window.api.getShortcutStartupNotice()')
    if (shortcutNotice.length) {
      const notice = '[role="dialog"][aria-label="快捷键启用提示"]'
      await until(() => js(`!!document.querySelector('${notice}')`), 'shortcut notice missing')
      await pointerClick(`${notice} .app-modal-close`)
      await until(() => js(`!document.querySelector('${notice}')`), 'shortcut notice dismissed')
    }
    if (restart) {
      await check('real process restart restores shared scale', async () => {
        const state = await js('window.api.getSettingsSnapshot()')
        assert.equal(state.values.appearance.uiScale, 1.25)
        assert.equal(await js('getComputedStyle(document.documentElement).fontSize'), '1.25px')
      })
    } else {
      await check('wrapped titlebar retains real targets at combined maximum scales', async () => {
        await set('appearance.uiScale', 1.5)
        await set('appearance.titlebarIconScale', 150)
        for (const style of ['apple', 'microsoft']) {
          await set('appearance.titlebarStyle', style)
          for (const width of [240, 360, 480]) {
            win.setContentSize(width, 640)
            await pause(250)
            const outside = await js(
              `(()=>{const p=document.querySelector('.app-titlebar'),r=p.getBoundingClientRect();return [...p.querySelectorAll('button')].filter(b=>{const q=b.getBoundingClientRect();return q.width&&(q.left<0||q.right>innerWidth||q.bottom>r.bottom+1||!b.contains(document.elementFromPoint(q.left+q.width/2,q.top+q.height/2)))}).map(b=>b.getAttribute('aria-label')||b.title)})()`
            )
            assert.deepEqual(outside, [], `${style} titlebar at ${width}px`)
            if (style === 'apple' && width === 480) {
              const height = await js(
                `document.querySelector('.app-titlebar').getBoundingClientRect().height`
              )
              assert.ok(
                Math.abs(height - (18 * 1.5 + 29)) < 0.1,
                'single-row Apple height stays unchanged'
              )
            }
            if (width === 240) await capture(`titlebar-wrapped-${style}`)
            await pointerClick('.titlebar-btn-settings')
            await until(
              () => js(`!!document.querySelector('.settings-panel.active')`),
              'settings opens by pointer'
            )
            await pointerClick('.panel-close-btn')
            await until(
              () => js(`!document.querySelector('.settings-panel.active')`),
              'settings closes by pointer'
            )
          }
        }
        await set('appearance.titlebarStyle', 'apple')
        await set('appearance.titlebarIconScale', 100)
        await set('appearance.uiScale', 1)
      })
      await check('list fonts remain stable at 240, 480 and 720 CSS px', async () => {
        await set('css.fontSizeBase', 17)
        for (const width of [240, 480, 720]) {
          win.setContentSize(width, 640)
          await pause(200)
          assert.equal(await js('getComputedStyle(document.body).fontSize'), '17px')
          assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
        }
      })
      await check('narrow settings retains scale selector, reset and owned popovers', async () => {
        win.setContentSize(240, 520)
        await set('appearance.uiScale', 1.5)
        await set('css.fontSizeBase', 22)
        await click('.titlebar-btn-settings')
        const selector = '.sel-trigger[aria-label="界面缩放"]'
        await until(
          () => js(`!!document.querySelector(${JSON.stringify(selector)})`),
          'scale setting missing'
        )
        await js(
          `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`
        )
        await pause(250)
        await capture('settings-narrow-150')
        assert.ok(
          await js(
            `(()=>{const p=document.querySelector('.panel-body');return p.scrollWidth-p.clientWidth<=2})()`
          ),
          'settings body must not scroll horizontally'
        )
        await click(selector)
        await click('.sel-option[data-value="1.25"]')
        assert.equal(
          await js(`document.querySelector('.settings-panel').classList.contains('active')`),
          true
        )
        assert.equal(await js('getComputedStyle(document.documentElement).fontSize'), '1.25px')
        const overflow = await js(
          `(()=>{const p=document.querySelector('.settings-panel').getBoundingClientRect();return [...document.querySelectorAll('.setting-right')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>p.right+1}).map(e=>e.outerHTML.slice(0,150))})()`
        )
        assert.deepEqual(overflow, [])
        await js(`document.querySelector('.ui-scale-controls .base-btn').click()`)
        await pause(250)
        assert.equal(await js('getComputedStyle(document.documentElement).fontSize'), '1px')
        await js(
          `document.querySelector('.settings-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
        )
        await pause(500)
      })
      await check('new note action remains visible in a narrow window', async () => {
        await click('.ab-box:not(.ab-box--search) .ab-box-btn')
        await until(() => js(`!!document.querySelector('.nnp-submit')`), 'new note missing')
        await pause(800)
        const state = await js(
          `(()=>{const b=document.querySelector('.nnp-submit'),r=b.getBoundingClientRect();return {x:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,focus:getComputedStyle(b).color}})()`
        )
        assert.ok(
          state.x >= 0 && state.right <= state.width && state.bottom <= state.height,
          JSON.stringify(state)
        )
        assert.equal(
          await js(`getComputedStyle(document.querySelector('.nnp-submit')).filter`),
          'none'
        )
        await capture('list-new-narrow')
        await click('.ab-box:not(.ab-box--search) .ab-box-btn')
      })
      await check('240x240 at 150 percent keeps reset and close reachable', async () => {
        win.setContentSize(240, 240)
        await set('appearance.uiScale', 1.5)
        await click('.titlebar-btn-settings')
        const reset = '.ui-scale-controls .base-btn'
        await js(
          `document.querySelector(${JSON.stringify(reset)}).scrollIntoView({block:'center'})`
        )
        await pause(350)
        const point = await js(
          `(()=>{const b=document.querySelector(${JSON.stringify(reset)}),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y)),body:document.querySelector('.panel-body').clientHeight}})()`
        )
        assert.equal(point.hit, true, JSON.stringify(point))
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          button: 'left',
          clickCount: 1,
          x: Math.round(point.x),
          y: Math.round(point.y)
        })
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          x: Math.round(point.x),
          y: Math.round(point.y)
        })
        await until(
          () => js("getComputedStyle(document.documentElement).fontSize === '1px'"),
          'reset at smallest window'
        )
        await capture('settings-smallest-reset')
        await click('.panel-close-btn')
        win.setContentSize(240, 520)
        await pause(300)
      })
      await check('help and template workspace fit the narrow viewport', async () => {
        for (const [button, panel] of [
          ['.titlebar-btn-help', '.help-page'],
          ['.titlebar-btn-template', '.tp-page']
        ]) {
          await click(button)
          await until(
            () => js(`!!document.querySelector(${JSON.stringify(panel)})`),
            'workspace missing ' + panel
          )
          const overflow = await js(
            `(()=>{const r=document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1})()`
          )
          assert.equal(overflow, false)
          await capture(panel.slice(1) + '-narrow')
          await click(button)
        }
      })
      await check(
        'UI scale survives view changes; calendar columns and overlay sidebar stay readable',
        async () => {
          await set('appearance.uiScale', 1.25)
          for (const mode of ['month', 'week']) {
            await js(`window.api.switchMainView('${mode}')`)
            await until(
              () => js(`!!document.querySelector('.month-workspace')`),
              'calendar missing'
            )
            await set('css.fontSizeBase', 28)
            win.setContentSize(720, 520)
            await pause(350)
            assert.equal(await js('getComputedStyle(document.documentElement).fontSize'), '1.25px')
            await click('.month-toolbar__day-panel-toggle')
            await until(
              () => js(`!!document.querySelector('.month-workspace__side')`),
              'sidebar missing'
            )
            const state = await js(
              `(()=>{const p=document.querySelector('.month-workspace__side'),r=p.getBoundingClientRect(),c=document.querySelector('.month-workspace__calendar-body');return {position:getComputedStyle(p).position,right:r.right,w:innerWidth,scroll:c.scrollWidth>c.clientWidth}})()`
            )
            assert.equal(state.position, 'absolute')
            assert.ok(state.right <= state.w)
            assert.equal(state.scroll, true)
            await capture(mode + '-sidebar-125-font28')
            await click('.month-day-panel__collapse')
            await click('.month-toolbar__title')
            const picker = await js(
              `(()=>{const p=document.querySelector('.month-toolbar__picker'),r=p.getBoundingClientRect();return {parent:p.parentElement.tagName,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`
            )
            assert.equal(picker.parent, 'BODY')
            assert.ok(
              picker.left >= 7 &&
                picker.top >= 7 &&
                picker.right <= picker.width - 7 &&
                picker.bottom <= picker.height - 7,
              JSON.stringify(picker)
            )
            const point = await js(
              `(()=>{const x=innerWidth-9,y=innerHeight-9;return {x,y,backdrop:document.elementFromPoint(x,y)?.classList.contains('month-toolbar__picker-backdrop')}})()`
            )
            assert.equal(point.backdrop, true)
            win.webContents.sendInputEvent({
              type: 'mouseDown',
              button: 'left',
              clickCount: 1,
              x: point.x,
              y: point.y
            })
            win.webContents.sendInputEvent({
              type: 'mouseUp',
              button: 'left',
              clickCount: 1,
              x: point.x,
              y: point.y
            })
            await until(
              () => js("!document.querySelector('.month-toolbar__picker-backdrop')"),
              'calendar picker guard cleanup'
            )
          }
        }
      )
    }
    writeFileSync(
      join(evidence, restart ? 'responsive-restart.json' : 'responsive.json'),
      JSON.stringify({ status: 'passed', profile, results }, null, 2)
    )
    app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed()) await capture('responsive-failure').catch(() => {})
    writeFileSync(
      join(evidence, restart ? 'responsive-restart.json' : 'responsive.json'),
      JSON.stringify({ status: 'failed', profile, results, error: String(error.stack) }, null, 2)
    )
    console.error(error)
    app.exit(1)
  }
}
setTimeout(() => {
  console.error('UI_RESPONSIVE_TIMEOUT')
  app.exit(2)
}, 120000)
app.once('ready', () => void run())
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
