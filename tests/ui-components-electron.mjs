import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { app, BrowserWindow } from 'electron'
const require = createRequire(import.meta.url)
const { prepareUiFixture } = require('./helpers/ui-fixture.cjs')
const profile = mkdtempSync(join(tmpdir(), 'abandon-ui-components-'))
const evidence = resolve(
  process.env.UI_TEST_EVIDENCE_DIR || 'docs/testing/evidence/2026-09-30-ui-consistency'
)
const dpi = process.env.UI_TEST_DPI || '1'
mkdirSync(evidence, { recursive: true })
app.setPath('userData', join(profile, 'profile'))
app.setPath('sessionData', join(profile, 'session'))
app.commandLine.appendSwitch('force-device-scale-factor', dpi)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let win
const watchdog = setTimeout(() => app.exit(2), 90000)
const js = (code) => win.webContents.executeJavaScript(code)
async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  process.stderr.write(`[ui] passed ${name}\n`)
}
async function key(keyCode, modifiers = []) {
  keyCode = keyCode.replace(/^Arrow/, '')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await pause(60)
}
async function click(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await pause(260)
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
  await pause(260)
}
async function bounds(selector) {
  return js(
    `(()=>{const p=document.querySelector(${JSON.stringify(selector)}),r=p.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`
  )
}
function inside(r) {
  assert.ok(
    r.left >= 7 && r.top >= 7 && r.right <= r.w - 7 && r.bottom <= r.h - 7,
    JSON.stringify(r)
  )
}
async function run() {
  try {
    await prepareUiFixture(profile)
    await app.whenReady()
    win = new BrowserWindow({
      width: 480,
      height: 640,
      useContentSize: true,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) process.stderr.write(message + '\n')
    })
    await win.loadFile(join(profile, 'index.html'))
    win.focus()
    await check('real keyboard focus and switch state', async () => {
      await js(`document.querySelector('#primary').focus()`)
      await key('Tab')
      const state = await js(
        `({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outlineStyle})`
      )
      assert.equal(state.id, 'danger')
      assert.equal(state.outline, 'solid')
      await key('Tab')
      await key('Space')
      assert.equal(
        await js(`document.querySelector('#toggle').getAttribute('aria-checked')`),
        'true'
      )
    })
    await check('Teleport font, normal Tab order, disabled closure', async () => {
      await click('.sel-trigger')
      const fonts = await js(
        `['.sel-trigger','.sel-option'].map(s=>getComputedStyle(document.querySelector(s)).fontSize)`
      )
      assert.equal(fonts[0], fonts[1])
      await key('Tab')
      await pause(180)
      assert.equal(await js(`document.activeElement.className`), 'fsi-input')
      await key('Escape')
      await pause(200)
      await click('.sel-trigger')
      await js(`window.uiFixture.disabled.value=true`)
      await pause(220)
      assert.equal(await js(`!!document.querySelector('.sel-panel-wrap')`), false)
      await js(`window.uiFixture.disabled.value=false`)
    })
    await check('font presets use click and keyboard outside clipped parent', async () => {
      await js(`document.querySelector('.fsi-input').focus()`)
      await pause(220)
      assert.equal(
        await js(`document.querySelector('.fsi-panel-wrap').parentElement===document.body`),
        true
      )
      await key('ArrowDown')
      await key('Home')
      await key('Return')
      await pause(220)
      assert.equal(await js(`window.uiFixture.size.value`), 14)
      assert.equal(await js(`!!document.querySelector('.fsi-panel-wrap')`), false)
      await click('.fsi-arrow-btn')
      await click('.fsi-option:last-child')
      assert.equal(await js(`window.uiFixture.size.value`), 20)
    })
    await check('font preset height recovers after viewport growth and reopening', async () => {
      const hostStyle = await js(`document.querySelector('#font-host').getAttribute('style')`)
      win.setContentSize(480, 240)
      await js(
        `document.querySelector('#font-host').style.cssText='position:fixed;top:20px;left:20px;height:40px;overflow:auto'`
      )
      await pointerClick('.fsi-arrow-btn')
      const short = await bounds('.fsi-panel-wrap')
      assert.equal(
        await js(
          `(()=>{const p=document.querySelector('.fsi-panel');return p.scrollHeight>p.clientHeight})()`
        ),
        true
      )
      win.setContentSize(480, 800)
      await pause(250)
      const grown = await bounds('.fsi-panel-wrap')
      assert.ok(grown.bottom - grown.top > short.bottom - short.top + 20)
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(
          await js(
            `(()=>{const p=document.querySelector('.fsi-panel');return p.scrollHeight<=p.clientHeight+1})()`
          ),
          true,
          'all presets fit again when space returns'
        )
        await key('Escape')
        await pause(180)
        if (attempt === 0) await pointerClick('.fsi-arrow-btn')
      }
      await js(
        `document.querySelector('#font-host').setAttribute('style',${JSON.stringify(hostStyle)})`
      )
      win.setContentSize(480, 640)
      await pause(100)
    })
    await check('yearly date panel scrolls to real confirm and cancel targets', async () => {
      for (const [height, top, scale] of [
        [640, 300, 1],
        [320, 20, 1.5]
      ]) {
        win.setContentSize(480, height)
        await js(
          `document.documentElement.style.setProperty('--ui-scale','${scale}');document.querySelector('#month-host').style.cssText='position:fixed;top:${top}px;left:20px'`
        )
        for (const action of ['.mdp-done', '.mdp-cancel']) {
          await pointerClick('.mdp-trigger')
          inside(await bounds('.mdp-panel'))
          assert.equal(
            await js(
              `(()=>{const p=document.querySelector('.mdp-panel');return p.scrollHeight>p.clientHeight&&getComputedStyle(p).overflowY==='auto'})()`
            ),
            true
          )
          await js(
            `(()=>{const p=document.querySelector('.mdp-panel');p.scrollTop=p.scrollHeight})()`
          )
          await pause(100)
          const button = await bounds(action)
          const panel = await bounds('.mdp-panel')
          assert.ok(
            button.top >= panel.top && button.bottom <= panel.bottom,
            JSON.stringify({ button, panel })
          )
          await pointerClick(action)
          assert.equal(await js(`!!document.querySelector('.mdp-panel')`), false)
          assert.equal(await js(`document.activeElement.matches('.mdp-trigger')`), true)
        }
      }
      await js(
        `document.querySelector('#month-host').removeAttribute('style');document.documentElement.style.setProperty('--ui-scale','1')`
      )
      win.setContentSize(480, 640)
      await pause(100)
    })
    await check('dialog focus, grid navigation, cascade keyboard and Escape', async () => {
      for (const [trigger, panel] of [
        ['.time-picker__trigger', '.time-picker__panel'],
        ['.mdp-trigger', '.mdp-panel']
      ]) {
        await js(`document.querySelector(${JSON.stringify(trigger)}).focus()`)
        await click(trigger)
        inside(await bounds(panel))
        assert.equal(
          await js(
            `document.querySelector(${JSON.stringify(panel)}).contains(document.activeElement)`
          ),
          true
        )
        await key('Escape')
        await pause(180)
        assert.equal(await js(`!!document.querySelector(${JSON.stringify(panel)})`), false)
        assert.equal(await js(`document.activeElement.matches(${JSON.stringify(trigger)})`), true)
      }
      await click('.china-area-cascader__trigger')
      await key('ArrowRight')
      await key('ArrowRight')
      await key('Return')
      await pause(180)
      assert.equal(await js(`!!document.querySelector('.china-area-cascader__panel')`), false)
    })
    await check('stable font across widths and independent scale', async () => {
      for (const width of [240, 360, 480, 720]) {
        win.setContentSize(width, 640)
        await pause(80)
        assert.equal(await js(`getComputedStyle(document.body).fontSize`), '17px')
      }
      await js(`document.documentElement.style.setProperty('--ui-scale','1.25')`)
      assert.equal(await js(`getComputedStyle(document.body).fontSize`), '21.25px')
    })
    await check('date and range share bounds, grid keys and IME-safe dismissal', async () => {
      win.setContentSize(480, 640)
      for (const [trigger, panel, grid] of [
        ['.date-picker__trigger', '.date-picker-panel', '.date-picker-panel__calendar'],
        ['.drp-trigger', '.drp-panel', '.drp-calendar']
      ]) {
        await js(`document.querySelector(${JSON.stringify(trigger)}).focus()`)
        await click(trigger)
        inside(await bounds(panel))
        await js(
          `document.querySelector(${JSON.stringify(grid)}).querySelector('button:not(:disabled)').focus()`
        )
        const before = await js('document.activeElement.getAttribute("aria-label")')
        await key('ArrowRight')
        assert.notEqual(await js('document.activeElement.getAttribute("aria-label")'), before)
        await js(
          `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))`
        )
        assert.equal(await js(`!!document.querySelector(${JSON.stringify(panel)})`), true)
        await key('Escape')
        await pause(180)
        assert.equal(await js(`document.activeElement.matches(${JSON.stringify(trigger)})`), true)
      }
    })
    await check('date/time edge bounds, scrollable confirmation and paired color', async () => {
      for (const [width, height, scale, font] of [
        [480, 640, 1, 17],
        [240, 320, 1.5, 28],
        [720, 480, 0.9, 14]
      ]) {
        win.setContentSize(width, height)
        await js(
          `document.documentElement.style.setProperty('--ui-scale','${scale}');document.documentElement.style.setProperty('--font-size-base','${font}rem')`
        )
        await pause(100)
        await click('.dt-trigger')
        inside(await bounds('.dt-panel-wrap'))
        await js(`document.querySelector('.dt-btn--confirm').scrollIntoView({block:'nearest'})`)
        const r = await bounds('.dt-btn--confirm')
        assert.ok(r.top >= 0 && r.bottom <= r.h, JSON.stringify(r))
        assert.deepEqual(
          await js(
            `(()=>{const s=getComputedStyle(document.querySelector('.dt-btn--confirm'));return [s.color,s.backgroundColor]})()`
          ),
          ['rgb(255, 255, 255)', 'rgb(0, 113, 227)']
        )
        await key('Escape')
        await pause(180)
      }
    })
    await check('unfinished animations reverse without a jump', async () => {
      for (const kind of ['dropdown', 'reveal'])
        for (const placement of ['top', 'bottom'])
          for (const fraction of [0.25, 0.5, 0.75])
            for (const reverse of [false, true]) {
              const frames = await js(
                `(()=>{const el=document.createElement('div');el.style.cssText='--popover-placement:${placement};width:120px;height:90px;position:fixed';document.body.append(el);const first=uiFixture[${JSON.stringify(reverse ? 'leavePopover' : 'enterPopover')}],second=uiFixture[${JSON.stringify(reverse ? 'enterPopover' : 'leavePopover')}];first(el,()=>{},'${kind}');let a=el.getAnimations()[0];a.pause();a.currentTime=${fraction}*${reverse ? 140 : 180};const before=[getComputedStyle(el).opacity,getComputedStyle(el).transform,getComputedStyle(el).clipPath];second(el,()=>{},'${kind}');a=el.getAnimations()[0];a.pause();a.currentTime=0;const after=[getComputedStyle(el).opacity,getComputedStyle(el).transform,getComputedStyle(el).clipPath];a.cancel();el.remove();return {before,after}})()`
              )
              assert.deepEqual(frames.before, frames.after)
            }
    })
    win.setContentSize(480, 640)
    await js(
      `document.documentElement.style.setProperty('--ui-scale','1');document.documentElement.style.setProperty('--font-size-base','17rem')`
    )
    for (const [name, bg, text] of [
      ['white', '255 255 255', '#1d1d1f'],
      ['black', '28 28 30', '#f5f5f7'],
      ['wallpaper', '255 255 255', '#1d1d1f']
    ]) {
      await js(
        `document.documentElement.style.setProperty('--bg-color',${JSON.stringify(bg)});document.documentElement.style.setProperty('--text-color',${JSON.stringify(text)});document.body.style.background=${JSON.stringify(name === 'wallpaper' ? 'repeating-linear-gradient(35deg,#637ca1 0 30px,#efd5b6 30px 55px)' : `rgb(${bg})`)}`
      )
      await click('.dt-trigger')
      await pause(80)
      assert.equal(
        await js(
          `(()=>{const c=document.createElement('canvas'),ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(document.querySelector('.dt-panel-glass')).backgroundColor;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]})()`
        ),
        255,
        'popover reading surface is opaque'
      )
      writeFileSync(
        join(evidence, `components-${name}-dpi-${dpi}.png`),
        (await win.webContents.capturePage()).toPNG()
      )
      await key('Escape')
      await pause(180)
    }
    writeFileSync(
      join(evidence, `components-dpi-${dpi}.json`),
      JSON.stringify({ status: 'passed', dpi, profile, results }, null, 2)
    )
    win.destroy()
    clearTimeout(watchdog)
    app.exit(0)
  } catch (error) {
    writeFileSync(
      join(evidence, `components-dpi-${dpi}.json`),
      JSON.stringify(
        { status: 'failed', dpi, profile, results, error: String(error.stack) },
        null,
        2
      )
    )
    console.error(error)
    win?.destroy()
    clearTimeout(watchdog)
    app.exit(1)
  }
}
run()
