import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AppUpdateService } from '../src/main/services/app-update.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/app-update-intent-electron.mjs',
  mode: 'electron-real-app-update-display-intent',
  prefix: 'abandon-update-display-intent-',
  timeoutMs: 90000,
  destroyWindowsBeforeQuit: false,
  metadata: {
    realWindows: true,
    realRendererAndPreload: true,
    runtimeAppBootstrap: true,
    updateService: 'real-source-AppUpdateService-with-controlled-two-endpoint-fetch',
    updateIpc: 'owned-main-window-and-main-frame-only',
    nativePointerInput: false,
    externalNetwork: false,
    downloads: false,
    mainProcessRestart: false,
    scope: 'list startup silent check joined by the actual settings button; current and error'
  }
})
const { assert, root: profile } = lifecycle
const evidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || profile
const require = createRequire(import.meta.url)
const indexUrl = pathToFileURL(resolve('out/renderer/index.html')).href
const originalFetch = globalThis.fetch
const originalOpenExternal = shell.openExternal
const endpoints = new Map([
  ['https://api.gitcode.com/api/v5/repos/zou-feiming/abandon_note2/releases/latest', 'gitcode'],
  ['https://api.github.com/repos/feimingabandon/abandon_note2/releases/latest', 'github']
])
const rounds = []
const navigations = []
const unexpectedNetwork = []
const externalAttempts = []
const rendererErrors = []
const screenshots = []
let current
let service
let activeRound
let installed = false
let phase = 'setup'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

async function bounded(task, label, timeoutMs = 8000) {
  let timer
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

const js = (code) =>
  bounded(current.webContents.executeJavaScript(code, true), 'renderer evaluation: ' + phase)

async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value && Date.now() < deadline) {
      assert.ok(true, label)
      return value
    }
    await wait(25)
  }
  assert.fail(label + ' timed out during ' + phase)
}

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
      ['main', 'system', 'blur_enabled', 'false'],
      ['application', 'weather', 'enabled', 'false'],
      ...['screenshot', 'screenshot_copy', 'clipboard_pin', 'toggle_pins', 'view_visibility'].map(
        (key) => ['application', 'shortcuts', key, '']
      )
    ])
      insert.run(...row)
  } finally {
    db.close()
  }
}

function newRound(kind) {
  const round = { kind, startedAt: Date.now(), network: [], ipc: [], probe: null, phase: 'startup' }
  rounds.push(round)
  activeRound = round
  return round
}

function releasePayload(source) {
  const version = app.getVersion()
  const name = `Abandon-Note-${version}-windows-x64-setup.exe`
  const repository =
    source === 'gitcode'
      ? 'gitcode.com/zou-feiming/abandon_note2'
      : 'github.com/feimingabandon/abandon_note2'
  return {
    tag_name: 'v' + version,
    name: 'Controlled same-version release',
    body: 'Controlled update transport fixture; no public service claim.',
    assets: [
      {
        name,
        size: 2048,
        browser_download_url: `https://${repository}/releases/download/v${version}/${name}`
      }
    ]
  }
}

