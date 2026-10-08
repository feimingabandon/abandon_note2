import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { prepareUiFixture } = require('./helpers/ui-fixture.cjs')
const profile = mkdtempSync(join(tmpdir(), 'abandon-ui-feedback-'))
const evidence = resolve(process.env.UI_TEST_EVIDENCE_DIR || 'tmp/ui-feedback-evidence')
mkdirSync(evidence, { recursive: true })
app.setPath('userData', join(profile, 'profile'))
app.setPath('sessionData', join(profile, 'session'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  results = []
let win
const js = (code) => win.webContents.executeJavaScript(code)
async function click(selector) {
  const p = await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2; return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`
  )
  assert.ok(p.hit, 'blocked ' + selector + ' ' + JSON.stringify(p))
  for (const type of ['mouseDown', 'mouseUp'])
    win.webContents.sendInputEvent({
      type,
      button: 'left',
      clickCount: 1,
      x: Math.round(p.x),
      y: Math.round(p.y)
    })
  await wait(240)
}
async function mode(value) {
  await js(`window.feedback.mode.value=${JSON.stringify(value)};window.feedback.nextTick()`)
  await wait(260)
}
async function check(name, run) {
  await run()
  results.push(name)
  console.log('PASS ' + name)
}
async function capture(name) {
  writeFileSync(join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
const timeout = setTimeout(() => app.exit(2), 90000)
async function run() {
  try {
    await prepareUiFixture(profile, 'ui-feedback.vue')
    await app.whenReady()
    win = new BrowserWindow({
      width: 496,
      height: 740,
      useContentSize: true,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    })
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error(message)
    })
    await win.loadFile(join(profile, 'index.html'))
    win.focus()
    await wait(260)
    await check('duration labels and invariant row height at all UI scales', async () => {
      for (const scale of [0.9, 1, 1.1, 1.25, 1.5]) {
        await js(`document.documentElement.style.setProperty('--ui-scale','${scale}')`)
        await wait(100)
        const heights = []
        for (const value of ['single_day', 'fixed_days', 'until_completed', 'single_day']) {
          await click('.sel-trigger')
          const labels = await js(
            `Array.from(document.querySelectorAll('.sel-option-label')).map(e=>({text:e.textContent,w:e.clientWidth,sw:e.scrollWidth,h:e.clientHeight,sh:e.scrollHeight}))`
          )
          assert.ok(
            labels.every((l) => l.w >= l.sw - 1 && l.h >= l.sh - 1),
            JSON.stringify(labels)
          )
          await click('.sel-option[data-value="' + value + '"]')
          heights.push(
            await js(
              `document.querySelector('.note-duration-field').getBoundingClientRect().height`
            )
          )
        }
        assert.ok(
          Math.max(...heights) - Math.min(...heights) < 0.6,
          JSON.stringify({ scale, heights })
        )
      }
      await js(`document.documentElement.style.setProperty('--ui-scale','1')`)
    })
    await check('scale menu complete text at 68px trigger', async () => {
      await mode('scale')
      await click('.sel-trigger')
      const labels = await js(
        `Array.from(document.querySelectorAll('.sel-option-label')).map(e=>({text:e.textContent,w:e.clientWidth,sw:e.scrollWidth,h:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)}))`
      )
      assert.equal(labels.length, 5)
      assert.ok(
        labels.every((l) => l.w >= l.sw - 1 && l.h <= l.line + 1),
        JSON.stringify(labels)
      )
      await capture('scale-menu')
    })
    await check('font checkmark and single neutral input surface', async () => {
      await mode('font')
      await click('.fsi-input')
      const state = await js(
        `({check:getComputedStyle(document.querySelector('.fsi-option.is-active .fsi-option-check')).opacity,shadow:getComputedStyle(document.querySelector('.fsi-option.is-active')).boxShadow,outline:getComputedStyle(document.querySelector('.fsi-input')).outlineStyle,outer:getComputedStyle(document.querySelector('.fsi-trigger')).outlineStyle})`
      )
      assert.equal(state.check, '1')
      assert.equal(state.shadow, 'none')
      assert.equal(state.outline, 'none')
      assert.equal(state.outer, 'none')
      await capture('font-menu')
    })
    await check(
      'tag panel remains stable in modal after observers settle, filter and reopen',
      async () => {
        await mode('tags')
        await click('.ts-more')
        const samples = []
        for (let i = 0; i < 12; i++) {
          samples.push(await js(`document.querySelector('.ts-panel-list').clientHeight`))
          await wait(90)
        }
        assert.ok(Math.min(...samples) > 80, JSON.stringify(samples))
        assert.ok(Math.max(...samples) - Math.min(...samples) <= 1, JSON.stringify(samples))
        assert.equal(
          await js(`getComputedStyle(document.querySelector('.ts-search input')).outlineStyle`),
          'none'
        )
        await js(
          `var input=document.querySelector('.ts-search input');input.value='重要';input.dispatchEvent(new Event('input',{bubbles:true}))`
        )
        await wait(240)
        await js(
          `var input=document.querySelector('.ts-search input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))`
        )
        await wait(350)
        assert.ok(await js(`document.querySelector('.ts-panel-list').clientHeight>80`))
        await capture('tags-in-modal')
        await click('.ts-more')
        await click('.ts-more')
        assert.ok(await js(`document.querySelector('.ts-panel-list').clientHeight>80`))
      }
    )
    await check('saved province city and district restored on every open', async () => {
      await mode('area')
      await click('.china-area-cascader__trigger')
      assert.deepEqual(
        await js(
          `Array.from(document.querySelectorAll('.china-area-cascader__column [aria-selected="true"]')).map(e=>e.textContent.replace('✓','').trim())`
        ),
        ['广东省', '广州市', '越秀区']
      )
      await capture('region-selection')
      await click('.china-area-cascader__column button')
      await click('.china-area-cascader__trigger')
      await click('.china-area-cascader__trigger')
      assert.equal(
        await js(
          `document.querySelectorAll('.china-area-cascader__column [aria-selected="true"]').length`
        ),
        3
      )
    })
    await check('month and week picker buttons retain styles and centered anchors', async () => {
      for (const view of ['month', 'week']) {
        await mode(view)
        await click('.month-toolbar__title')
        const state = await js(
          `(()=>{const p=document.querySelector('.month-toolbar__picker'),r=p.getBoundingClientRect(),t=document.querySelector('.month-toolbar__title').getBoundingClientRect();return {left:r.left,right:r.right,center:r.left+r.width/2,anchor:t.left+t.width/2,width:innerWidth,bad:[...p.querySelectorAll('button')].filter(b=>getComputedStyle(b).borderStyle==='outset').length}})()`
        )
        assert.equal(state.bad, 0)
        assert.ok(state.left >= 7 && state.right <= state.width - 7, JSON.stringify(state))
        assert.ok(Math.abs(state.center - state.anchor) < 2, JSON.stringify(state))
        await capture(view + '-picker')
      }
    })
    await check('quick editor labels separated from rounded input and no focus halo', async () => {
      await mode('quick')
      const state = await js(
        `(()=>{const e=document.querySelector('.quick-note-editor'),t=e.querySelector('textarea'),l=e.querySelector('label');return {outline:getComputedStyle(t).outlineStyle,radius:parseFloat(getComputedStyle(t).borderRadius),gap:t.getBoundingClientRect().top-l.getBoundingClientRect().bottom}})()`
      )
      assert.equal(state.outline, 'none')
      assert.ok(state.radius > 0)
      assert.ok(state.gap >= 0)
      await capture('quick-editor')
    })
    await check('scrolled removal clones clipped to scrollport and removed on scroll', async () => {
      await mode('presence')
      await js(`document.querySelector('.presence-host>div').scrollTop=430`)
      await wait(100)
      await js(`window.feedback.filter()`)
      await wait(35)
      const layers = await js(
        `Array.from(document.querySelectorAll('[data-presence-layer]')).map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,overflow:getComputedStyle(e).overflow,font:getComputedStyle(e.firstChild).fontSize}})`
      )
      assert.ok(layers.length > 0 && layers.length <= 5, JSON.stringify(layers))
      assert.ok(
        layers.every(
          (l) =>
            l.top >= 160 &&
            l.bottom <= 460 &&
            l.left >= 30 &&
            l.right <= 430 &&
            l.overflow === 'hidden' &&
            l.font === '14px'
        ),
        JSON.stringify(layers)
      )
      await capture('clipped-presence')
      await js(`document.querySelector('.presence-host>div').scrollTop+=10`)
      await wait(40)
      assert.equal(await js(`document.querySelectorAll('[data-presence-layer]').length`), 0)
    })
    await check(
      'completed exits can be cancelled and auxiliary entrance survives card entrance',
      async () => {
        await js(`window.feedback.motion.animateCurrentCardsOut({includeAuxiliary:true})`)
        assert.equal(
          await js(`getComputedStyle(document.querySelector('.nl-footer-count')).opacity`),
          '0'
        )
        await js(`window.feedback.motion.cancelCurrentPresenceExits()`)
        assert.equal(
          await js(`getComputedStyle(document.querySelector('.nl-footer-count')).opacity`),
          '1'
        )
        assert.ok(
          await js(
            `Array.from(document.querySelectorAll('.test-card')).every(e=>getComputedStyle(e).opacity==='1')`
          )
        )
        const entrance = await js(
          `(()=>{const m=window.feedback.motion;m.animateAuxiliaryIn();m.animateRetainedCards(new Map());return {auxiliary:document.querySelector('.nl-footer-count').getAnimations().some(a=>a.playState==='running'),cards:Array.from(document.querySelectorAll('.test-card')).some(e=>e.getAnimations().some(a=>a.playState==='running'))}})()`
        )
        assert.deepEqual(entrance, { auxiliary: true, cards: true })
        await js(`window.feedback.motion.cancelCurrentPresenceExits()`)
      }
    )
    await check('initially visible modal plays actual entrance animation', async () => {
      await mode('none')
      await js(`window.feedback.modal.value=true;window.feedback.nextTick()`)
      await wait(40)
      const count = await js(
        `document.querySelector('.app-modal-overlay').getAnimations({subtree:true}).filter(a=>a.playState==='running').length`
      )
      assert.ok(count > 0, 'missing initial modal animation')
      await wait(260)
    })
    await js('window.feedback.modal.value=false;window.feedback.nextTick()')
    await wait(260)
    await check(
      'screenshot thumbnail deletion keeps its original grid position and size',
      async () => {
        for (const { kind, width, height, count, index } of [
          { kind: 'image-memory', width: 160, height: 90, count: 3, index: 1 },
          { kind: 'image-draft', width: 90, height: 160, count: 5, index: 1 },
          { kind: 'image-memory', width: 90, height: 160, count: 3, index: 2 },
          { kind: 'image-draft', width: 160, height: 90, count: 3, index: 2 }
        ]) {
          await mode(kind)
          await js(
            `(async()=>{window.feedback.picker.value.clearImages();const c=document.createElement('canvas');c.width=${width};c.height=${height};const x=c.getContext('2d');x.fillStyle='#3280bc';x.fillRect(0,0,c.width,c.height);for(let i=0;i<${count};i++)await window.feedback.picker.value.addCapture({dataUrl:c.toDataURL(),size:500})})()`
          )
          await wait(350)
          const frames = await js(`new Promise(resolve=>{
          const e=document.querySelectorAll('.ip-thumb')[${index}],root=e.closest('.ip-root'),samples=[];
          const rect=()=>{const r=e.getBoundingClientRect(),p=root.getBoundingClientRect();return {x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height,parent:p.toJSON()}};
          const before=rect();
          e.querySelector('.ip-thumb__del').click();
          function sample(){if(!e.isConnected)return resolve({before,samples,remaining:document.querySelectorAll('.ip-thumb').length});samples.push(rect());requestAnimationFrame(sample)}requestAnimationFrame(sample)
        })`)
          // A centered modal may reposition when its final row disappears. The
          // thumbnail must remain anchored to its picker, without growing/flying.
          assert.ok(frames.samples.length > 2)
          assert.equal(frames.remaining, count - 1)
          assert.ok(
            frames.samples.every(
              (r) =>
                r.width <= frames.before.width + 1 &&
                r.height <= frames.before.height + 1 &&
                Math.abs(r.x + r.width / 2 - frames.before.x - frames.before.width / 2) < 2 &&
                Math.abs(r.y + r.height / 2 - frames.before.y - frames.before.height / 2) < 2
            ),
            JSON.stringify(frames)
          )
          const label = `${kind}-${width}x${height}-${index}`
          writeFileSync(join(evidence, label + '.json'), JSON.stringify(frames, null, 2))
          await capture(label + '-after-delete')
        }
      }
    )
    writeFileSync(
      join(evidence, 'feedback.json'),
      JSON.stringify({ status: 'passed', results }, null, 2)
    )
    clearTimeout(timeout)
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (win) await capture('feedback-failure')
    writeFileSync(
      join(evidence, 'feedback.json'),
      JSON.stringify({ status: 'failed', results, error: String(error.stack) }, null, 2)
    )
    clearTimeout(timeout)
    win?.destroy()
    app.exit(1)
  }
}
run()
