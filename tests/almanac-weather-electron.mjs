import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerWeatherIpcHandlers } from '../src/main/ipc/register-weather-ipc.js'
import { WeatherService } from '../src/main/services/weather-service.js'
import { verifyDatePickerKeyboard } from './helpers/date-picker-keyboard.mjs'

const require = createRequire(import.meta.url)
const userData =
  process.env.ABANDON_ALMANAC_TEST_PROFILE || mkdtempSync(join(tmpdir(), 'abandon-almanac-'))
const reopening = Boolean(process.env.ABANDON_ALMANAC_TEST_PROFILE)
const output = resolve('tmp/almanac-weather-e2e')
mkdirSync(output, { recursive: true })
const report = (message) => process.stderr.write(`[almanac-weather] ${message}\n`)
async function until(fn, message) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw Error(message)
}
if (!reopening) {
  const db = new Database(join(userData, 'app.db'))
  db.exec(
    "CREATE TABLE app_settings(window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))"
  )
  const insert = db.prepare("INSERT INTO app_settings VALUES(?,?,?,?,'',?,?)")
  for (const [scope, type, key, value] of [
    ['application', 'application', 'active_view', 'list'],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['application', 'calendar', 'almanac_enabled', '0'],
    ['main', 'system', 'blur_enabled', 'false'],
    ['main', 'notes', 'minimal_mode', '1']
  ])
    insert.run(scope, type, key, value, Date.now(), Date.now())
  db.close()
}
app.setPath('userData', userData)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
app.once('ready', () => void run())

