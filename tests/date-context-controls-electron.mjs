import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { addCalendarDays, localDateKey } from '../src/shared/calendar/calendar-date-rules.js'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/date-context-controls-electron.mjs',
  mode: 'electron-real-app-date-context-controls-and-settings-reset',
  prefix: 'abandon-date-context-',
  metadata: {
    realWindows: true,
    diskDatabase: true,
    runtimeAppBootstrap: true,
    nativePointerInput: false,
    mainProcessRestart: false,
    views: ['list', 'month', 'week']
  },
  timeoutMs: 180000
})
const { assert, root: profile } = lifecycle
const require = createRequire(import.meta.url)
const output = process.env.ABANDON_TEST_EVIDENCE_DIR || profile
mkdirSync(output, { recursive: true })
const scenarios = []
const captures = []
let current
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function seedSettings() {
  const db = new Database(join(profile, 'app.db'))
  db.exec(
    "CREATE TABLE app_settings(window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))"
  )
  const insert = db.prepare("INSERT INTO app_settings VALUES(?,?,?,?,'',?,?)")
  for (const [scope, type, key, value] of [
    ['application', 'application', 'active_view', 'list'],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ...['main', 'month', 'week'].map((view) => [view, 'system', 'blur_enabled', 'false'])
  ])
    insert.run(scope, type, key, value, Date.now(), Date.now())
  db.close()
}

async function until(fn, message) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await fn()) {
      assert.ok(true, message)
      return
    }
    await wait(30)
  }
  assert.fail(message)
}

// A DOM click is only accepted when the real control is visible, enabled and
// receives hit testing. This catches modal/inert blockers instead of clicking
// the hidden settings form behind the first-use notice after a reset.
async function clickVisible(js, selector) {
  await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`)
  await until(
    () =>
      js(`(()=>{
      const target=document.querySelector(${JSON.stringify(selector)});
      if(!target || target.disabled || target.matches(':disabled') || target.closest('[inert]'))return false;
      const rect=target.getBoundingClientRect(),style=getComputedStyle(target);
      const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      return rect.width>0 && rect.height>0 && style.visibility==='visible' && Number(style.opacity)>0.01 &&
        x>=0 && x<innerWidth && y>=0 && y<innerHeight && target.contains(document.elementFromPoint(x,y));
    })()`),
    'visible, unblocked control: ' + selector
  )
  await js(
    `(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.focus({preventScroll:true});target.click()})()`
  )
}

async function verifySettingsReset(js) {
  const toggle = '.weather-settings [role="switch"][aria-label="显示宜忌"]'
  await clickVisible(js, '.titlebar-btn-settings')
  await until(() => js('Boolean(document.querySelector(".settings-panel.active"))'), '设置面板打开')
  await clickVisible(js, toggle)
  await until(
    () =>
      js(`(async()=>{
      const snapshot=await window.api.getSettingsSnapshot();
      return snapshot.values.almanac.enabled===false &&
        document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')==='false' &&
        !document.querySelector('.almanac-brief__button');
    })()`),
    '设置UI关闭宜忌后快照、开关和工具栏同步'
  )
  await js(
    `(()=>{window.__dateContextResetToggle=document.querySelector(${JSON.stringify(toggle)})})()`
  )
  await clickVisible(js, '.settings-data .base-btn:first-child')
  const confirm = '.confirm-card.active[aria-label="恢复默认设置"]'
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(confirm)}))`),
    '恢复默认设置确认打开'
  )
  await clickVisible(js, confirm + ' .confirm-actions button:last-child')
  await until(
    () =>
      js(`(async()=>{
      const snapshot=await window.api.getSettingsSnapshot();
      return snapshot.values.almanac.enabled===true &&
        document.querySelector('.settings-panel')?.getAttribute('aria-busy')==='false';
    })()`),
    '真实恢复默认操作完成，宜忌快照恢复开启'
  )
  const firstUse = '.app-modal-card[aria-label="欢迎使用 Abandon 便签"]'
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(firstUse)}))`),
    '恢复默认后显示首次使用须知'
  )
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(firstUse + ' [data-modal-initial-focus]')})?.textContent.trim()`
    ),
    '白嫖一下，已阅读'
  )
  await clickVisible(js, firstUse + ' [data-modal-initial-focus]')
  await until(
    () => js(`!document.querySelector(${JSON.stringify(firstUse)})`),
    '通过可见按钮完成首次使用须知'
  )
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')==='true' && Boolean(document.querySelector('.almanac-brief__button'))`
      ),
    '恢复默认后已挂载的宜忌开关和工具栏同步开启'
  )
  assert.equal(
    await js(`window.__dateContextResetToggle===document.querySelector(${JSON.stringify(toggle)})`),
    true,
    '恢复默认必须更新同一个已挂载控件，不能靠重开设置掩盖旧状态'
  )
  await clickVisible(js, toggle)
  await until(
    () =>
      js(`(async()=>{
      const snapshot=await window.api.getSettingsSnapshot();
      return snapshot.values.almanac.enabled===false &&
        document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')==='false' &&
        !document.querySelector('.almanac-brief__button');
    })()`),
    '恢复默认后再点击一次即可关闭宜忌'
  )
  await until(
    () => js(`!document.querySelector(${JSON.stringify(toggle)})?.disabled`),
    '宜忌保存后控件可用'
  )
  await clickVisible(js, toggle)
  await until(
    () => js('Boolean(document.querySelector(".almanac-brief__button"))'),
    '恢复后续用例的默认宜忌显示'
  )
  await clickVisible(js, '.settings-panel.active .panel-close-btn')
  await until(() => js('!document.querySelector(".settings-panel")'), '设置面板关闭')
  scenarios.push(
    'visible settings reset synchronizes mounted almanac toggle, snapshot and toolbar; next click disables it'
  )
}