function controlledFetch(input, options = {}) {
  const url = String(input)
  const source = endpoints.get(url)
  const round = activeRound
  if (!source || !round) {
    unexpectedNetwork.push({ url, time: Date.now(), phase })
    return Promise.reject(new Error('Unexpected update transport request: ' + url))
  }
  return new Promise((resolveFetch, rejectFetch) => {
    const entry = { url, source, requestedAt: Date.now(), settledAt: null, outcome: 'pending' }
    let settled = false
    const settle = (outcome, error = null) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', aborted)
      entry.settledAt = Date.now()
      entry.outcome = outcome
      if (error) rejectFetch(error)
      else
        resolveFetch(
          new Response(JSON.stringify(releasePayload(source)), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
    }
    const aborted = () =>
      settle('aborted', options.signal.reason || new Error('Update fixture request aborted'))
    entry.release = () =>
      round.kind === 'current'
        ? settle('same-version-json')
        : settle('controlled-offline', new Error('controlled update endpoint offline: ' + source))
    entry.cancel = () => settle('cleanup', new Error('Controlled update fixture cleanup'))
    round.network.push(entry)
    if (options.signal?.aborted) aborted()
    else options.signal?.addEventListener('abort', aborted, { once: true })
  })
}

function assertOwnedMainFrame(event) {
  const contents = current?.webContents
  const frame = event.senderFrame
  if (
    !current ||
    current.isDestroyed() ||
    !contents ||
    contents.isDestroyed() ||
    event.sender !== contents ||
    !frame ||
    frame !== contents.mainFrame ||
    frame.isDestroyed() ||
    frame.detached ||
    frame.url !== indexUrl
  )
    throw new Error('Update fixture accepts only its live owned main document')
}

function installFixture(_event, contents) {
  contents.on('console-message', (details) => {
    if (contents === current?.webContents && details.level === 'error')
      rendererErrors.push({ time: Date.now(), message: details.message })
  })
  contents.on('did-start-navigation', (_navigation, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || url !== indexUrl) return
    const owner = BrowserWindow.fromWebContents(contents)
    if (!owner || (current && owner !== current)) return
    current = owner
    navigations.push({ time: Date.now(), url, windowId: owner.id, webContentsId: contents.id })
    if (installed) return
    installed = true
    // Product IPC registration precedes loading index.html. Replace only its
    // transport boundary before the real renderer can issue its startup check.
    ipcMain.removeHandler('update:check')
    ipcMain.handle('update:check', (event) => {
      assertOwnedMainFrame(event)
      const round = activeRound
      const entry = {
        origin: round.ipc.length === 0 ? 'real-renderer-startup' : 'explicit-preload-join',
        requestedAt: Date.now(),
        completedAt: null,
        result: null
      }
      round.ipc.push(entry)
      entry.task = service.check().then((result) => {
        entry.result = result
        entry.completedAt = Date.now()
        return result
      })
      return entry.task
    })
    ipcMain.removeHandler('update:open-link')
    ipcMain.handle('update:open-link', (event, request) => {
      assertOwnedMainFrame(event)
      externalAttempts.push({ time: Date.now(), boundary: 'update:open-link', request })
      throw new Error('Opening external update links is outside this test')
    })
  })
}

async function clickVisible(selector, recordManual = false) {
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
    'real control is visible and receives hit testing: ' + selector
  )
  await js(`(()=>{
    ${recordManual ? 'window.__updateIntentProbe.clickedAt=performance.now();' : ''}
    document.querySelector(${JSON.stringify(selector)}).click();
  })()`)
}

async function prepareRenderer(round) {
  await until(
    () => current && !current.isDestroyed() && current.isVisible(),
    round.kind + ': real list window shown'
  )
  current.focus()
  await until(
    () => js('Boolean(window.api && document.querySelector(".app-scene"))'),
    round.kind + ': production renderer and original preload ready'
  )
  // Empty shortcut configuration normally avoids this notice. If the real
  // startup component still appears, dismiss its actual button and handler.
  const startupNotice = await js('window.api.getShortcutStartupNotice()')
  if (startupNotice.length > 0) {
    await until(
      () => js('Boolean(document.querySelector(\'.app-modal-card[aria-label="快捷键启用提示"]\'))'),
      'real shortcut startup notice present'
    )
    await clickVisible('.app-modal-card[aria-label="快捷键启用提示"] .app-modal-close')
  }
  await until(
    () =>
      js(`(()=>{
        const scene=document.querySelector('.app-scene');
        return Boolean(scene && !scene.inert && !document.querySelector('.app-modal-card'));
      })()`),
    round.kind + ': startup scene released before opening settings'
  )
  assert.deepEqual(await js('window.api.getShortcutStartupNotice()'), [])
}

async function capture(label) {
  const screenshot = await bounded(current.webContents.capturePage(), label + ' screenshot', 3000)
  assert.equal(screenshot.isEmpty(), false, label + ': screenshot has pixels')
  const png = screenshot.toPNG()
  const file = label + '.png'
  writeFileSync(join(evidenceRoot, file), png, { flag: 'wx' })
  screenshots.push({ file, sha256: createHash('sha256').update(png).digest('hex') })
}

