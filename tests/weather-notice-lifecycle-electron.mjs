import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { localDateKey } from '../src/shared/calendar/calendar-date-rules.js'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/weather-notice-lifecycle-electron.mjs',
  mode: 'electron-real-app-weather-notice-request-lifecycle',
  prefix: 'abandon-weather-notice-lifecycle-',
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    runtimeAppBootstrap: true,
    sqlite: 'real-disk-settings-and-notices',
    geolocation: 'controlled-native-callback-fixture',
    reverseLookup: 'controlled-renderer-fetch-ignoring-abort',
    acknowledgement: 'delayed-IPC-with-real-SQLite-write',
    nativePointerInput: false,
    systemLocationPermissionRequested: false,
    externalNetwork: false,
    mainProcessRestart: false
  },
  timeoutMs: 90000
})
const { assert, root: profile } = lifecycle
const require = createRequire(import.meta.url)
const originalMainFetch = globalThis.fetch
const scenarios = []
const acknowledgements = []
let current
let fixtureDb
let releaseAcknowledgement
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const js = (code) => current.webContents.executeJavaScript(code, true)
const weatherToggle = '.weather-settings [role="switch"][aria-label="显示天气"]'
const notice = '.app-modal-card[aria-label="软件通知"]'

function seedSettings() {
  const db = new Database(join(profile, 'app.db'))
  try {
    db.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
      PRIMARY KEY(window_name,key))`)
    const insert = db.prepare(
      'INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
    ])
      insert.run(...row)
  } finally {
    db.close()
  }
}

// Keep the real weather service and refresh controller, with a deterministic
// forecast transport. No scenario needs the public network or OS permission.
function isolateMainNetwork() {
  const today = localDateKey()
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname !== 'api.open-meteo.com')
      throw new Error('Unexpected external request in weather/notice lifecycle test: ' + url.origin)
    return new Response(
      JSON.stringify({
        timezone: 'Asia/Shanghai',
        utc_offset_seconds: 28800,
        current: { time: today + 'T12:00', temperature_2m: 25, weather_code: 0, is_day: 1 },
        daily: {
          time: [today],
          weather_code: [0],
          temperature_2m_min: [18],
          temperature_2m_max: [28]
        }
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await predicate()) {
      assert.ok(true, label)
      return
    }
    await wait(25)
  }
  assert.fail(label)
}

// Exercise only controls which actually receive hit testing in the real app.
async function clickVisible(selector) {
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
    'visible and unblocked: ' + selector
  )
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

async function openSettings() {
  await clickVisible('.titlebar-btn-settings')
  await until(
    () => js('Boolean(document.querySelector(".settings-panel.active"))'),
    'settings opened'
  )
  await until(
    () => js('Boolean(document.querySelector(".china-area-cascader__trigger:not(:disabled)"))'),
    'weather settings and division data ready'
  )
}

async function closeSettings() {
  await clickVisible('.settings-panel.active .panel-close-btn')
  await until(
    () => js('!document.querySelector(".settings-panel")'),
    'settings component unmounted'
  )
}

async function chooseDistrict() {
  await clickVisible('.china-area-cascader__trigger')
  for (const [column, name] of [
    ['省级地区', '广东省'],
    ['市级地区', '广州市'],
    ['区县级地区', '增城区']
  ]) {
    await until(
      () =>
        js(`(()=>{
          document.querySelector('[data-lifecycle-option]')?.removeAttribute('data-lifecycle-option');
          const column=document.querySelector(${JSON.stringify('[role="listbox"][aria-label="' + column + '"]')});
          const button=[...(column?.querySelectorAll('button')||[])].find(item=>item.querySelector('span')?.textContent.trim()===${JSON.stringify(name)});
          button?.setAttribute('data-lifecycle-option','');return Boolean(button);
        })()`),
      'real cascader option: ' + name
    )
    await clickVisible('[data-lifecycle-option]')
  }
  await until(
    () =>
      js(`(async()=>{
        const snapshot=await window.api.getSettingsSnapshot();
        return snapshot.values.weather.location?.id===440118 && snapshot.values.weather.enabled &&
          !document.querySelector(${JSON.stringify(weatherToggle)})?.disabled;
      })()`),
    'new component manually saved Guangzhou district and enabled weather'
  )
  await clickVisible(weatherToggle)
  await until(
    () =>
      js(`(async()=>{
        const snapshot=await window.api.getSettingsSnapshot();
        return snapshot.values.weather.enabled===false &&
          document.querySelector(${JSON.stringify(weatherToggle)})?.getAttribute('aria-checked')==='false' &&
          !document.querySelector(${JSON.stringify(weatherToggle)})?.disabled;
      })()`),
    'new component explicitly disabled weather after manual choice'
  )
}

async function installRendererFixtures() {
  await js(`(()=>{
    const originalDescriptor=Object.getOwnPropertyDescriptor(navigator,'geolocation');
    const originalFetch=window.fetch;
    const state=window.__weatherNoticeLifecycle={
      requests:[],lookups:[],deferLookup:false,
      reverseBody:{city:'杭州市',locality:'西湖区',principalSubdivision:'浙江省',countryName:'中国',countryCode:'CN',latitude:30.2741,longitude:120.1551},
      restore(){
        if(originalDescriptor)Object.defineProperty(navigator,'geolocation',originalDescriptor);
        else delete navigator.geolocation;
        window.fetch=originalFetch;
        delete window.__weatherNoticeLifecycle;
      }
    };
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
      getCurrentPosition(success,failure,options){state.requests.push({success,failure,options})}
    }});
    window.fetch=(input,options)=>{
      const url=new URL(String(input));
      if(url.hostname!=='api.bigdatacloud.net')return Promise.reject(new Error('Unexpected renderer fetch: '+url.origin));
      const lookup={url:url.href,signal:options?.signal,settled:false};state.lookups.push(lookup);
      const response=()=>({ok:true,status:200,json:async()=>state.reverseBody});
      // Deliberately ignore AbortSignal so ownership checks must reject late data.
      if(state.deferLookup)return new Promise(resolve=>{lookup.resolve=()=>{lookup.settled=true;resolve(response())}});
      lookup.settled=true;return Promise.resolve(response());
    };
  })()`)
}

function weatherWrites() {
  return fixtureDb.prepare('SELECT id,key,value FROM lifecycle_weather_writes ORDER BY id').all()
}

async function clearWeather() {
  await js(`(async()=>{
    await window.api.setSettingValue('weather.enabled',false);
    await window.api.setSettingValue('weather.location',null);
  })()`)
}

async function verifyActiveDeviceLocation() {
  await clearWeather()
  await openSettings()
  await clickVisible('.weather-settings__picker button')
  await until(
    () => js('window.__weatherNoticeLifecycle.requests.length===1'),
    'actual device-location button requested native callback'
  )
  await js(
    `window.__weatherNoticeLifecycle.requests[0].success({coords:{latitude:30.2741,longitude:120.1551,accuracy:100}})`
  )
  await until(
    () =>
      js(`(async()=>{
        const snapshot=await window.api.getSettingsSnapshot();
        return snapshot.values.weather.location?.name==='西湖区' && snapshot.values.weather.enabled &&
          !document.querySelector(${JSON.stringify(weatherToggle)})?.disabled;
      })()`),
    'current native callback still saves resolved district and enables weather'
  )
  assert.equal(await js('window.__weatherNoticeLifecycle.lookups.length'), 1)
  await closeSettings()
  scenarios.push(
    'active native callback: real renderer, reverse lookup fixture, settings IPC and SQLite save'
  )
}

async function verifyStaleLocation(kind) {
  await clearWeather()
  await js(`window.__weatherNoticeLifecycle.deferLookup=${kind === 'reverse-response'}`)
  await openSettings()
  const index = await js('window.__weatherNoticeLifecycle.requests.length')
  const lookupsBefore = await js('window.__weatherNoticeLifecycle.lookups.length')
  await js(
    `window.__weatherNoticeLifecycle.oldSettings=document.querySelector('.weather-settings')`
  )
  await clickVisible('.weather-settings__picker button')
  await until(
    () => js(`window.__weatherNoticeLifecycle.requests.length===${index + 1}`),
    kind + ': device request captured'
  )
  if (kind === 'reverse-response') {
    await js(
      `window.__weatherNoticeLifecycle.requests[${index}].success({coords:{latitude:30.2741,longitude:120.1551,accuracy:100}})`
    )
    await until(
      () => js(`window.__weatherNoticeLifecycle.lookups.length===${lookupsBefore + 1}`),
      'old component reverse lookup is pending'
    )
  }
  await closeSettings()
  await openSettings()
  assert.equal(
    await js(
      `window.__weatherNoticeLifecycle.oldSettings===document.querySelector('.weather-settings')`
    ),
    false,
    'actual weather settings component was replaced'
  )
  await chooseDistrict()
  const before = weatherWrites()
  const expectedLookups = lookupsBefore + (kind === 'reverse-response' ? 1 : 0)
  if (kind === 'reverse-response') {
    assert.equal(
      await js(`window.__weatherNoticeLifecycle.lookups[${lookupsBefore}].signal.aborted`),
      true,
      'unmount aborts in-flight reverse lookup'
    )
    await js(`window.__weatherNoticeLifecycle.lookups[${lookupsBefore}].resolve()`)
  } else if (kind === 'native-success') {
    await js(
      `window.__weatherNoticeLifecycle.requests[${index}].success({coords:{latitude:30.2741,longitude:120.1551,accuracy:100}})`
    )
  } else {
    await js(
      `window.__weatherNoticeLifecycle.requests[${index}].failure({code:2,message:'late native failure'})`
    )
  }
  assert.equal(
    await js('window.__weatherNoticeLifecycle.lookups.length'),
    expectedLookups,
    kind + ': stale callback must not start a reverse lookup or network fallback'
  )
  // All fixture responses resolve immediately. Drain the renderer tasks and IPC
  // before comparing the durable write log, including forbidden enable writes.
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await wait(150)
  const weather = await js(
    'window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.weather)'
  )
  assert.equal(weather.location.id, 440118, kind + ': old request must preserve newer district')
  assert.equal(weather.enabled, false, kind + ': old request must preserve explicit disable')
  assert.deepEqual(
    weatherWrites(),
    before,
    kind + ': stale request must issue no later settings write'
  )
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(weatherToggle)})?.getAttribute('aria-checked')`
    ),
    'false'
  )
  await closeSettings()
  scenarios.push(
    kind + ': old component cannot overwrite remounted manual choice or re-enable weather'
  )
}