async function verifyCalendarSpace(win, js, view, today) {
  win.setContentSize(900, 760)
  const panelToggle = '.month-toolbar__day-panel-toggle'
  if (await js(`document.querySelector('${panelToggle}')?.getAttribute('aria-expanded')==='true'`))
    await clickVisible(js, panelToggle)
  await until(() => js('!document.querySelector(".month-day-panel")'), view + '日期侧栏关闭')
  async function leaveDateCell() {
    await js(`document.querySelector('${panelToggle}').focus({preventScroll:true})`)
    const point = await js(
      `(()=>{const r=document.querySelector('${panelToggle}').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    await until(
      () => js(`!document.querySelector('.month-day-cell:hover,.month-day-cell:focus-within')`),
      view + '焦点和鼠标离开日期格'
    )
    await wait(300)
  }
  const cell = `.month-day-cell[data-date="${today}"]`
  const metrics = () =>
    js(`(()=>{
    const cell=document.querySelector(${JSON.stringify(cell)}),header=cell?.querySelector('.month-day-cell__header'),lunar=header?.querySelector('.month-day-cell__lunar'),context=header?.querySelector('.month-day-cell__context');
    if(!header || !lunar)return null;
    return {lunar:lunar.getBoundingClientRect().width,header:header.getBoundingClientRect().width,
      tracks:getComputedStyle(header).gridTemplateColumns.split(' ').map(Number.parseFloat),
      context:context?.getBoundingClientRect().width||0,opacity:context?Number(getComputedStyle(context).opacity):0};
  })()`)
  await leaveDateCell()
  await until(
    () =>
      js(`Boolean(document.querySelector(${JSON.stringify(cell + ' .month-day-cell__lunar')}))`),
    view + '今天的农历已加载'
  )
  const off = await metrics()
  assert.ok(off.lunar > 0, view + '全部关闭后农历仍可见')
  const emptyHeaders =
    await js(`Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"] .month-day-cell__header')).map(header=>({
    hasContext:!!header.querySelector('.month-day-cell__context'),
    contextTrack:Number.parseFloat(getComputedStyle(header).gridTemplateColumns.split(' ')[2])
  }))`)
  assert.ok(emptyHeaders.length > 0, view + '有可检查的有效日期格')
  assert.ok(
    emptyHeaders.every((header) => !header.hasContext && header.contextTrack <= 1),
    view + '全部关闭后所有日期头部均释放空摘要列: ' + JSON.stringify(emptyHeaders)
  )
  for (const [theme, bg, fg, image] of [
    ['white', '255 255 255', '#111111', 'none'],
    ['black', '0 0 0', '#ffffff', 'none'],
    [
      'wallpaper',
      '24 32 42',
      '#ffffff',
      'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)'
    ]
  ]) {
    await js(`(async()=>{
      await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)});
      await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)});
      document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(image)};
    })()`)
    await wait(250)
    const name = `${view}-all-off-${theme}.png`
    writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG())
    captures.push(name)
  }
  await js(
    `document.querySelector('.app-bg').style.removeProperty('background-image');window.api.setSettingValue('almanac.enabled',true)`
  )
  await until(
    () =>
      js(
        `Boolean(document.querySelector(${JSON.stringify(cell + ' .month-day-cell__context.is-almanac')}))`
      ),
    view + '开启宜忌后日期摘要挂载'
  )
  await leaveDateCell()
  const collapsed = await metrics()
  assert.ok(
    Math.abs(off.lunar - collapsed.lunar) <= 1.5,
    view + '全关与宜忌未展开时农历均使用同样的可用宽度: ' + JSON.stringify({ off, collapsed })
  )
  assert.ok(collapsed.context <= 1 && collapsed.opacity === 0, view + '非悬停宜忌摘要不占位')
  await js(`document.querySelector(${JSON.stringify(cell)}).focus({preventScroll:true})`)
  await until(async () => {
    const expanded = await metrics()
    return expanded.context > 1 && expanded.opacity > 0.99 && expanded.lunar < collapsed.lunar - 1
  }, view + '键盘聚焦日期格后宜忌展开并释放对应农历宽度')
  await leaveDateCell()
  await until(async () => {
    const closed = await metrics()
    return (
      closed.context <= 1 && closed.opacity === 0 && Math.abs(closed.lunar - collapsed.lunar) <= 1.5
    )
  }, view + '焦点离开后宜忌收回且农历宽度恢复')
  const hover = await js(
    `(()=>{const r=document.querySelector(${JSON.stringify(cell + ' .month-day-cell__header')}).getBoundingClientRect();return {x:Math.round(r.left+5),y:Math.round(r.top+r.height/2)}})()`
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', ...hover })
  await until(async () => {
    const expanded = await metrics()
    return expanded.context > 1 && expanded.opacity > 0.99 && expanded.lunar < collapsed.lunar - 1
  }, view + '真实鼠标悬停日期格后宜忌仍可展开')
  assert.equal(
    await js(`document.querySelector(${JSON.stringify(cell)}).matches(':focus-within')`),
    false,
    view + '悬停检查不依赖日期格焦点'
  )
  await leaveDateCell()
  await js(`window.api.setSettingValue('almanac.enabled',false)`)
  await until(
    () => js('!document.querySelector(".month-day-cell__context")'),
    view + '恢复全关状态'
  )
  scenarios.push(
    view +
      ': no empty summary columns; lunar width preserved; keyboard and pointer reveal remain functional; three background captures'
  )
}

async function run() {
  try {
    let win
    await until(() => {
      win = BrowserWindow.getAllWindows().find((w) =>
        /\/(index|month|week)\.html(?:$|[?#])/.test(w.webContents.getURL())
      )
      return win?.isVisible()
    }, '主窗口没有显示')
    current = win
    const js = (code) => win.webContents.executeJavaScript(code, true)
    const today = localDateKey()
    const tomorrow = addCalendarDays(today, 1)
    const location = {
      name: '北京',
      latitude: 39.9,
      longitude: 116.4,
      timezone: 'Asia/Shanghai',
      countryCode: 'CN'
    }
    const forecast = {
      location,
      timezone: 'Asia/Shanghai',
      fetchedAt: Date.now(),
      current: {
        dataAt: Date.now(),
        time: `${today}T10:00`,
        temperature: 25,
        apparentTemperature: 24,
        weatherCode: 0,
        isDay: 1,
        windSpeed: 12
      },
      days: [today, tomorrow].map((date, index) => ({
        date,
        weatherCode: index ? 3 : 0,
        icon: index ? '☁' : '☀',
        label: index ? '阴' : '晴',
        temperatureMin: index ? 19 : 18,
        temperatureMax: index ? 29 : 28,
        precipitationProbability: 20,
        precipitation: 2.6,
        windSpeedMax: 18.5
      }))
    }
    ipcMain.removeHandler('weather:get-forecast')
    ipcMain.handle('weather:get-forecast', () => forecast)
    await until(
      () => js('Boolean(document.querySelector(".almanac-brief__button"))'),
      '默认宜忌没有显示'
    )
    win.setContentSize(900, 760)
    win.focus()
    await verifySettingsReset(js)
    await js("window.api.createNote({content:'天气宜忌显示专项便签'})")
    await until(
      () => js('Boolean(document.querySelector(".nl-card-date-context"))'),
      '卡片日期摘要没有显示'
    )
    await js(
      `(async()=>{await window.api.setSettingValue('weather.location',${JSON.stringify(location)});await window.api.setSettingValue('weather.enabled',true)})()`
    )
    await until(
      () => js('document.querySelector(".weather-brief__button")?.textContent.includes("28°")'),
      '天气没有显示'
    )
    await js('document.querySelector(".weather-brief__button").click()')
    await until(
      () => js('document.querySelectorAll(".date-context-popover__group").length===2'),
      '统一详情没有宜忌'
    )
    assert.equal(
      await js('Boolean(document.querySelector(".date-context-popover__weather"))'),
      true
    )
    await js('document.querySelector(".date-context-details [aria-label=后一天]").click()')
    await until(
      () =>
        js(
          `document.querySelector('.date-context-details')?.dataset.date===${JSON.stringify(tomorrow)} && document.querySelector('.date-context-details__weather')?.textContent.includes('29°') && document.querySelector('.date-context-details__almanac')?.dataset.date===${JSON.stringify(tomorrow)}`
        ),
      '箭头切换后天气与宜忌日期不同步'
    )
    await js('document.querySelector(".date-context-details__today").click()')
    await until(
      () =>
        js(
          `document.querySelector('.date-context-details')?.dataset.date===${JSON.stringify(today)}`
        ),
      '今天按钮失效'
    )
    win.focus()
    await js('document.querySelector(".date-context-details .date-picker__trigger").click()')
    await until(
      () =>
        js(
          'Boolean(document.querySelector(".date-picker-panel")) && Boolean(document.querySelector(".date-context-popover"))'
        ),
      '日期选择器误关详情'
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(
      () => js('!document.querySelector(".date-picker-panel")'),
      'Escape未关闭内层日期选择器'
    )
    assert.equal(
      await js('Boolean(document.querySelector(".date-context-popover"))'),
      true,
      '内层Escape误关详情'
    )
    await js('document.querySelector(".date-context-details .date-picker__trigger").click()')
    await until(
      () => js('Boolean(document.querySelector(".date-picker-panel"))'),
      '日期选择器未再次打开'
    )
    await js(`document.querySelector('.date-picker-panel__day[aria-label="${tomorrow}"]').click()`)
    await until(
      () =>
        js(
          `document.querySelector('.date-context-details')?.dataset.date===${JSON.stringify(tomorrow)} && !document.querySelector('.date-picker-panel')`
        ),
      '选中日期没有应用'
    )
    await until(() => js('!document.querySelector(".msg-toast")'), '结果提示退出后检查日期详情外观')
    for (const [theme, bg, fg] of [
      ['light', '255 255 255', '#111111'],
      ['dark', '0 0 0', '#ffffff'],
      ['wallpaper', '24 32 42', '#ffffff']
    ]) {
      await js(
        `(async()=>{await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)});await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)});document.body.style.background=${JSON.stringify(theme === 'wallpaper' ? 'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)' : `rgb(${bg})`)}})()`
      )
      win.setSize(445, 760)
      await new Promise((done) => setTimeout(done, 250))
      const bounds = await js(
        `(()=>{const p=document.querySelector('.date-context-popover'),r=p.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:p.scrollWidth>p.clientWidth+1}})()`
      )
      assert.ok(
        bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= bounds.width &&
          bounds.bottom <= bounds.height &&
          !bounds.overflow,
        JSON.stringify(bounds)
      )
      assert.equal(
        await js("getComputedStyle(document.querySelector('.date-context-popover')).color"),
        theme === 'light' ? 'rgb(17, 17, 17)' : 'rgb(255, 255, 255)',
        '打开的详情必须同步主题文字色'
      )
      writeFileSync(join(output, `${theme}.png`), (await win.webContents.capturePage()).toPNG())
      captures.push(`${theme}.png`)
      await js('document.querySelector(".date-context-details__today").click()')
      await until(
        () =>
          js(
            `document.querySelector('.date-context-details')?.dataset.date===${JSON.stringify(today)} && document.querySelector('.date-context-details__weather')?.textContent.includes('25') && document.querySelector('.date-context-details__almanac')?.dataset.date===${JSON.stringify(today)}`
          ),
        `${theme} 当前天气与宜忌同步到今天`
      )
      await wait(250)
      writeFileSync(
        join(output, `${theme}-today.png`),
        (await win.webContents.capturePage()).toPNG()
      )
      captures.push(`${theme}-today.png`)
      await js('document.querySelector(".date-context-details [aria-label=后一天]").click()')
      await until(
        () =>
          js(
            `document.querySelector('.date-context-details')?.dataset.date===${JSON.stringify(tomorrow)} && document.querySelector('.date-context-details__almanac')?.dataset.date===${JSON.stringify(tomorrow)}`
          ),
        `${theme} 预报详情恢复所选日期`
      )
    }
    await js("window.api.setSettingValue('appearance.uiScale',1.5)")
    await wait(350)
    const scaledBounds = await js(`(()=>{
      const panel=document.querySelector('.date-context-popover'),rect=panel.getBoundingClientRect();
      return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,
        overflow:panel.scrollWidth>panel.clientWidth+1,
        navigationFits:Array.from(panel.querySelectorAll('.date-context-details__navigation button')).every(button=>{
          const box=button.getBoundingClientRect();return box.left>=rect.left && box.right<=rect.right+1;
        })};
    })()`)
    assert.ok(
      scaledBounds.left >= 0 &&
        scaledBounds.top >= 0 &&
        scaledBounds.right <= scaledBounds.width + 1 &&
        scaledBounds.bottom <= scaledBounds.height + 1 &&
        !scaledBounds.overflow &&
        scaledBounds.navigationFits,
      '150%窄窗日期详情及导航保持在视口内: ' + JSON.stringify(scaledBounds)
    )
    writeFileSync(join(output, 'narrow-150.png'), (await win.webContents.capturePage()).toPNG())
    captures.push('narrow-150.png')
    await js("window.api.setSettingValue('appearance.uiScale',1)")
    await wait(250)
    await js('document.querySelector(".date-context-popover__header button").click()')
    await until(() => js('!document.querySelector(".date-context-popover")'), '详情未关闭')
    for (const view of ['list', 'month', 'week']) {
      if (view !== 'list') await js(`window.api.switchMainView(${JSON.stringify(view)})`)
      await until(
        () =>
          js(
            view === 'list'
              ? 'Boolean(document.querySelector(".note-list"))'
              : `location.pathname.endsWith('/${view}.html') && Boolean(document.querySelector('.month-toolbar__day-panel-toggle:not(:disabled)'))`
          ),
        `${view}未加载`
      )
      if (view !== 'list') {
        await js("document.querySelector('.month-toolbar [aria-label=展开日期列表]')?.click()")
        await until(
          () => js('Boolean(document.querySelector(".month-day-panel"))'),
          `${view}日期侧栏没有显示`
        )
      }
      for (const [weather, almanac] of [
        [true, true],
        [false, true],
        [true, false],
        [false, false]
      ]) {
        await js(
          `(async()=>{await window.api.setSettingValue('weather.enabled',${weather});await window.api.setSettingValue('almanac.enabled',${almanac})})()`
        )
        await until(
          () =>
            js(
              `Boolean(document.querySelector('.weather-brief__button'))===${weather} && Boolean(document.querySelector('.almanac-brief__button'))===${almanac}`
            ),
          `${view}开关组合未同步`
        )
        if (!weather && !almanac) {
          assert.equal(
            await js('document.querySelectorAll(".date-context-badge").length'),
            0,
            `${view}关闭后仍有日期摘要`
          )
          assert.equal(
            await js(
              `document.querySelector('.nl-toolbar,.month-toolbar')?.textContent.includes('天气暂无数据')`
            ),
            false
          )
        }
        if (weather || almanac) {
          await js(
            `document.querySelector(${JSON.stringify(weather ? '.weather-brief__button' : '.almanac-brief__button')}).click()`
          )
          await until(
            () => js('Boolean(document.querySelector(".date-context-details"))'),
            '详情未打开'
          )
          assert.equal(
            await js('Boolean(document.querySelector(".date-context-details__weather"))'),
            weather
          )
          assert.equal(
            await js('Boolean(document.querySelector(".date-context-details__almanac"))'),
            almanac
          )
          await js('document.querySelector(".date-context-popover__header button").click()')
          await until(() => js('!document.querySelector(".date-context-popover")'), '详情未关闭')
        }
      }
      if (view !== 'list') await verifyCalendarSpace(win, js, view, today)
    }
    scenarios.push(
      'date picker, arrows, synchronized data, nested Escape, four setting combinations in three views, three detail themes'
    )
    process.stderr.write(
      '[date-context-controls] passed: settings reset, calendar space and reveal, date controls, 4 switch combinations across 3 views, 3 themes\n'
    )
    await lifecycle.finish({
      completed: true,
      window: win,
      summary: { scenarios, captures, views: ['list', 'month', 'week'], combinations: 4, themes: 3 }
    })
  } catch (error) {
    process.stderr.write(`[date-context-controls] ${error.stack || error}\n`)
    await lifecycle.finish({ error, window: current, summary: { scenarios, captures } })
  }
}

try {
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'built main chunk exists')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  void lifecycle.finish({ error, window: current, summary: { scenarios, captures } })
}
