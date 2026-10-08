import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'

const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'abandon-list-animation-'))
const evidence = resolve(process.env.UI_TEST_EVIDENCE_DIR || 'tmp/list-animation-evidence')
mkdirSync(evidence, { recursive: true })
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
let queryDelay = 0
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  handle(channel, async (event, ...args) => {
    if (['notes:query-earlier', 'notes:query-tag-group'].includes(channel)) await wait(queryDelay)
    return listener(event, ...args)
  })
let win
const js = async (code) => {
  try {
    return await win.webContents.executeJavaScript(code)
  } catch (error) {
    throw new Error(`Renderer expression failed: ${code}\n${error.message}`)
  }
}
const results = []
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(20)
  }
  throw Error(label)
}
async function click(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function check(name, run) {
  await js('window.motionRecords=[]')
  await run()
  const animations = await js('window.motionRecords')
  results.push({ name, animations })
  console.log('PASS ' + name)
}
async function sampleDisclosure(selector, trigger, reverse = false) {
  return js(`new Promise(resolve=>{
    const root=document.querySelector(${JSON.stringify(selector)}),frames=[];
    const start=performance.now(); let reversed=false;
    ${trigger};
    function sample(){
      const t=performance.now()-start;
      frames.push({t,height:root.getBoundingClientRect().height,moving:root.hasAttribute('data-list-disclosure-moving')});
      if(${reverse} && t>65 && !reversed){reversed=true;${trigger};}
      // A programmatic scroll must not cancel the reveal or card entrances.
      if(frames.length===8) document.querySelector('.nl-list-scroll').dispatchEvent(new Event('scroll'));
      if(t<750)requestAnimationFrame(sample);else resolve(frames);
    }requestAnimationFrame(sample)
  })`)
}
function assertHeightMotion(frames, opening) {
  const moving = frames.filter((f) => f.moving)
  assert.ok(moving.length >= 3, '未实际采到高度过渡')
  assert.ok(new Set(moving.map((f) => Math.round(f.height))).size > 2, '高度没有连续变化')
  assert.equal(frames.at(-1).moving, false, '动画未完成')
  if (opening) assert.ok(frames.at(-1).height > 0)
  else assert.equal(frames.at(-1).height, 0)
}
async function run() {
  try {
    win = await until(
      () => BrowserWindow.getAllWindows().find((w) => /\/index\.html/.test(w.webContents.getURL())),
      'missing main'
    )
    win.setSize(640, 780)
    await until(() => js(`!!document.querySelector('.nl-timeline')`), 'missing list')
    const ids = await js(`(async()=>{
      const tag=await window.api.createTag('动画分组','#3984db');
      const now=new Date();
      for(let i=0;i<35;i++){
        const note=await window.api.createNote({content:'动画便签 '+i,effectiveAt:new Date(now.getFullYear(),now.getMonth(),now.getDate()-(i<3?0:4),0,0,i).getTime()});
        await window.api.setNoteTagIds(note.id,[tag.id]);
      }return {tag:tag.id}
    })()`)
    await until(
      () => js(`document.querySelectorAll('#nl-earlier-content .nl-card').length>=10`),
      'missing earlier'
    )
    await wait(800)
    await js(`(()=>{
      window.motionRecords=[];const original=Element.prototype.animate;
      Element.prototype.animate=function(frames,options){
        const animation=original.call(this,frames,options);
        const record={id:this.id,classes:this.className,note:this.dataset.noteId,scope:this.closest('[data-presence-scope]')?.dataset.presenceScope,frames,options,state:'running'};
        window.motionRecords.push(record);
        animation.finished.then(()=>record.state='finished',()=>record.state='cancelled');
        return animation;
      };
    })()`)
    const earlierClick = `document.querySelector('.nl-group-label-row--earlier').click()`
    await check(
      'earlier collapse and first reopen animate through intermediate heights',
      async () => {
        assertHeightMotion(await sampleDisclosure('#nl-earlier-content', earlierClick), false)
        assert.equal(
          await js(`document.querySelectorAll('#nl-earlier-content .nl-card').length`),
          0
        )
        const frames = await sampleDisclosure('#nl-earlier-content', earlierClick)
        assertHeightMotion(frames, true)
        writeFileSync(join(evidence, 'earlier-enter-frames.json'), JSON.stringify(frames, null, 2))
        assert.equal(
          await js(`window.motionRecords.filter(r=>r.note && r.frames[0].opacity===0).length`),
          0,
          '展开区域时不叠加逐卡入场'
        )
      }
    )
    await check('reversing earlier collapse resumes its displayed height', async () => {
      const frames = await sampleDisclosure('#nl-earlier-content', earlierClick, true)
      assertHeightMotion(frames, true)
      const motions = await js(`window.motionRecords.filter(r=>r.id==='nl-earlier-content')`)
      assert.equal(motions[0].state, 'cancelled')
      assert.equal(motions.at(-1).state, 'finished')
      assert.ok(parseFloat(motions.at(-1).frames[0].height) > 0, '反向展开不能重新从零开始')
    })
    await check('slow earlier query obeys close then reopen intent', async () => {
      await click('.nl-group-label-row--earlier')
      await wait(350)
      queryDelay = 300
      await click('.nl-group-label-row--earlier')
      await wait(40)
      await click('.nl-group-label-row--earlier')
      await wait(650)
      assert.equal(await js(`document.querySelectorAll('#nl-earlier-content .nl-card').length`), 0)
      const frames = await sampleDisclosure('#nl-earlier-content', earlierClick)
      assertHeightMotion(frames, true)
      queryDelay = 0
    })
    await check('ordinary scroll does not abort new visible card entry', async () => {
      await js(`document.querySelector('.nl-timeline').scrollTop=0`)
      await wait(60)
      await js(`window.api.createNote({content:'新增入场检查'})`)
      await until(
        () => js(`window.motionRecords.some(r=>r.note && r.frames[0].opacity===0)`),
        '未启动新增卡片入场'
      )
      await js(`document.querySelector('.nl-timeline').dispatchEvent(new Event('scroll'))`)
      await wait(450)
      const entries = await js(`window.motionRecords.filter(r=>r.note && r.frames[0].opacity===0)`)
      assert.ok(
        entries.some((r) => r.state === 'finished'),
        '滚动取消了新增入场'
      )
    })
    await js(
      `window.api.setSettingValue('listFilter',{listMode:'tag-group',tagIds:[],statusFilter:[]})`
    )
    await until(
      () => js(`!!document.querySelector('[aria-controls="nl-tag-group-${ids.tag}"]')`),
      'missing tag mode'
    )
    await wait(400)
    const tagClick = `document.querySelector('[aria-controls="nl-tag-group-${ids.tag}"]').click()`
    await check('tag disclosure allows reversal and pending query cancellation', async () => {
      queryDelay = 250
      await js(tagClick)
      await wait(40)
      await js(tagClick)
      await wait(500)
      assert.equal(
        await js(
          `document.querySelector('[aria-controls="nl-tag-group-${ids.tag}"]').getAttribute('aria-expanded')`
        ),
        'false'
      )
      assert.equal(
        await js(`document.querySelectorAll('#nl-tag-group-${ids.tag} .nl-card').length`),
        0
      )
      queryDelay = 0
      assertHeightMotion(await sampleDisclosure(`#nl-tag-group-${ids.tag}`, tagClick), true)
      assertHeightMotion(await sampleDisclosure(`#nl-tag-group-${ids.tag}`, tagClick, true), true)
    })
    await check('tag pagination keeps existing nodes and does not replay their entry', async () => {
      await js(
        `window.oldCards=[...document.querySelectorAll('#nl-tag-group-${ids.tag} .nl-card')];window.motionRecords=[]`
      )
      await click(`#nl-tag-group-${ids.tag} .nl-tag-group-more`)
      await until(
        () => js(`document.querySelectorAll('#nl-tag-group-${ids.tag} .nl-card').length===30`),
        'tag pagination missing'
      )
      assert.equal(await js(`window.oldCards.every(e=>e.isConnected)`), true)
      assert.equal(
        await js(
          `window.motionRecords.some(r=>r.note && r.frames[0].opacity===0 && window.oldCards.some(e=>e.dataset.noteId===r.note))`
        ),
        false
      )
    })
    const toolbarPoint = await js(
      `(()=>{const r=document.querySelector('.sg-btn--taiji').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...toolbarPoint })
    await until(
      () => js(`!document.querySelector('.sg-btn--mode').disabled`),
      'toolbar not expanded'
    )
    await click('.sg-btn--mode')
    await wait(350)
    await check('rapid mode selection settles on the last choice', async () => {
      await click('.nl-mode-option:nth-child(2)')
      await wait(35)
      await click('.nl-mode-option:nth-child(1)')
      await until(() => js(`!!document.querySelector('.nl-timeline')`), 'latest mode lost')
      await wait(650)
      assert.equal(
        await js(
          `document.querySelector('.nl-mode-option[aria-pressed="true"]').textContent.trim()`
        ),
        '时间线'
      )
    })
    await click('.sg-btn--tags')
    await wait(500)
    await check('manual refresh has an exit and completed entrance', async () => {
      await click('.note-list .nl-tags .ts-refresh')
      await wait(850)
      const records = await js(
        `window.motionRecords.filter(r=>r.note && !String(r.classes).includes('clone'))`
      )
      assert.ok(
        records.some((r) => r.frames.at(-1).opacity === 0 && r.state === 'finished'),
        JSON.stringify(records)
      )
      assert.ok(records.some((r) => r.frames[0].opacity === 0 && r.state === 'finished'))
      assert.equal(await js(`document.querySelectorAll('[data-presence-clone]').length`), 0)
    })
    writeFileSync(
      join(evidence, 'list-animation.json'),
      JSON.stringify({ status: 'passed', results }, null, 2)
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (win)
      writeFileSync(
        join(evidence, 'list-animation-failure.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    writeFileSync(
      join(evidence, 'list-animation.json'),
      JSON.stringify({ status: 'failed', error: String(error.stack), results }, null, 2)
    )
    app.exit(1)
  }
}

app.setPath('userData', profile)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(profile, 'app.db'))
db.exec(
  `CREATE TABLE app_settings(window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`
)
const insert = db.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES (?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ['main', 'system', 'blur_enabled', 'false']
])
  insert.run(...row)
db.close()
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
app.once('ready', () => void run())
