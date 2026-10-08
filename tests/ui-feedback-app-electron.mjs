import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'abandon-ui-feedback-app-'))
const evidence = resolve(
  process.env.UI_TEST_EVIDENCE_DIR || 'docs/testing/evidence/2026-09-30-ui-consistency'
)
mkdirSync(evidence, { recursive: true })
app.setPath('userData', profile)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
{
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
      () => BrowserWindow.getAllWindows().find((w) => /\/index\.html/.test(w.webContents.getURL())),
      'main missing'
    )
    await until(() => js('!!document.querySelector(".app-titlebar")'), 'renderer missing')
    const notice = await js('window.api.getShortcutStartupNotice()')
    if (notice.length) {
      await until(
        () => js(`!!document.querySelector('[aria-label="快捷键启用提示"] .app-modal-close')`),
        'notice missing'
      )
      await click('[aria-label="快捷键启用提示"] .app-modal-close')
    }
    win.setContentSize(496, 860)
    await set('appearance.uiScale', 1)
    await js(
      '(async()=>{for(let i=0;i<16;i++)await window.api.createTag(i===0?"重要":"标签 "+i,"#32a852")})()'
    )
    await check('real new-note editor and tag panel in narrow layout', async () => {
      await pointerClick('.ab-box:not(.ab-box--search) .ab-box-btn')
      await pause(750)
      await js(
        'document.querySelector(".new-note-panel textarea, .nnp-form textarea, .colored-text-editor__textarea").focus()'
      )
      assert.equal(await js('getComputedStyle(document.activeElement).outlineStyle'), 'none')
      await capture('actual-new-note-input')
      await pointerClick('.note-duration-field .sel-trigger')
      assert.equal(
        await js(
          'Array.from(document.querySelectorAll(".sel-option-label")).every(e=>e.clientWidth>=e.scrollWidth-1)'
        ),
        true
      )
      await pointerClick('.sel-option[data-value="fixed_days"]')
      await js(
        'document.querySelector(".nnp-form .ts-more, .new-note-panel .ts-more, .ab-content-layer .ts-more").scrollIntoView({block:"center"})'
      )
      await pause(200)
      await pointerClick('.ab-content-layer .ts-more')
      await pause(1100)
      assert.ok(await js('document.querySelector(".ts-panel-list").clientHeight>60'))
      await capture('actual-new-note-tags')
      await pointerClick('.ab-content-layer .ts-more')
      await pointerClick('.ab-box:not(.ab-box--search) .ab-box-btn')
    })
    await check('real scrolled list filtering stays inside its scrollport', async () => {
      await js(
        `(async()=>{const tag=(await window.api.listTags()).find(t=>t.name==='重要');for(let i=0;i<36;i++)await window.api.createNoteWithAssets({options:{content:'滚动筛选便签 '+i},images:[],tagIds:i%2?[tag.id]:[]})})()`
      )
      await pause(650)
      const hover = await js(
        `(()=>{const r=document.querySelector('.sg-root').getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`
      )
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(hover.x),
        y: Math.round(hover.y)
      })
      await pause(400)
      await pointerClick('.sg-btn--tags')
      let exitsSeen = 0
      for (const scrollTop of [0, 480]) {
        for (const selecting of [true, false]) {
          await js(`document.querySelector('.nl-list-scroll').scrollTop=${scrollTop}`)
          await pause(220)
          const measurement = await js(`new Promise(resolve=>{
            let frames=0,violations=[],ghosts=[],motions=0,exits=0;const end=performance.now()+900;
            document.querySelector('.nl-tags .ts-chip[title="重要"]').click();
            function sample(){const scroll=document.querySelector('.nl-list-scroll'),box=scroll.getBoundingClientRect();
              motions+=scroll.getAnimations({subtree:true}).length;
              for(const layer of document.querySelectorAll('[data-presence-layer]')){
                const r=layer.getBoundingClientRect(),clone=layer.firstElementChild,c=clone.getBoundingClientRect();exits++;
                if(r.top<box.top-1||r.bottom>box.bottom+1||r.left<box.left-1||r.right>box.right+1)violations.push(r.toJSON());
                if(Number(getComputedStyle(clone).opacity)<.1)continue;
                for(const card of scroll.querySelectorAll('.nl-card')){if(Number(getComputedStyle(card).opacity)<.1)continue;const b=card.getBoundingClientRect();const overlap=Math.min(c.bottom,b.bottom,box.bottom)-Math.max(c.top,b.top,box.top);if(overlap>8)ghosts.push({exit:clone.dataset.noteId,live:card.dataset.noteId,overlap})}
              }
              frames++;if(performance.now()<end)requestAnimationFrame(sample);else resolve({frames,violations,ghosts,motions,exits,count:scroll.querySelectorAll('.nl-card').length})
            }requestAnimationFrame(sample)
          })`)
          writeFileSync(
            join(evidence, `filter-${scrollTop}-${selecting}.json`),
            JSON.stringify(measurement, null, 2)
          )
          assert.ok(measurement.frames > 5)
          assert.equal(measurement.count, selecting ? 18 : 36)
          assert.deepEqual(measurement.violations, [])
          assert.deepEqual(
            measurement.ghosts,
            [],
            `visible card text overlaps while filtering at ${scrollTop}`
          )
          exitsSeen += measurement.exits
        }
      }
      assert.ok(exitsSeen > 0, 'no removal animation was actually sampled')
      // Reverse the filter before the first exit finishes. No previous clones may survive.
      await js(`document.querySelector('.nl-tags .ts-chip[title="重要"]').click()`)
      await pause(60)
      await js(`document.querySelector('.nl-tags .ts-chip[title="重要"]').click()`)
      await pause(850)
      assert.equal(await js(`document.querySelectorAll('[data-presence-layer]').length`), 0)
      assert.equal(await js(`document.querySelectorAll('.nl-list-scroll .nl-card').length`), 36)
      await capture('actual-scrolled-filter')
      await pointerClick('.sg-btn--tags')
    })
    await check('first and repeated fullscreen workspaces animate with content', async () => {
      for (const name of ['template', 'help'])
        for (let pass = 0; pass < 2; pass++) {
          await js('document.querySelector(".titlebar-btn-' + name + '").click()')
          const panel = '.app-' + name + '-panel'
          await until(() => js('!!document.querySelector("' + panel + '")'), 'workspace missing')
          const seen = await until(
            () =>
              js(
                '(()=>{const p=document.querySelector("' +
                  panel +
                  '");return p?.getAnimations().some(a=>a.playState==="running")})()'
              ),
            'workspace entrance missing',
            1500
          )
          assert.ok(seen)
          await pause(500)
          await capture('actual-' + name + '-' + pass)
          if (name === 'template') {
            await js('document.querySelector(".tp-search input").focus()')
            assert.equal(await js('getComputedStyle(document.activeElement).outlineStyle'), 'none')
          }
          await pointerClick('.titlebar-btn-' + name)
          await until(
            () => js('!document.querySelector("' + panel + '")'),
            'workspace did not close'
          )
        }
    })
    await check(
      'settings scale menu remains legible against white dark and patterned surfaces',
      async () => {
        await pointerClick('.titlebar-btn-settings')
        await js(
          'document.querySelector(".ui-scale-controls .sel-trigger").scrollIntoView({block:"center"})'
        )
        await pause(250)
        for (const theme of ['white', 'dark', 'pattern']) {
          await js(
            'document.documentElement.style.setProperty("--bg-color",' +
              JSON.stringify(theme === 'dark' ? '18 18 20' : '255 255 255') +
              ');document.documentElement.style.setProperty("--text-color",' +
              JSON.stringify(theme === 'dark' ? '#eeeeee' : '#1d1d1f') +
              ');document.body.style.background=' +
              JSON.stringify(
                theme === 'pattern'
                  ? 'repeating-linear-gradient(40deg,#d39080 0 25px,#97bdcb 25px 50px)'
                  : ''
              ) +
              ';'
          )
          await pointerClick('.ui-scale-controls .sel-trigger')
          const labels = await js(
            'Array.from(document.querySelectorAll(".sel-option-label")).map(e=>({text:e.textContent,w:e.clientWidth,sw:e.scrollWidth,h:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)}))'
          )
          assert.ok(
            labels.every((l) => l.w >= l.sw - 1 && l.h <= l.line + 1),
            JSON.stringify(labels)
          )
          await capture('actual-scale-' + theme)
          await pointerClick('.sel-option[data-value="1"]')
        }
        await pointerClick('.panel-close-btn')
      }
    )
    await js('window.__clearEditingDrafts()')
    await check('view menu preserves full labels in a narrow large-scale window', async () => {
      win.setContentSize(320, 740)
      await set('appearance.uiScale', 1.5)
      await pointerClick('.view-switcher__trigger')
      const labels = await js(
        'Array.from(document.querySelectorAll(".view-switcher__option-label")).map(e=>({text:e.textContent,w:e.clientWidth,sw:e.scrollWidth,h:e.clientHeight,sh:e.scrollHeight}))'
      )
      assert.equal(labels.length, 3)
      assert.ok(
        labels.every((l) => l.w >= l.sw - 1 && l.h >= l.sh - 1),
        JSON.stringify(labels)
      )
      await capture('actual-view-menu')
      await pointerClick('.view-switcher__trigger')
      await set('appearance.uiScale', 1)
    })
    await check('real month/week picker position, styling and sidebar typography', async () => {
      for (const view of ['month', 'week']) {
        await js('window.api.switchMainView("' + view + '")')
        await until(() => js('!!document.querySelector(".month-workspace")'), 'calendar missing')
        win.setContentSize(1100, 760)
        await pause(600)
        await pointerClick('.month-toolbar__title')
        const state = await js(
          '(()=>{const p=document.querySelector(".month-toolbar__picker"),r=p.getBoundingClientRect(),t=document.querySelector(".month-toolbar__title").getBoundingClientRect();return {center:r.left+r.width/2,anchor:t.left+t.width/2,bad:[...p.querySelectorAll("button")].filter(b=>getComputedStyle(b).borderStyle==="outset").length}})()'
        )
        assert.equal(state.bad, 0)
        assert.ok(Math.abs(state.center - state.anchor) < 2, JSON.stringify(state))
        await capture('actual-' + view + '-picker')
        await js(
          'document.querySelector(".month-toolbar__picker").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'
        )
        await pause(220)
        await pointerClick('.month-toolbar__day-panel-toggle')
        await pause(380)
        const fonts = await js(
          '(()=>{const p=document.querySelector(".month-day-panel");return {body:parseFloat(getComputedStyle(p).getPropertyValue("--font-size-base")),local:parseFloat(getComputedStyle(p).fontSize)}})()'
        )
        assert.ok(fonts.local <= 17)
        await capture('actual-' + view + '-sidebar')
      }
    })
    writeFileSync(
      join(evidence, 'feedback-app.json'),
      JSON.stringify({ status: 'passed', results }, null, 2)
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (win && !win.isDestroyed()) await capture('feedback-app-failure')
    writeFileSync(
      join(evidence, 'feedback-app.json'),
      JSON.stringify({ status: 'failed', results, error: String(error.stack) }, null, 2)
    )
    app.exit(1)
  }
}
setTimeout(() => app.exit(2), 120000)
app.once('ready', () => void run())
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