async function waitForVisualReady(title, contentSelectors) {
  // This is a DOM/animation readiness gate, not proof of a presented frame.
  // The following single capture remains subject to independent image review.
  return until(async () => {
    const snapshot = await js(`(()=>{
        const card=document.querySelector(${JSON.stringify('.app-modal-card[aria-label="' + title + '"]')});
        if(!card || document.visibilityState!=='visible')return {ready:false};
        const elements=[card,card.querySelector('.app-modal-heading h2'),
          ...${JSON.stringify(contentSelectors)}.map(selector=>card.querySelector(selector))];
        const details=elements.map(element=>{
          if(!element)return {visible:false};
          const rect=element.getBoundingClientRect();
          let opacity=1,visible=true;
          for(let ancestor=element;ancestor;ancestor=ancestor.parentElement){
            const style=getComputedStyle(ancestor);
            opacity*=Number(style.opacity);
            visible&&=style.display!=='none' && style.visibility==='visible';
          }
          const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
          return {opacity,visible:visible && opacity>=0.99 && rect.width>0 && rect.height>0 &&
            rect.left>=0 && rect.top>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight &&
            element.contains(hit),text:element===card?null:element.textContent.trim(),
            rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
        });
        const animations=new Set(card.getAnimations({subtree:true}));
        for(let ancestor=card.parentElement;ancestor;ancestor=ancestor.parentElement)
          for(const animation of ancestor.getAnimations())animations.add(animation);
        // The checking spinner intentionally runs forever; only finite effects
        // can delay the screenshot until modal/content transitions complete.
        const finiteActive=[...animations].filter(animation=>
          Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
          (animation.pending || !['finished','idle'].includes(animation.playState)));
        return {ready:details.every(detail=>detail.visible && detail.text!=='') && finiteActive.length===0,
          observedAt:performance.now(),title:${JSON.stringify(title)},details,activeFiniteAnimations:finiteActive.length};
      })()`)
    return snapshot.ready ? snapshot : false
  }, title + ': card and text fully visible with finite transitions complete before capture')
}