async function run() {
  let exitCode = 0
  try {
    let win
    await until(() => {
      win = BrowserWindow.getAllWindows().find((w) =>
        /\/(index|month|week)\.html(?:$|[?#])/.test(w.webContents.getURL())
      )
      return win?.isVisible()
    }, '主窗口未显示')
    const js = async (code) => {
      try {
        return await win.webContents.executeJavaScript(code, true)
      } catch (error) {
        const trace = await win.webContents
          .executeJavaScript('JSON.stringify(window.__dateContextFocus)')
          .catch(() => '')
        throw new Error(`${error.message}\nscript=${code}\nfocus=${trace}`)
      }
    }
    await until(
      () => js('Boolean(document.querySelector(".almanac-brief__button"))'),
      '今日宜忌摘要未显示'
    )
    assert.equal(
      await js('Boolean(document.querySelector(".titlebar-btn-almanac"))'),
      false,
      '列表标题栏不应提供万年历按钮'
    )
    win.setSize(445, 760)
    await until(
      () => js('document.querySelectorAll(".nl-toolbar-right .almanac-brief__line").length===2'),
      '极简列表应默认展示今日宜忌'
    )
    assert.equal(await js('Boolean(document.querySelector(".nl-title"))'), false, '便签标题应移除')
    await js(
      'document.querySelector(".almanac-brief__button").focus(); window.dispatchEvent(new CustomEvent("abandon:open-almanac",{detail:{dateKey:document.querySelector(".almanac-brief").dataset.date}}))'
    )
    await until(
      () => js('Boolean(document.querySelector(".almanac-window__lunar"))'),
      '列表万年历未加载'
    )
    if (reopening) {
      assert.equal(
        await js(
          '(async()=> (await window.api.getSettingsSnapshot()).values.calendar.almanacEnabled)()'
        ),
        undefined
      )
      await until(
        () => js('document.querySelectorAll(".almanac-window__group").length===2'),
        '重启未恢复宜忌'
      )
      report('always-on almanac survives restart, including a legacy disabled setting')
      return
    }
    assert.equal(
      await js(
        '(async()=> (await window.api.getSettingsSnapshot()).values.calendar.almanacEnabled)()'
      ),
      undefined
    )
    assert.equal(
      await js('Boolean(document.querySelector(".almanac-settings, .almanac-window .switch"))'),
      false
    )
    await until(
      () => js('document.querySelectorAll(".almanac-window__group").length===2'),
      '默认未显示宜忌'
    )
    const spring = await js('(async()=> await window.api.getAlmanacDay("2024-02-10"))()')
    assert.equal(spring.metadata.lunar.day, 1)
    assert.equal(spring.metadata.lunar.month, 1)
    assert.equal(spring.almanac.status, 'ok')
    const coldFood = await js('(async()=> await window.api.getAlmanacDay("2026-04-04"))()')
    assert.ok(coldFood.metadata.festivals.some((festival) => festival.name === '寒食节'))
    assert.equal(
      (await js('(async()=> await window.api.getAlmanacDay("2100-03-01"))()')).almanac.status,
      'unsupported'
    )
    await js(
      'for(const dateKey of ["2024-02-10","2023-03-22","2026-09-28"]) window.dispatchEvent(new CustomEvent("abandon:open-almanac",{detail:{dateKey}}))'
    )
    await until(
      () =>
        js(
          'document.querySelector(".almanac-window")?.dataset.date==="2026-09-28" && document.querySelector(".almanac-window__lunar")?.textContent.includes("十八")'
        ),
      '快速切换日期串页'
    )
    for (const [theme, bg, fg] of [
      ['light', '255 255 255', '#111111'],
      ['dark', '0 0 0', '#ffffff'],
      ['wallpaper', '24 32 42', '#ffffff']
    ]) {
      await js(
        `(()=>{const source=document.querySelector('.almanac-window__source-toggle'); if(source.getAttribute('aria-expanded')==='false')source.click()})()`
      )
      await js(
        `(async()=>{ await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)}); await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)}); document.body.style.background=${JSON.stringify(theme === 'wallpaper' ? 'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)' : `rgb(${bg})`)} })()`
      )
      await new Promise((resolve) => setTimeout(resolve, 350))
      const bounds = await js(
        '(()=>{const c=document.querySelector(".almanac-window").closest(".app-modal-card");const r=c.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:c.scrollWidth>c.clientWidth+1,scroll:document.querySelector(".almanac-window__content").scrollHeight>document.querySelector(".almanac-window__content").clientHeight}})()'
      )
      assert.ok(
        bounds.left >= 0 &&
          bounds.right <= bounds.width &&
          bounds.top >= 0 &&
          bounds.bottom <= bounds.height &&
          !bounds.overflow,
        JSON.stringify(bounds)
      )
      assert.ok(bounds.scroll, '长宜忌应在内容区域滚动')
      writeFileSync(
        join(output, `list-${theme}.png`),
        (await win.webContents.capturePage()).toPNG()
      )
      await js(
        'document.querySelector(".almanac-window").closest(".app-modal-card").querySelector(".app-modal-close").click()'
      )
      await until(() => js('!document.querySelector(".almanac-window")'), '详情关闭失败')
      await until(
        () => js(`getComputedStyle(document.querySelector('.app-scene')).filter === 'none'`),
        '背景模糊未解除'
      )
      const toolbar = await js(
        `(()=>{const left=document.querySelector('.nl-toolbar-left').getBoundingClientRect();const center=document.querySelector('.nl-toolbar-center').getBoundingClientRect();const brief=document.querySelector('.almanac-brief').getBoundingClientRect();return {fits:left.right<=center.left+1,inside:brief.left>=0&&brief.right<=innerWidth}})()`
      )
      assert.ok(toolbar.fits && toolbar.inside, JSON.stringify(toolbar))
      writeFileSync(
        join(output, `list-brief-${theme}.png`),
        (await win.webContents.capturePage()).toPNG()
      )
      await js(
        'document.querySelector(".almanac-brief__button").focus(); window.dispatchEvent(new CustomEvent("abandon:open-almanac",{detail:{dateKey:document.querySelector(".almanac-brief").dataset.date}}))'
      )
      await until(
        () => js('document.querySelectorAll(".almanac-window__group").length===2'),
        '摘要未打开详情'
      )
    }
    await js(`window.api.setSettingValue('css.fontSizeBase',28)`)
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(
      await js(
        `(()=>{const card=document.querySelector('.almanac-window').closest('.app-modal-card');return card.scrollWidth>card.clientWidth+1})()`
      ),
      false,
      '大字号不得横向溢出'
    )
    writeFileSync(
      join(output, 'list-large-font.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await js(`window.api.setSettingValue('css.fontSizeBase',17)`)
    await verifyDatePickerKeyboard(win, '.almanac-window .date-picker__trigger', '.almanac-window')
    await js(`document.querySelector('.almanac-window .date-picker__trigger').click()`)
    await until(
      () => js(`document.activeElement?.matches('.date-picker-panel__day.is-selected')`),
      '日期选择器展开后未完成初始聚焦'
    )
    await js(
      `window.__almanacAnimations=[]; document.addEventListener('animationstart',e=>{if(e.target.matches('.almanac-window__day')) window.__almanacAnimations.push(e.animationName)}); document.querySelector('.date-picker-panel__day[aria-label="2026-09-27"]').focus()`
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await until(
      () =>
        js(
          `document.querySelector('.almanac-window')?.dataset.date==='2026-09-27' && !document.querySelector('.date-picker-panel')`
        ),
      '日期选择器未切换并关闭'
    )
    assert.ok(
      await js(`window.__almanacAnimations.some(name=>name.startsWith('almanac-day-reveal'))`),
      '切换日期必须播放内容入场动画'
    )
    await js(
      `(async()=>{getComputedStyle(document.querySelector('.almanac-window__source-reveal')).gridTemplateRows; document.querySelector('.almanac-window__source-toggle').click(); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`
    )
    assert.ok(
      await js(`document.querySelector('.almanac-window__source-reveal').getAnimations().length>0`),
      '来源展开应播放动画'
    )
    await js(
      'document.querySelector(".almanac-window").closest(".app-modal-card").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'
    )
    await until(() => js('!document.querySelector(".almanac-window")'), 'Escape未关闭')
    await until(
      () => js('document.activeElement?.classList.contains("almanac-brief__button")'),
      '关闭后焦点未恢复'
    )
    const switchApi = await js('typeof window.api.switchMainView')
    assert.equal(switchApi, 'function')
    await js('document.querySelector(".titlebar-btn-settings").click()')
    await until(() => js('Boolean(document.querySelector(".settings-panel.active"))'), '设置未打开')
    assert.equal(
      await js(
        'Boolean(document.querySelector(".almanac-settings")) || document.querySelector(".settings-panel").textContent.includes("显示传统黄历宜忌")'
      ),
      false,
      '设置中不应残留黄历开关'
    )
    await js('document.querySelector(".panel-close-btn").click()')
    await until(() => js('!document.querySelector(".settings-panel.active")'), '设置未关闭')
    await verifyListDateContext(win, js)
    for (const view of ['month', 'week']) {
      await js(`window.api.switchMainView(${JSON.stringify(view)})`)
      await until(
        () =>
          js(
            'Boolean(document.querySelector(".month-workspace") && document.querySelector(".almanac-brief__button"))'
          ),
        '日历视图未显示'
      )
      assert.equal(
        await js('Boolean(document.querySelector(".titlebar-btn-almanac"))'),
        false,
        `${view} 标题栏不应提供万年历按钮`
      )
      await until(
        () =>
          js(
            'document.querySelectorAll(".month-toolbar__trailing .almanac-brief__line").length===2'
          ),
        '月周工具栏缺少默认宜忌'
      )
      await js(
        'window.dispatchEvent(new CustomEvent("abandon:open-almanac",{detail:{dateKey:document.querySelector(".almanac-brief").dataset.date}}))'
      )
      await until(
        () => js('document.querySelectorAll(".almanac-window__group").length===2'),
        '月周摘要未打开详情'
      )
      await js(
        'window.dispatchEvent(new CustomEvent("abandon:open-almanac",{detail:{dateKey:"2023-03-22"}}))'
      )
      await until(
        () =>
          js('document.querySelector(".almanac-window__lunar")?.textContent.includes("闰二月")'),
        '月周万年历未显示闰月'
      )
      assert.equal(await js('document.querySelectorAll(".almanac-window__group").length'), 2)
      await js(
        'document.querySelector(".almanac-window").closest(".app-modal-card").querySelector(".app-modal-close").click()'
      )
      await until(() => js('!document.querySelector(".almanac-window")'), '关闭失败')
      await js(
        `(async()=>{await window.api.setSettingValue('css.bgColor','255 255 255');await window.api.setSettingValue('css.textColor','#111111');document.body.style.background='#fff'})()`
      )
      for (const width of [1100, 600]) {
        win.setSize(width, 760)
        await new Promise((resolve) => setTimeout(resolve, 250))
        const layout = await js(
          `(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const a=rect('.month-toolbar__leading'),b=rect('.month-toolbar__navigation'),c=rect('.month-toolbar__trailing'),r=rect('.almanac-brief');const overlap=(x,y)=>x.left<y.right-1&&x.right>y.left+1&&x.top<y.bottom-1&&x.bottom>y.top+1;return {fits:r.left>=0&&r.right<=innerWidth,overlap:overlap(a,b)||overlap(a,c),leading:a.toJSON(),navigation:b.toJSON(),trailing:c.toJSON()}})()`
        )
        writeFileSync(
          join(output, `${view}-brief-${width}.png`),
          (await win.webContents.capturePage()).toPNG()
        )
        assert.ok(layout.fits && !layout.overlap, JSON.stringify({ view, width, layout }))
        assert.ok(
          await js(
            `(()=>{const a=document.querySelector('.almanac-brief').getBoundingClientRect(),b=document.querySelector('.month-toolbar__trailing').getBoundingClientRect();return Math.abs((a.left-b.left)/parseFloat(getComputedStyle(document.documentElement).fontSize)-20)<2})()`
          ),
          '月周右侧摘要靠近导航的一侧应保留 20rem 空白'
        )
        await verifyCalendarSummaryHover(win, js, `${view}-${width}`)
      }
      await verifyDateContextPopover(win, js, '.month-day-cell__context.is-almanac', false, view)
      await verifyToolbarDateContext(win, js, false, view)
      await js(
        `document.querySelector('.month-day-cell[data-date]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:160,clientY:180}))`
      )
      await until(
        () => js(`Boolean(document.querySelector('.month-cell-context-menu'))`),
        '日期右键菜单未出现'
      )
      assert.deepEqual(
        await js(
          `[...document.querySelectorAll('.month-cell-context-menu button')].map(b=>b.textContent.trim())`
        ),
        ['新建便签…', '预览当日全部便签'],
        `${view} 日期右键应保留新建和预览，移除万年历`
      )
      await js(
        `document.querySelector('.month-cell-context-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
      )
      await until(
        () => js(`!document.querySelector('.month-cell-context-menu')`),
        '日期右键菜单未关闭'
      )
    }
    await runWeatherIntegration(win, js)
    writeFileSync(join(output, 'profile.txt'), userData)
    report(
      `list, month, week, rapid selection, narrow layout and theme checks passed; profile=${userData}`
    )
  } catch (error) {
    exitCode = 1
    report(error.stack || String(error))
    const currentWindow = BrowserWindow.getAllWindows().find((w) =>
      /\/(index|month|week)\.html(?:$|[?#])/.test(w.webContents.getURL())
    )
    if (currentWindow)
      report(
        await currentWindow.webContents
          .executeJavaScript(
            `JSON.stringify({focused:document.hasFocus(),events:window.__dateContextFocus,pointer:window.__lastSummaryPointer,hovered:[...document.querySelectorAll('.month-day-cell:hover,.month-day-cell.is-context-hovered')].map(el=>({date:el.dataset.date,classes:el.className})),summary:window.__eventHoverSummary?{date:window.__eventHoverSummary.dataset.date,opacity:getComputedStyle(window.__eventHoverSummary).opacity}:null})`
          )
          .catch(() => '')
      )
  } finally {
    app.exit(exitCode)
  }
}

async function clickDateContext(win, js, selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
  const cellPoint = await js(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el.matches('.month-day-cell__context.is-almanac'))return null;
    const r=el.closest('.month-day-cell').querySelector('.month-day-cell__number').getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
  })()`)
  if (cellPoint) {
    win.webContents.sendInputEvent({ type: 'mouseMove', ...cellPoint })
    await until(
      () =>
        js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity==='1'`),
      '日期格悬停后摘要未展开'
    )
  }
  // IPC 保存成功早于字号应用、便签插入与补位动画结束；真实坐标输入必须等待目标稳定。
  let previous = ''
  let stable = 0
  await until(async () => {
    const bounds = await js(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height,el.closest('.nl-card')?.dataset.noteId]})()`
    )
    const signature = JSON.stringify(bounds)
    stable = signature === previous ? stable + 1 : 0
    previous = signature
    return stable >= 4
  }, '日期摘要的位置尚未稳定')
  const rect = await js(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});window.__dateContextTrigger=el;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
  )
  const point = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  await until(
    () =>
      js(
        `(()=>{const s=getComputedStyle(window.__dateContextTrigger);return s.opacity==='1' && s.pointerEvents!=='none'})()`
      ),
    '日期摘要未在悬停后显示'
  )
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point })
}

async function verifyDateContextPopover(win, js, selector, hasWeather, screenshot, inline = true) {
  await until(() => win.isVisible() && !win.isMinimized(), '日期详情测试前窗口未显示')
  win.focus()
  await until(() => win.isFocused() && js('document.hasFocus()'), '日期详情测试前窗口未获得焦点')
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    '缺少日期摘要'
  )
  const date = await js(`document.querySelector(${JSON.stringify(selector)}).dataset.date`)
  if (!hasWeather && inline) {
    await until(
      () =>
        js(
          `/^宜 .+ 忌 .+/.test(document.querySelector(${JSON.stringify(selector)}).textContent.trim())`
        ),
      '卡片和日期格应先展示宜项，再自然接续忌项'
    )
  }
  await js(
    `(()=>{window.__dateContextMotion=[];window.__dateContextFocus=[];window.__dateContextTrace?.abort();window.__dateContextTrace=new AbortController();const signal=window.__dateContextTrace.signal;document.addEventListener('transitionrun',event=>{if(event.target.matches('.date-context-popover'))window.__dateContextMotion.push(event.propertyName)},{capture:true,signal});for(const type of ['focusin','focusout','blur','keydown','scroll'])window.addEventListener(type,event=>window.__dateContextFocus.push({type,key:event.key,target:event.target?.className||event.target?.tagName}),{capture:true,signal})})()`
  )
  await clickDateContext(win, js, selector)
  await until(
    () => js(`document.querySelectorAll('.date-context-popover__group').length===2`),
    '小浮层未加载完整宜忌'
  )
  await until(
    () => js(`document.activeElement?.getAttribute('aria-label')==='关闭天气与宜忌详情'`),
    '小浮层未接收焦点'
  )
  assert.equal(await js(`document.querySelector('.date-context-popover').dataset.date`), date)
  assert.equal(
    await js(
      `Boolean(document.querySelector('.almanac-window,.quick-note-editor,.app-modal-mask'))`
    ),
    false,
    '不得打开全局弹窗或快速编辑器'
  )
  const weather = await js(`document.querySelector('.date-context-popover__weather').textContent`)
  assert.ok(
    hasWeather
      ? weather.includes('雷阵雨') && weather.includes('获取于')
      : weather.includes('暂无可用天气预报'),
    weather
  )
  if (hasWeather) {
    const text = weather.replace(/\s+/g, ' ')
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    assert.match(text, /全天预报 .*雷阵雨/)
    assert.match(text, /CMA GRAPES/)
    assert.match(text, /降水概率由 Open-Meteo · 自动模型 补充/)
    if (date === today) {
      assert.match(text, /当前 🌙 晴/)
      assert.match(text, /天气时刻/)
      assert.match(text, /当前模型估算/)
      assert.match(text, /当前风速 12 km\/h/)
    } else {
      assert.ok(
        !text.includes('当前风速') && !text.includes('天气时刻'),
        '其他日期不应显示今天的当前天气'
      )
    }
  }
  await until(() => js(`window.__dateContextMotion.includes('opacity')`), '小浮层必须播放展开动画')
  await new Promise((resolve) => setTimeout(resolve, 280))
  const layout = await js(
    `(()=>{const el=document.querySelector('.date-context-popover'),r=el.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,overflow:el.scrollWidth>el.clientWidth+1}})()`
  )
  assert.ok(layout.fits && !layout.overflow, JSON.stringify(layout))
  writeFileSync(
    join(output, `context-${screenshot}.png`),
    (await win.webContents.capturePage()).toPNG()
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(() => js(`!document.querySelector('.date-context-popover')`), 'Escape 未关闭小浮层')
  assert.ok(
    await js(`document.activeElement===window.__dateContextTrigger`),
    JSON.stringify(
      await js(
        `({active:document.activeElement?.outerHTML.slice(0,400),trigger:window.__dateContextTrigger?.outerHTML.slice(0,400),connected:window.__dateContextTrigger?.isConnected,events:window.__dateContextFocus})`
      )
    )
  )
  await js(`window.__dateContextTrace.abort()`)
}

async function verifyToolbarDateContext(win, js, hasWeather, screenshot) {
  const layout = await js(`(()=>{
    const w=document.querySelector('.weather-brief').getBoundingClientRect(),a=document.querySelector('.almanac-brief').getBoundingClientRect();
    return {equalWidth:Math.abs(w.width-a.width)<1,equalHeight:Math.abs(w.height-a.height)<1,
      aligned:Math.abs(w.top-a.top)<1,ordered:w.right<a.left,inside:w.left>=0&&a.right<=innerWidth,
      weatherText:document.querySelector('.weather-brief').textContent};
  })()`)
  assert.ok(
    layout.equalWidth && layout.equalHeight && layout.aligned && layout.ordered && layout.inside,
    JSON.stringify(layout)
  )
  if (hasWeather) {
    assert.match(layout.weatherText, /体感 24°/)
    assert.match(layout.weatherText, /当前 🌙 晴/)
    assert.match(layout.weatherText, /全天 雷阵雨 18°～30°/)
    assert.match(layout.weatherText, /降水概率 80%/)
  }
  writeFileSync(
    join(output, `toolbar-pair-${screenshot}.png`),
    (await win.webContents.capturePage()).toPNG()
  )
  for (const kind of ['weather', 'almanac']) {
    await verifyDateContextPopover(
      win,
      js,
      `.${kind}-brief__button`,
      hasWeather,
      `toolbar-${kind}-${screenshot}`,
      false
    )
    if (hasWeather) {
      // Both entry points receive the same current reading and daily forecast.
      await clickDateContext(win, js, `.${kind}-brief__button`)
      await until(
        () =>
          js(
            `document.querySelector('.date-context-popover__weather')?.textContent.includes('当前风速 12 km/h')`
          ),
        '工具栏详情应显示当前体感和风速'
      )
      await js(`document.querySelector('.date-context-popover__header button').click()`)
      await until(() => js(`!document.querySelector('.date-context-popover')`), '工具栏详情未关闭')
    }
  }
}

async function verifyCalendarSummaryHover(win, js, screenshot) {
  await until(() => win.isVisible() && !win.isMinimized(), '日历悬停测试前窗口未显示')
  win.focus()
  await until(() => win.isFocused() && js('document.hasFocus()'), '日历悬停测试前窗口未获得焦点')
  await js(`document.fonts.ready.then(()=>undefined)`)
  await until(
    () =>
      js(
        `document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getComputedTiming().endTime===Infinity)`
      ),
    '日历布局动效尚未结束'
  )
  await js(
    `document.addEventListener('pointermove',event=>{window.__lastSummaryPointer={x:event.clientX,y:event.clientY,target:event.target.className}},{capture:true,once:false})`
  )
  await js(`document.activeElement?.blur()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 45 })
  await until(
    () =>
      js(
        `[...document.querySelectorAll('.month-day-cell__context.is-almanac')].every(el=>getComputedStyle(el).opacity==='0'&&el.getBoundingClientRect().width<0.5)`
      ),
    '未悬停日期格时宜忌摘要应隐藏且不占宽度'
  )
  const point = await js(`(()=>{
    const el=document.querySelector('.month-day-cell__header:has(.is-festival) .is-almanac')||document.querySelector('.month-day-cell__context.is-almanac');
    const header=el.closest('.month-day-cell__header');
    window.__hoverSummary=el;
    window.__hoverSummaryRect=el.getBoundingClientRect().toJSON();
    window.__hoverLunarRect=header.querySelector('.month-day-cell__lunar').getBoundingClientRect().toJSON();
    window.__hoverNumberRect=header.querySelector('.month-day-cell__number').getBoundingClientRect().toJSON();
    window.__hoverBadgesRect=header.querySelector('.month-day-cell__badges').getBoundingClientRect().toJSON();
    window.__hoverSummaryTransitions=0;
    window.__hoverLayoutTransitions=0;
    window.__hoverSummaryFrames=[];
    window.__hoverSummarySampleDone=false;
    const start=performance.now();
    const sample=()=>{window.__hoverSummaryFrames.push(el.getBoundingClientRect().width);if(performance.now()-start<350)requestAnimationFrame(sample);else window.__hoverSummarySampleDone=true};
    requestAnimationFrame(sample);
    el.addEventListener('transitionrun',event=>{if(event.target===el&&event.propertyName==='opacity')window.__hoverSummaryTransitions++});
    header.addEventListener('transitionrun',event=>{if(event.target===header&&event.propertyName==='grid-template-columns')window.__hoverLayoutTransitions++});
    const r=el.closest('.month-day-cell').getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await until(
    () =>
      js(`getComputedStyle(window.__hoverSummary).opacity==='1'&&window.__hoverSummarySampleDone`),
    '悬停日期格空白区未显示宜忌摘要'
  )
  const layout = await js(`(()=>{
    const el=window.__hoverSummary,r=el.getBoundingClientRect(),before=window.__hoverSummaryRect;
    const fade=el.querySelector('.overflow-fade'),s=getComputedStyle(fade);
    const header=el.closest('.month-day-cell__header');
    const lunar=header.querySelector('.month-day-cell__lunar').getBoundingClientRect();
    const badges=header.querySelector('.month-day-cell__badges').getBoundingClientRect();
    const number=header.querySelector('.month-day-cell__number').getBoundingClientRect();
    return {expanded:before.width<0.5&&r.width>before.width&&lunar.width<window.__hoverLunarRect.width,
      stable:Math.abs(number.x-window.__hoverNumberRect.x)<0.5&&Math.abs(badges.right-window.__hoverBadgesRect.right)<0.5&&Math.abs(r.height-before.height)<0.5,
      fade:s.maskImage.includes('linear-gradient'),
      rightAligned:Math.abs(fade.getBoundingClientRect().right-r.right)<1,
      startsWithYi:el.querySelector('.date-context-badge__label').getBoundingClientRect().left>=fade.getBoundingClientRect().left-1,
      fits:fade.clientWidth>=parseFloat(getComputedStyle(el).fontSize)-1&&r.left>=lunar.right-1&&r.right<=badges.left+1,
      animated:window.__hoverSummaryTransitions>0&&window.__hoverLayoutTransitions>0&&window.__hoverSummaryFrames.some(width=>width>0.5&&width<r.width-0.5)};
  })()`)
  assert.ok(Object.values(layout).every(Boolean), JSON.stringify(layout))
  writeFileSync(
    join(output, `summary-hover-${screenshot}.png`),
    (await win.webContents.capturePage()).toPNG()
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 45 })
  await until(
    () =>
      js(
        `getComputedStyle(window.__hoverSummary).opacity==='0'&&window.__hoverSummary.getBoundingClientRect().width<0.5`
      ),
    '移出日期格未淡出并释放空间'
  )
  assert.ok(
    await js(
      `window.__hoverSummaryTransitions>=2&&window.__hoverLayoutTransitions>=2&&Math.abs(window.__hoverSummary.closest('.month-day-cell__header').querySelector('.month-day-cell__lunar').getBoundingClientRect().width-window.__hoverLunarRect.width)<0.5`
    ),
    '显隐两个方向都必须播放动画，收回后恢复农历文字空间'
  )
  await js(`window.__hoverSummary.focus()`)
  await until(
    () => js(`getComputedStyle(window.__hoverSummary).opacity==='1'`),
    '键盘聚焦应显示入口'
  )
  await js(`window.__hoverSummary.blur()`)
  await until(() => js(`getComputedStyle(window.__hoverSummary).opacity==='0'`), '失焦后应淡出')
  const eventPoint = await js(`(()=>{
    const bar=document.querySelector('.month-event-bar');if(!bar)return null;
    const r=bar.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    const cell=[...document.querySelectorAll('.month-day-cell')].find(el=>{const c=el.getBoundingClientRect();return x>=c.left&&x<c.right&&y>=c.top&&y<c.bottom});
    window.__eventHoverSummary=cell?.querySelector('.month-day-cell__context.is-almanac');
    return window.__eventHoverSummary?{x:Math.round(x),y:Math.round(y)}:null;
  })()`)
  if (eventPoint) {
    win.webContents.sendInputEvent({ type: 'mouseMove', ...eventPoint })
    await until(
      () => js(`getComputedStyle(window.__eventHoverSummary).opacity==='1'`),
      '便签横条不应阻断所属日期格的悬停展示'
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 45 })
    await until(
      () => js(`getComputedStyle(window.__eventHoverSummary).opacity==='0'`),
      '离开便签横条后应淡出'
    )
  }
}

async function verifyListDateContext(win, js) {
  await js(
    `(async()=>{await window.api.setSettingValue('listAppearance.minimalMode',false);await window.api.createNote({content:'日期详情与渐隐检查'})})()`
  )
  await until(
    () =>
      js(
        `document.querySelector('.nl-card-date-context.is-almanac')?.textContent.trim().startsWith('宜 ')`
      ),
    '无天气的便签必须显示以宜开头的摘要'
  )
  const widths = []
  for (const width of [445, 1000]) {
    win.setSize(width, 760)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const layout = await js(
      `(()=>{const a=document.querySelector('.almanac-brief').getBoundingClientRect(),b=document.querySelector('.nl-toolbar-center').getBoundingClientRect();return {width:a.width,gap:(a.left-b.right)/parseFloat(getComputedStyle(document.documentElement).fontSize),hasDots:document.querySelector('.almanac-brief__rows').textContent.includes('…'),masked:!!document.querySelector('.almanac-brief .overflow-fade.is-overflowing'),mask:getComputedStyle(document.querySelector('.almanac-brief .overflow-fade')).maskImage}})()`
    )
    assert.ok(
      layout.gap >= 10 &&
        layout.gap <= 14 &&
        !layout.hasDots &&
        layout.masked &&
        layout.mask.includes('linear-gradient'),
      JSON.stringify(layout)
    )
    widths.push(layout.width)
    const summary = await js(`(()=>{
      const el=document.querySelector('.nl-card-date-context.is-almanac'),fade=el.querySelector('.overflow-fade'),s=getComputedStyle(el);
      return {visible:s.opacity==='1',masked:getComputedStyle(fade).maskImage.includes('linear-gradient'),width:el.getBoundingClientRect().width};
    })()`)
    assert.ok(summary.visible && summary.masked && summary.width > 0, JSON.stringify(summary))
  }
  assert.ok(widths[1] > widths[0] * 1.5, `列表摘要宽度应随可用空间增长: ${JSON.stringify(widths)}`)
  win.setSize(445, 760)
  for (const [name, bg, fg] of [
    ['light', '255 255 255', '#111111'],
    ['dark', '0 0 0', '#ffffff'],
    ['wallpaper', '24 32 42', '#ffffff']
  ]) {
    await js(
      `(async()=>{await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)});await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)});document.body.style.background=${JSON.stringify(name === 'wallpaper' ? 'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)' : `rgb(${bg})`)}})()`
    )
    await verifyDateContextPopover(
      win,
      js,
      '.nl-card-date-context.is-almanac',
      false,
      `list-${name}`
    )
    await verifyToolbarDateContext(win, js, false, `list-${name}`)
  }
  await js(`window.api.setSettingValue('css.fontSizeBase',28)`)
  await verifyDateContextPopover(
    win,
    js,
    '.nl-card-date-context.is-almanac',
    false,
    'list-large-font'
  )
  await js(`window.api.setSettingValue('css.fontSizeBase',17)`)
  await clickDateContext(win, js, '.nl-card-date-context')
  await until(
    () => js(`Boolean(document.querySelector('.date-context-popover'))`),
    '外部关闭测试未打开'
  )
  await js(
    `document.querySelector('.nl-toolbar').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`
  )
  await until(() => js(`!document.querySelector('.date-context-popover')`), '点击外部未关闭小浮层')
  await js(`window.api.setSettingValue('listAppearance.minimalMode',true)`)
  await until(
    () => js(`!document.querySelector('.nl-card-date-context')`),
    '极简模式不应显示卡片日期小组件'
  )
}

async function runWeatherIntegration(win, js) {
  await until(() => win.isVisible() && !win.isMinimized(), '天气测试前主窗口未完成视图切换')
  let now = Date.now()
  let fail = false
  let temperature = 25
  let requests = 0
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const location = {
    name: '北京',
    latitude: 39.9,
    longitude: 116.4,
    timezone: 'Asia/Shanghai',
    countryCode: 'CN'
  }
  const settings = { enabled: true, location }
  const service = new WeatherService({
    cachePath: join(userData, 'weather-fixture.json'),
    fetchImpl: async (url) => {
      requests += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (fail) throw Error('测试断网')
      const currentTime = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16)
      return {
        ok: true,
        json: async () => ({
          timezone: 'Asia/Shanghai',
          utc_offset_seconds: 28800,
          current: {
            time: currentTime,
            weather_code: 0,
            is_day: 0,
            temperature_2m: temperature,
            apparent_temperature: 24,
            wind_speed_10m: 12
          },
          daily: {
            time: [today, tomorrow],
            weather_code: [95, 95],
            temperature_2m_min: [18, 18],
            temperature_2m_max: [30, 30],
            precipitation_sum: [1.7, 1.7],
            precipitation_probability_max: new URL(url).searchParams.has('models')
              ? [null, null]
              : [80, 80]
          }
        })
      }
    }
  })
  for (const channel of [
    'weather:resolve-location',
    'weather:get-division-tree',
    'weather:get-forecast',
    'weather:refresh-forecast',
    'weather:open-source'
  ])
    ipcMain.removeHandler(channel)
  const runtime = registerWeatherIpcHandlers({
    ipcMain,
    shell: {},
    userDataPath: userData,
    appVersion: 'test',
    getMainWindow: () => win,
    getWeatherSettings: () => settings,
    canAutoRefresh: () => win.isVisible() && !win.isMinimized(),
    weatherService: service,
    now: () => now,
    random: () => 0
  })
  await js(
    `(async()=>{await window.api.setSettingValue('weather.location',${JSON.stringify(location)});await window.api.setSettingValue('weather.enabled',true)})()`
  )
  await until(
    () => js(`document.querySelector('.weather-brief__button')?.textContent.includes('25°')`),
    '天气初次加载未显示当前温度'
  )
  assert.equal(requests, 2, '中国双模型初次请求应各一次')
  assert.match(
    await js(`document.querySelector('.month-day-cell__weather')?.title || ''`),
    /雷阵雨/,
    '每日预报不应被当前晴天覆盖'
  )
  await verifyDateContextPopover(win, js, '.month-day-cell__weather', true, 'week-weather')
  await verifyToolbarDateContext(win, js, true, 'week-weather')
  now += 29 * 60000
  await runtime.refreshIfDue()
  assert.equal(requests, 2)
  win.hide()
  now += 2 * 60000
  await runtime.refreshIfDue()
  assert.equal(requests, 2, '隐藏窗口不得自动请求')
  temperature = 26
  win.show()
  await Promise.all([
    runtime.refreshIfDue(),
    runtime.refreshIfDue(),
    js('window.api.refreshWeatherForecast()')
  ])
  assert.equal(requests, 4, '恢复与手动请求必须合并为一个双模型批次')
  await until(
    () => js(`document.querySelector('.weather-brief__button')?.textContent.includes('26°')`),
    '天气自动更新未进入界面'
  )
  for (const view of ['list', 'month']) {
    await js(`window.api.switchMainView('${view}')`)
    await until(
      () =>
        js(
          view === 'list'
            ? `Boolean(document.querySelector('.note-list'))`
            : `Boolean(document.querySelector('.month-workspace'))`
        ),
      '天气切换视图未就绪'
    )
    // A cached renderer can appear before the native view switch has shown its window.
    await until(() => win.isVisible() && !win.isMinimized(), '天气视图切换后主窗口未显示')
    if (view === 'list') {
      await js(
        `(async()=>{await window.api.setSettingValue('listAppearance.minimalMode',false);await window.api.createNote({content:'天气刷新专项便签'})})()`
      )
      await until(
        () => js(`document.querySelector('.nl-card-weather')?.textContent.includes('雷阵雨')`),
        '列表未显示当日预报'
      )
      assert.match(await js(`document.querySelector('.nl-card-weather').title`), /获取于/)
      await verifyDateContextPopover(win, js, '.nl-card-weather', true, 'list-weather')
      await verifyToolbarDateContext(win, js, true, 'list-weather')
      await js(`window.api.setSettingValue('listAppearance.minimalMode',true)`)
      await until(
        () =>
          js(
            `!document.querySelector('.nl-card-weather') && Boolean(document.querySelector('.almanac-brief__button')) && !document.querySelector('.titlebar-btn-almanac')`
          ),
        '极简模式应保留宜忌摘要，隐藏卡片天气，不提供标题栏万年历按钮'
      )
    } else {
      await until(
        () => js(`document.querySelector('.weather-brief__button')?.textContent.includes('26°')`),
        '月视图未共用天气缓存'
      )
      await verifyToolbarDateContext(win, js, true, 'month-weather')
      await verifyDateContextPopover(
        win,
        js,
        `.month-day-cell__weather[data-date="${today}"]`,
        true,
        'month-weather'
      )
      await verifyDateContextPopover(
        win,
        js,
        `.month-day-cell__weather[data-date="${tomorrow}"]`,
        true,
        'month-tomorrow-weather'
      )
    }
  }
  win.setSize(1100, 760)
  await js(`document.body.style.background='#fff'`)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const weatherLayout = await js(
    `(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const w=rect('.weather-brief__button'),a=rect('.almanac-brief'),n=rect('.month-toolbar__navigation');return {weatherBeforeBrief:w.right<=a.left+1,briefAfterNavigation:a.left>=n.right-1||a.bottom<=n.top+1}})()`
  )
  assert.ok(
    weatherLayout.weatherBeforeBrief && weatherLayout.briefAfterNavigation,
    JSON.stringify(weatherLayout)
  )
  writeFileSync(
    join(output, 'month-brief-weather.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  fail = true
  now += 31 * 60000
  const failedForecast = await runtime.refreshIfDue()
  assert.ok(failedForecast?.cache?.stale, '可见主窗口到期刷新必须尝试请求，并在失败后返回旧数据')
  await until(
    () => js(`document.querySelector('.weather-brief__button')?.title.includes('更新失败')`),
    '失败后缺少旧数据提示'
  )
  const failedCount = requests
  await runtime.refreshIfDue()
  assert.equal(requests, failedCount, '失败退避期间不得反复请求')
  fail = false
  temperature = 27
  now += 5 * 60000
  await js(`window.dispatchEvent(new Event('online'))`)
  await until(
    () => js(`document.querySelector('.weather-brief__button')?.textContent.includes('27°')`),
    '联网恢复检查未更新天气'
  )
  assert.equal(requests, failedCount + 2)
  const cached = Object.values(service.cache.forecasts)[0]
  cached.fetchedAt = Date.now() - 25 * 3600000
  win.webContents.send('weather:forecast-updated', cached)
  await until(
    () =>
      js(
        `document.querySelector('.weather-brief__button')?.textContent.includes('天气暂无数据') && !document.querySelector('.month-day-cell__weather')`
      ),
    '过期24小时的数据未隐藏'
  )
  await until(
    () => js(`Boolean(document.querySelector('.month-day-cell__context.is-almanac'))`),
    '天气过期后必须回退宜忌'
  )
  await js(`window.api.switchMainView('list')`)
  await until(
    () =>
      js(
        `Boolean(document.querySelector('.almanac-brief__button')) && !document.querySelector('.month-workspace')`
      ),
    '列表恢复失败'
  )
  await until(() => win.isVisible() && !win.isMinimized(), '退出测试前列表窗口未显示')
  const verificationDb = new Database(join(userData, 'app.db'), { readonly: true })
  try {
    // The switch IPC only acknowledges dispatch; do not exit before presentation and persistence finish.
    await until(
      () =>
        verificationDb
          .prepare(
            "SELECT value FROM app_settings WHERE window_name='application' AND key='active_view'"
          )
          .get()?.value === 'list',
      '退出测试前列表视图尚未保存'
    )
  } finally {
    verificationDb.close()
  }
  report(
    'weather IPC, dual-model deduplication, 30-minute cadence, hidden/restore, all views, retry, online recovery and expiry passed (injected clock/provider)'
  )
}