async function verifyNoticePaging() {
  const insert = fixtureDb.prepare(`INSERT INTO remote_notices
    (server_notice_id,sequence,title,body,published_at,received_at) VALUES(?,?,?,?,?,?)`)
  const now = Date.now()
  const first = Number(
    insert.run('lifecycle:A', 1, '生命周期通知 A', '正在保存 A 时可以继续阅读 B。', now, now)
      .lastInsertRowid
  )
  const second = Number(
    insert.run('lifecycle:B', 2, '生命周期通知 B', 'A 的响应只能移除 A。', now + 1, now + 1)
      .lastInsertRowid
  )
  ipcMain.removeHandler('remote-notices:acknowledge')
  ipcMain.handle('remote-notices:acknowledge', async (event, { id }) => {
    assert.equal(event.sender, current.webContents, 'acknowledgement comes from actual app preload')
    acknowledgements.push(id)
    if (id === first)
      await new Promise((done) => {
        releaseAcknowledgement = done
      })
    return (
      fixtureDb
        .prepare('UPDATE remote_notices SET acknowledged_at=? WHERE id=?')
        .run(Date.now(), id).changes > 0
    )
  })
  current.webContents.send('remote-notices:changed')
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(notice + ' h2')})?.textContent==='生命周期通知 A'`
      ),
    'real notice-change event opens A through product pending-list and modal queue'
  )
  await clickVisible(notice + ' .app-modal-footer .base-btn')
  await until(
    () => acknowledgements.length === 1 && Boolean(releaseAcknowledgement),
    'A acknowledgement IPC is pending'
  )
  assert.deepEqual(acknowledgements, [first])
  assert.equal(
    await js(`document.querySelector(${JSON.stringify(notice + ' .base-btn')})?.disabled`),
    true
  )
  await clickVisible(notice + ' [aria-label="下一条通知"]')
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(notice + ' h2')})?.textContent==='生命周期通知 B'`
      ),
    'actual next-notice control remains usable while A is saving'
  )
  releaseAcknowledgement()
  releaseAcknowledgement = null
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(notice + ' h2')})?.textContent==='生命周期通知 B' && !document.querySelector(${JSON.stringify(notice + ' .base-btn')})?.disabled && !document.querySelector(${JSON.stringify(notice + ' [aria-label="下一条通知"]')})`
      ),
    'A response removes A from actual parent pending list while preserving displayed B'
  )
  assert.deepEqual(
    await js('window.api.listPendingRemoteNotices().then(rows=>rows.map(row=>row.id))'),
    [second]
  )
  await clickVisible(notice + ' .app-modal-footer .base-btn')
  await until(
    () => js(`!document.querySelector(${JSON.stringify(notice)})`),
    'B acknowledgement closes empty actual pending list'
  )
  assert.deepEqual(
    acknowledgements,
    [first, second],
    'each actual notice acknowledgement keeps its own ID'
  )
  assert.deepEqual(await js('window.api.listPendingRemoteNotices()'), [])
  scenarios.push(
    'actual A acknowledgement pending, actual next control displays B, A response removes only A, B remains actionable'
  )
}

async function restore() {
  releaseAcknowledgement?.()
  if (current && !current.isDestroyed()) await js('window.__weatherNoticeLifecycle?.restore()')
  globalThis.fetch = originalMainFetch
  fixtureDb?.close()
  fixtureDb = null
}

async function run() {
  try {
    await until(() => {
      current = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
      )
      return current?.isVisible()
    }, 'real list window visible')
    current.setContentSize(445, 852)
    current.focus()
    await until(
      () => js('Boolean(document.querySelector(".titlebar-btn-settings"))'),
      'renderer ready'
    )
    fixtureDb = new Database(join(profile, 'app.db'))
    fixtureDb.exec(`
      CREATE TABLE lifecycle_weather_writes(id INTEGER PRIMARY KEY,key TEXT,value TEXT);
      CREATE TRIGGER lifecycle_weather_insert AFTER INSERT ON app_settings
      WHEN NEW.type='weather' BEGIN
        INSERT INTO lifecycle_weather_writes(key,value) VALUES(NEW.key,NEW.value); END;
      CREATE TRIGGER lifecycle_weather_update AFTER UPDATE ON app_settings
      WHEN NEW.type='weather' BEGIN
        INSERT INTO lifecycle_weather_writes(key,value) VALUES(NEW.key,NEW.value); END;
    `)
    await installRendererFixtures()
    await verifyActiveDeviceLocation()
    for (const kind of ['native-success', 'native-failure', 'reverse-response'])
      await verifyStaleLocation(kind)
    await verifyNoticePaging()
    process.stderr.write(
      '[weather-notice-lifecycle] passed actual settings remount, stale native/reverse callbacks and notice paging\n'
    )
    await lifecycle.finish({
      completed: true,
      window: current,
      summary: { scenarios, acknowledgements },
      restore
    })
  } catch (error) {
    process.stderr.write(`[weather-notice-lifecycle] ${error.stack || error}\n`)
    await lifecycle.finish({
      error,
      window: current,
      summary: { scenarios, acknowledgements },
      restore
    })
  }
}

try {
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  isolateMainNetwork()
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'built main chunk exists')
  require(resolve('out/main/chunks', chunk))
  if (app.isReady()) void run()
  else app.once('ready', () => void run())
} catch (error) {
  void lifecycle.finish({
    error,
    window: current,
    summary: { scenarios, acknowledgements },
    restore
  })
}