async function verifyRound(round) {
  phase = round.kind + ':startup'
  await prepareRenderer(round)
  await until(
    () => round.ipc.length === 1 && round.network.length === 2,
    round.kind + ': actual startup check is pending on both controlled endpoints'
  )
  assert.equal(round.ipc[0].completedAt, null, 'startup response remains withheld')
  assert.deepEqual(round.network.map((entry) => entry.source).sort(), ['gitcode', 'github'])
  assert.ok(round.network.every((entry) => entry.outcome === 'pending'))
  assert.equal(await js('Boolean(document.querySelector(".checking-row"))'), false)

  phase = round.kind + ':manual-intent'
  await clickVisible('.titlebar-btn-settings[title="设置"]')
  await until(
    () => js('Boolean(document.querySelector(".settings-panel.active"))'),
    round.kind + ': real settings opened'
  )
  await until(
    () =>
      js(`(()=>{
        const buttons=document.querySelectorAll('.settings-panel.active [data-settings-category="system"] button');
        const target=[...buttons].find(button=>button.textContent.trim()==='检查更新');
        target?.setAttribute('data-update-intent-check','');return Boolean(target);
      })()`),
    'actual settings update button found'
  )
  const title = round.kind === 'current' ? '已经是最新版本' : '暂时无法连接更新服务'
  await js(`(()=>{
    const probe=window.__updateIntentProbe={clickedAt:null,checkingAt:null,resultAt:null,records:[]};
    const inspect=()=>{
      if(probe.clickedAt===null)return;
      const checking=document.querySelector('.app-modal-card[aria-label="正在检查更新"] .checking-row');
      if(checking && probe.checkingAt===null){probe.checkingAt=performance.now();probe.records.push({event:'checking',time:probe.checkingAt})}
      const dialog=document.querySelector(${JSON.stringify('.app-modal-card[aria-label="' + title + '"]')});
      if(dialog?.querySelector('.update-summary') && !dialog.querySelector('.checking-row') && probe.resultAt===null){
        probe.resultAt=performance.now();probe.records.push({event:'result',time:probe.resultAt});
      }
    };
    probe.observer=new MutationObserver(inspect);
    probe.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  })()`)
  // Settings intentionally makes the underlying app-scene inert. The control's
  // own hit test above, rather than scene inertness, owns this click precondition.
  await clickVisible('[data-update-intent-check]', true)
  await until(
    () =>
      js(
        'Boolean(document.querySelector(\'.app-modal-card[aria-label="正在检查更新"] .checking-row\'))'
      ),
    round.kind + ': manual intent immediately displays the real checking dialog'
  )
  assert.equal(round.ipc.length, 1, 'manual settings click reused the silent renderer request')
  assert.equal(round.network.length, 2, 'manual intent did not start either endpoint again')
  assert.ok(round.network.every((entry) => entry.outcome === 'pending'))

  phase = round.kind + ':preload-join'
  await js(`(()=>{
    window.__updateIntentConcurrent=window.api.checkForUpdate().then(result=>{
      window.__updateIntentConcurrentResult=result;return result;
    }).catch(error=>{window.__updateIntentConcurrentError=String(error);return null});
    return true;
  })()`)
  await until(
    () => round.ipc.length === 2,
    'separately counted original-preload call joined main check'
  )
  assert.equal(round.network.length, 2, 'preload join reused the same main two-endpoint operation')
  assert.equal(round.ipc[1].completedAt, null, 'concurrent preload response remains withheld')
  round.visualReady = {
    checking: await waitForVisualReady('正在检查更新', [
      '.checking-copy strong',
      '.checking-copy span'
    ])
  }
  await capture(round.kind + '-checking')

  phase = round.kind + ':release'
  round.releasedAt = Date.now()
  round.network.forEach((entry) => entry.release())
  await until(
    () => round.ipc.every((entry) => entry.completedAt !== null),
    round.kind + ': real update service completed both IPC callers'
  )
  assert.equal(round.ipc[0].result.status, round.kind)
  assert.strictEqual(
    round.ipc[0].result,
    round.ipc[1].result,
    'main callers share one actual result'
  )
  if (round.kind === 'current') {
    assert.match(round.ipc[0].result.checkId, /^[\da-f-]{36}$/i)
    assert.equal(round.ipc[0].result.checkId, round.ipc[1].result.checkId)
  }
  assert.ok(
    round.network.every(
      (entry) =>
        entry.outcome === (round.kind === 'current' ? 'same-version-json' : 'controlled-offline')
    ),
    'both endpoints settled through the intended fixture boundary without timeout'
  )
  await until(
    () =>
      js(`(()=>{
        const probe=window.__updateIntentProbe;
        const dialog=document.querySelector(${JSON.stringify('.app-modal-card[aria-label="' + title + '"]')});
        return Boolean(probe.resultAt!==null && dialog?.querySelector('.update-summary') && !dialog.querySelector('.checking-row'));
      })()`),
    round.kind + ': joined silent result is displayed in the real update dialog'
  )
  round.probe = await js(`(()=>{
    const {clickedAt,checkingAt,resultAt,records}=window.__updateIntentProbe;
    return {clickedAt,checkingAt,resultAt,records,summary:document.querySelector('.update-summary')?.textContent.trim(),
      concurrentResult:window.__updateIntentConcurrentResult,concurrentError:window.__updateIntentConcurrentError||null};
  })()`)
  assert.equal(round.probe.concurrentError, null)
  assert.deepEqual(round.probe.concurrentResult, round.ipc[0].result)
  assert.ok(
    round.probe.checkingAt >= round.probe.clickedAt,
    'checking appeared after the actual button click'
  )
  assert.ok(
    round.probe.resultAt - round.probe.clickedAt >= 500,
    'list kept checking for at least 500ms after manual intent'
  )
  if (round.kind === 'current') assert.ok(round.probe.summary.includes('v' + app.getVersion()))
  else {
    assert.match(round.probe.summary, /暂时无法连接更新服务/)
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll(${JSON.stringify('.app-modal-card[aria-label="' + title + '"] button')})).some(button=>button.textContent.trim()==='重新检查' && !button.disabled)`
      ),
      true,
      'real error dialog offers retry'
    )
  }
  assert.equal(round.ipc.length, 2, 'only startup and the explicitly counted preload IPC were sent')
  assert.equal(round.network.length, 2, 'the whole round retained exactly two endpoint requests')
  round.visualReady.result = await waitForVisualReady(title, ['.update-summary'])
  await capture(round.kind + '-result')
  await js('window.__updateIntentProbe.observer.disconnect()')
  round.phase = 'complete'
  round.completedAt = Date.now()
}

function summary() {
  return {
    phase,
    controlledBoundary:
      'two precise release endpoints; original preload and actual App/settings/UpdateDialog',
    excluded: 'public network, download/install, OS pointer input and calendar policy',
    navigations,
    rounds: rounds.map((round) => ({
      ...round,
      network: round.network.map((entry) => ({
        url: entry.url,
        source: entry.source,
        requestedAt: entry.requestedAt,
        settledAt: entry.settledAt,
        outcome: entry.outcome
      })),
      ipc: round.ipc.map((entry) => ({
        origin: entry.origin,
        requestedAt: entry.requestedAt,
        completedAt: entry.completedAt,
        result: entry.result
      }))
    })),
    unexpectedNetwork,
    externalAttempts,
    rendererErrors,
    screenshots
  }
}

async function cleanupFixtures() {
  for (const round of rounds) for (const entry of round.network) entry.cancel()
  await Promise.allSettled(rounds.flatMap((round) => round.ipc.map((entry) => entry.task)))
  if (current && !current.isDestroyed())
    await js('window.__updateIntentProbe?.observer.disconnect()')
}

async function run() {
  try {
    await until(
      () => installed && current,
      'owned production index navigation installed test boundary'
    )
    await verifyRound(activeRound)
    newRound('error')
    phase = 'error:reload'
    const reloaded = new Promise((done) => current.webContents.once('did-finish-load', done))
    current.reload()
    await bounded(reloaded, 'second real App document finished loading', 10000)
    await until(() => navigations.length === 2, 'second real App document began loading')
    await verifyRound(activeRound)
    phase = 'complete'
    assert.equal(navigations.length, 2)
    assert.equal(rounds.flatMap((round) => round.network).length, 4)
    assert.deepEqual(unexpectedNetwork, [], 'no request escaped the controlled transport')
    assert.deepEqual(externalAttempts, [], 'no external link or download was requested')
    writeFileSync(
      join(evidenceRoot, 'update-intent-timing.json'),
      JSON.stringify(summary(), null, 2),
      {
        flag: 'wx'
      }
    )
    await lifecycle.finish({
      completed: true,
      window: current,
      summary: summary(),
      restore: cleanupFixtures
    })
  } catch (error) {
    writeFileSync(
      join(evidenceRoot, 'update-intent-first-failure.json'),
      JSON.stringify({ error: error?.stack || String(error), ...summary() }, null, 2),
      { flag: 'wx' }
    )
    try {
      if (current && !current.isDestroyed()) await capture('first-failure')
    } catch (captureError) {
      writeFileSync(
        join(evidenceRoot, 'first-failure-capture-error.txt'),
        String(captureError?.stack || captureError),
        { flag: 'wx' }
      )
    }
    console.error(error)
    await lifecycle.finish({ error, window: current, summary: summary(), restore: cleanupFixtures })
  }
}

try {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  app.setPath('userData', profile)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  newRound('current')
  service = new AppUpdateService({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    checkEnabled: true,
    fetchImpl: controlledFetch
  })
  globalThis.fetch = async (input) => {
    const url = String(input)
    unexpectedNetwork.push({ url, time: Date.now(), phase, boundary: 'main-global-fetch' })
    throw new Error('Public network is disabled for update-intent test: ' + url)
  }
  shell.openExternal = async (url) => {
    externalAttempts.push({ url, time: Date.now(), boundary: 'shell.openExternal' })
    throw new Error('External links are disabled for update-intent test')
  }
  app.on('web-contents-created', installFixture)
  app.once('will-quit', () => {
    app.removeListener('web-contents-created', installFixture)
    globalThis.fetch = originalFetch
    shell.openExternal = originalOpenExternal
  })
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'built main-process chunk is present')
  require(resolve('out/main/chunks', chunk))
  if (app.isReady()) void run()
  else app.once('ready', () => void run())
} catch (error) {
  console.error(error)
  void lifecycle.finish({ error, window: current, summary: summary(), restore: cleanupFixtures })
}
