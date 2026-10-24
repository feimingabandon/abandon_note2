import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, nativeImage } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'

// The three deliberate waits total 66 seconds: 5s sent, 30s processing and
// 31s in a real user confirmation. This is the initial suite budget, not a retry.
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/capture-delivery-electron.mjs',
  mode: 'electron-ready-real-app-capture-delivery',
  prefix: 'abandon-capture-delivery-',
  timeoutMs: 90000,
  destroyWindowsBeforeQuit: false,
  metadata: {
    actualApplication: true,
    realWindow: true,
    realDatabase: true,
    realPreload: true,
    transport: 'synthetic-image-output',
    productDeliveryDeadlines: true,
    actualDraftConfirmation: true,
    waitingNavigation: 'product-request-safe-refusal-and-controlled-same-view-reload',
    limits: [
      'Synthetic host transport does not assert Qt overlay, physical input or clipboard',
      'The existing Qt final boolean ACK protocol is unchanged',
      'No installation, process restart, customer-machine or mixed-DPI proof'
    ]
  }
})
const { assert, root } = lifecycle
const trace = []
const hostMessages = []
const snapshots = []
const frames = []
const fixtureObservations = []
const scenarios = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const captureModal = '.app-modal-card[aria-label="截图新建便签"]'
const draftConfirmation = '.confirm-card.active[aria-label="保留草稿后继续？"]'
let current
let coordinator
let originalHost
let originalProgress
let originalAck
let cleanupTimer
let cleanupReadPending = false
let restoration = null
let fixturePaint = null

async function until(read, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) {
      assert.ok(true, message)
      return value
    }
    await wait(25)
  }
  assert.fail(message)
}
const js = (source) => current.webContents.executeJavaScript(source)
const identity = ({ sessionId, deliveryId }) => ({ sessionId, deliveryId })
const snapshot = (label) => {
  const value = coordinator.deliverySnapshot()
  snapshots.push({ label, at: Date.now(), value })
  // The lifecycle's global deadline may finish before run's summary is saved.
  // Existing immutable stdout must still identify the last completed phase.
  console.log('[capture-delivery-phase]', label, JSON.stringify(value))
  return value
}
const captureJournals = () =>
  js(`Object.keys(localStorage)
  .filter(key=>key.startsWith('abandon:editing-draft:') &&
    (key.endsWith(':capture:pending-delivery')||key.endsWith(':new:capture')))
  .map(key=>{const value=JSON.parse(localStorage.getItem(key));return {
    key,version:value.version,owner:value.owner,
    pendingAsset:value.data?.pendingAsset||null,
    addedImages:value.data?.attachments?.addedImages||[],
    captureReceipts:value.data?.captureReceipts||[]
  }})`)
const ackFor = (delivery) =>
  hostMessages.find(
    (message) =>
      message.type === 'ack' &&
      message.sessionId === delivery.sessionId &&
      message.deliveryId === delivery.deliveryId
  )
function assertReleased(value, reason) {
  assert.equal(value.state, 'rejected')
  assert.equal(value.reason, reason)
  assert.equal(value.timerActive, false)
  assert.equal(value.observingReceiver, false)
  assert.equal(value.deadlineAt, null)
}
async function clickExposed(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
  await until(
    () =>
      js(`(() => {
        const element=document.querySelector(${JSON.stringify(selector)});
        if(!element || element.disabled || element.closest('[inert]'))return false;
        const r=element.getBoundingClientRect();
        return r.width>0 && r.height>0 &&
          element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      })()`),
    'actual control is exposed: ' + selector
  )
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function clickConfirmation(text) {
  const selected = await js(`(() => {
    const dialog=document.querySelector('.confirm-card.active');
    const button=Array.from(dialog?.querySelectorAll('button')||[])
      .find(node=>node.textContent.trim()===${JSON.stringify(text)});
    if(!button || button.disabled || button.closest('[inert]'))return false;
    const r=button.getBoundingClientRect();
    if(r.width<=0 || r.height<=0 || !button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))return false;
    button.click();return true;
  })()`)
  assert.equal(selected, true, 'actual confirmation button exposed: ' + text)
}
async function stableVisual(name, selector) {
  return until(
    () =>
      js(`(() => {
        const element=document.querySelector(${JSON.stringify(selector)});
        if(!element || document.visibilityState!=='visible')return false;
        let node=element;
        while(node instanceof Element){
          const style=getComputedStyle(node);
          if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<0.999)return false;
          if(node.getAnimations().some(animation=>
            animation.playState==='running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)))return false;
          node=node.parentElement;
        }
        if(element.getAnimations({subtree:true}).some(animation=>
          animation.playState==='running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)))return false;
        const r=element.getBoundingClientRect();
        return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight?
          {visibility:document.visibilityState,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:false;
      })()`),
    'stable actual scene for ' + name
  )
}
async function captureFrame(name, selector) {
  const visual = await stableVisual(name, selector)
  const png = (await current.webContents.capturePage()).toPNG()
  writeFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, name), png, { flag: 'wx' })
  frames.push({ file: name, sha256: createHash('sha256').update(png).digest('hex'), visual })
}
function recoveryFixtureStyle(variant) {
  return `:root{--bg-color:${variant.bg}!important;--text-color:${variant.text}!important;}
    /* Test-owned backdrop covers page text while remaining below the real recovery card. */
    #capture-recovery-fixture-backdrop{position:fixed;inset:0;z-index:var(--z-global-presence);pointer-events:none;background:${variant.backdrop}!important;}
    /* Test-only drawing marker verifies a new compositor generation outside the recovery card. */
    #capture-recovery-paint-marker{position:fixed;left:8px;top:160px;width:4px;height:4px;pointer-events:none;z-index:var(--z-global-critical);background:rgb(${variant.marker} ${variant.marker} ${variant.marker})!important;}`
}
const recoveryFixtureState = (selector) =>
  js(`(() => {
  const describe=element=>{
    if(!element)return null;
    const style=getComputedStyle(element),r=element.getBoundingClientRect();
    return {tag:element.tagName,id:element.id,class:String(element.className),text:element.textContent?.trim().slice(0,100),
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},background:style.background,backgroundColor:style.backgroundColor,
      color:style.color,opacity:style.opacity,position:style.position,zIndex:style.zIndex,pointerEvents:style.pointerEvents,
      bgToken:style.getPropertyValue('--bg-color').trim(),textToken:style.getPropertyValue('--text-color').trim()};
  };
  const point={x:Math.floor(innerWidth*0.05),y:Math.floor(innerHeight*0.2)};
  const element=document.elementFromPoint(point.x,point.y),button=document.querySelector(${JSON.stringify(selector)});
  const r=button?.getBoundingClientRect(),ancestors=[];
  for(let node=element;node;node=node.parentElement)ancestors.push(describe(node));
  return {visibility:document.visibilityState,point,pointElement:describe(element),ancestors,
    pointTextCandidates:Array.from(document.querySelectorAll('.month-day-cell__number,.month-day-cell__lunar'))
      .filter(node=>{const r=node.getBoundingClientRect();return point.x>=r.x&&point.x<r.right&&point.y>=r.y&&point.y<r.bottom;})
      .map(describe),
    roots:['html','body','.month-root','.window-presentation','.window-presentation__expanded','.month-scene',
      '#capture-recovery-fixture-backdrop','.capture-recovery-entry','#capture-recovery-paint-marker']
      .map(selector=>({selector,element:describe(document.querySelector(selector))})),
    button:describe(button),buttonEnabled:Boolean(button&&!button.disabled&&!button.closest('[inert]')),
    buttonHit:Boolean(button&&r&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))};
})()`)
async function recoveryReadingSurfaces(selector) {
  try {
    for (const variant of [
      { name: 'white', bg: '255 255 255', text: '#1d1d1f', backdrop: '#fff', marker: 43 },
      { name: 'black', bg: '0 0 0', text: '#f5f5f7', backdrop: '#000', marker: 83 },
      {
        name: 'complex',
        bg: '255 255 255',
        text: '#1d1d1f',
        marker: 123,
        backdrop: 'repeating-conic-gradient(#063b72 0% 25%, #f7c957 0% 50%) 0 0 / 80px 80px'
      }
    ]) {
      const style = recoveryFixtureStyle(variant)
      await js(`(() => {
        document.getElementById('capture-recovery-visual')?.remove();
        document.getElementById('capture-recovery-paint-marker')?.remove();
        document.getElementById('capture-recovery-fixture-backdrop')?.remove();
        const style=document.createElement('style');style.id='capture-recovery-visual';
        style.textContent=${JSON.stringify(style)};document.head.append(style);
        const backdrop=document.createElement('div');backdrop.id='capture-recovery-fixture-backdrop';
        document.body.append(backdrop);
      })()`)
      const visual = await stableVisual('recovery-' + variant.name, selector)
      fixturePaint = waitForFixtureFrame({
        webContents: current.webContents,
        name: 'capture-recovery-' + variant.name,
        marker: [variant.marker, variant.marker, variant.marker],
        palette: variant.name,
        viewport: await js('({width:innerWidth,height:innerHeight})')
      })
      const paint = fixturePaint
      const observation = { variant: variant.name, visual, frameTrace: paint.trace }
      let diagnosticFailure = null
      fixtureObservations.push(observation)
      try {
        observation.domBeforeMarker = await recoveryFixtureState(selector)
        await js(`(() => {
          const marker=document.createElement('div');marker.id='capture-recovery-paint-marker';
          document.body.append(marker);
        })()`)
        const presented = await paint.ready
        const metrics = await js(`(() => {
          const button=document.querySelector(${JSON.stringify(selector)});
          const r=button.getBoundingClientRect();
          const surface=button.closest('.capture-recovery-entry');
          const reading=surface?.getBoundingClientRect();
          return {
            label:button.textContent.trim(),enabled:!button.disabled,inert:Boolean(button.closest('[inert]')),
            rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},
            hit:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
            bgToken:getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim(),
            reading:reading?{x:reading.x,y:reading.y,width:reading.width,height:reading.height}:null,
            readingRole:surface?.getAttribute('role'),readingLabel:surface?.getAttribute('aria-label'),
            surfaceBackground:surface?getComputedStyle(surface).backgroundColor:null,
            textColor:getComputedStyle(button).color
          };
        })()`)
        observation.metrics = metrics
        assert.equal(paint.trace.cleanupError, undefined)
        assert.equal(metrics.label, '恢复暂存截图')
        assert.equal(metrics.enabled, true)
        assert.equal(metrics.inert, false)
        assert.equal(
          metrics.hit,
          true,
          variant.name + ' recovery control has an unoccluded real hit target'
        )
        assert.equal(metrics.bgToken, variant.bg)
        assert.ok(metrics.rect.x >= 0 && metrics.rect.y >= 0)
        assert.ok(metrics.rect.x + metrics.rect.width <= metrics.viewport.width)
        assert.ok(metrics.rect.y + metrics.rect.height <= metrics.viewport.height)
        assert.equal(metrics.readingRole, 'region')
        assert.equal(metrics.readingLabel, '暂存截图恢复')
        assert.ok(metrics.reading.x >= 0 && metrics.reading.y >= 0)
        assert.ok(metrics.reading.x + metrics.reading.width <= metrics.viewport.width)
        assert.ok(metrics.reading.y + metrics.reading.height <= metrics.viewport.height)
        assert.ok(metrics.surfaceBackground, 'recovery control uses a real reading surface')
        assert.notEqual(metrics.surfaceBackground, 'rgba(0, 0, 0, 0)')
        const file = 'capture-delivery-recovery-' + variant.name + '.png'
        const png = presented.toPNG()
        writeFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, file), png, {
          flag: 'wx'
        })
        frames.push({
          file,
          sha256: createHash('sha256').update(png).digest('hex'),
          visual,
          metrics,
          frameTrace: paint.trace
        })
      } catch (error) {
        observation.error = error.stack || error.message
        try {
          observation.domFailure = await recoveryFixtureState(selector)
        } catch (diagnosticError) {
          observation.domFailureError = diagnosticError.stack || diagnosticError.message
        }
        throw error
      } finally {
        paint.close()
        fixturePaint = null
        try {
          writeFileSync(
            join(
              process.env.ABANDON_TEST_EVIDENCE_DIR || root,
              'capture-recovery-' + variant.name + '-diagnostic.json'
            ),
            JSON.stringify(observation, null, 2),
            { flag: 'wx' }
          )
        } catch (evidenceError) {
          diagnosticFailure = evidenceError
          if (observation.error)
            console.error('Recovery fixture failure diagnostic could not be saved:', evidenceError)
        }
      }
      if (diagnosticFailure) throw diagnosticFailure
    }
  } finally {
    await js(
      "document.getElementById('capture-recovery-visual')?.remove();document.getElementById('capture-recovery-paint-marker')?.remove();document.getElementById('capture-recovery-fixture-backdrop')?.remove();true"
    )
  }
}
function seedSettings() {
  const db = new Database(join(root, 'app.db'))
  try {
    db.exec(`CREATE TABLE app_settings (
      window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,value TEXT,
      remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`)
    const insert = db.prepare(
      'INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['application', 'system', 'z_order_mode', 'normal'],
      ...['screenshot', 'screenshot_copy', 'clipboard_pin', 'toggle_pins', 'view_visibility'].map(
        (key) => ['application', 'shortcuts', key, '']
      ),
      ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
    ])
      insert.run(...row)
  } finally {
    db.close()
  }
}
async function output(action) {
  assert.ok(coordinator.active, 'synthetic PNG belongs to an active actual coordinator session')
  const sessionId = coordinator.active.id
  const deliveryId = randomUUID()
  const png = nativeImage
    .createFromBitmap(Buffer.alloc(20 * 30 * 4, 220), { width: 20, height: 30 })
    .toPNG()
  writeFileSync(join(coordinator.assets.root, sessionId, deliveryId + '.png'), png, { flag: 'wx' })
  await coordinator.message({ type: 'output', sessionId, deliveryId, action })
  return { sessionId, deliveryId }
}
async function start(options) {
  const result = await coordinator.capture(options)
  assert.equal(result.status, 'started')
  return result.sessionId
}
function observeAndReplaceHost() {
  originalHost = coordinator.host
  coordinator.host = {
    ready: true,
    pid: 0,
    start: async () => {},
    dispose: () => originalHost.dispose(),
    send(message) {
      hostMessages.push({ ...message, at: Date.now() })
      if (message.type === 'capture' && message.sessionId)
        queueMicrotask(() => {
          void coordinator
            .message({ type: 'captureReady', sessionId: message.sessionId })
            .catch((error) => trace.push({ hostError: error.stack || error.message }))
        })
      if ((message.type === 'ack' && message.accepted) || message.type === 'cancel')
        queueMicrotask(() => {
          void coordinator
            .message({
              type: 'finished',
              sessionId: message.sessionId,
              status: message.type === 'ack' ? 'delivered' : 'cancelled'
            })
            .catch((error) => trace.push({ hostError: error.stack || error.message }))
        })
    }
  }
  originalProgress = coordinator.progress
  coordinator.progress = function (sender, data, frame) {
    const result = Reflect.apply(originalProgress, this, [sender, data, frame])
    trace.push({ type: 'progress', ...identity(data), state: data.state, result, at: Date.now() })
    return result
  }
  originalAck = coordinator.ack
  coordinator.ack = function (sender, data, frame) {
    const result = Reflect.apply(originalAck, this, [sender, data, frame])
    trace.push({ type: 'ack', ...identity(data), accepted: data.accepted, result, at: Date.now() })
    return result
  }
}
function restore() {
  if (restoration) return restoration
  restoration = (async () => {
    coordinator?.cancel()
    fixturePaint?.close()
    fixturePaint = null
    if (current && !current.isDestroyed()) {
      await js(
        "window.__captureDeliveryProbe?.stop();window.__captureNavigationProbe?.stop();delete window.__captureNavigationProbe;document.getElementById('capture-recovery-visual')?.remove();document.getElementById('capture-recovery-paint-marker')?.remove();document.getElementById('capture-recovery-fixture-backdrop')?.remove();true"
      ).catch((error) => {
        trace.push({ cleanup: 'probe-unsubscribe', error: error.message })
      })
    }
    if (originalProgress) coordinator.progress = originalProgress
    if (originalAck) coordinator.ack = originalAck
    if (originalHost) coordinator.host = originalHost
    // A failed scenario may still own a real dirty test draft. Keep its journal
    // and accept only the product's ordinary quit confirmation during cleanup.
    cleanupTimer = setInterval(() => {
      if (cleanupReadPending || !current || current.isDestroyed()) return
      cleanupReadPending = true
      void js(`(() => {
        const dialog=document.querySelector(${JSON.stringify(draftConfirmation)});
        const button=Array.from(dialog?.querySelectorAll('button')||[])
          .find(node=>node.textContent.trim()==='保留并退出');
        if(!button || button.disabled)return false;
        button.click();return true;
      })()`)
        .then((clicked) => {
          if (clicked) trace.push({ cleanup: 'ordinary-quit-confirmation', at: Date.now() })
        })
        .catch((error) => trace.push({ cleanup: 'quit-query', error: error.message }))
        .finally(() => {
          cleanupReadPending = false
        })
    }, 50)
  })()
  return restoration
}
// The lifecycle's own initial deadline can call finish before run's finally.
// It still reaches this same cleanup before the product's normal quit guards.
app.once('before-quit', () => {
  void restore().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
})
app.once('quit', () => clearInterval(cleanupTimer))

async function run() {
  let completed = false
  let failure = null
  const summary = {}
  try {
    current = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual list application loaded'
    )
    await until(() => current.isVisible(), 'actual list application visible')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    await until(
      () => hooks.nativeCaptureState().ready,
      'owned capture helper ready before transport fixture'
    )
    await dismissStartupShortcutNotice(current)
    await until(() => js("!document.querySelector('.app-scene').inert"), 'actual scene interactive')
    coordinator = hooks.captureCoordinator()
    assert.equal(typeof coordinator.deliverySnapshot, 'function')
    assert.deepEqual(
      await js(
        '({progress:typeof window.api.reportScreenshotDelivery,state:typeof window.api.onScreenshotDeliveryState})'
      ),
      { progress: 'function', state: 'function' }
    )
    observeAndReplaceHost()
    const sender = current.webContents
    const sourceFrame = sender.mainFrame

    // No source consumer is registered for this token. send() really reaches
    // preload, but an alive document does not imply that anyone received it.
    const sourceSession = await start({ sender, token: 'delivery-probe-source', origin: 'note' })
    const lost = await output('source')
    const sent = snapshot('unreceived-sent')
    assert.equal(sent.state, 'sent')
    assert.equal(sent.timerActive, true)
    assert.ok(sent.remainingMs > 0 && sent.remainingMs <= 5000)
    await until(
      () => ackFor(lost),
      'default sent deadline restored the synthetic native selection',
      7000
    )
    assert.equal(ackFor(lost).accepted, false)
    assertReleased(snapshot('unreceived-rejected'), 'sent-timeout')
    assert.equal(coordinator.active.id, sourceSession)
    assert.equal(coordinator.active.delivery, null)
    scenarios.push(
      'alive receiver without received times out at the product sent boundary and retains a usable capture session'
    )

    await js(`(() => {
      const probe={deliveries:[],states:[],resumed:[],releases:[]};
      const stopState=window.api.onScreenshotDeliveryState(state=>{
        probe.states.push(state);
        if(state.state==='rejected'){
          for(const release of probe.releases.splice(0))release();
        }
      });
      const stopDelivery=window.api.onScreenshotDelivery(async delivery=>{
        if(delivery.action!=='source'||delivery.token!=='delivery-probe-source')return;
        probe.deliveries.push({sessionId:delivery.sessionId,deliveryId:delivery.deliveryId});
        const ids={sessionId:delivery.sessionId,deliveryId:delivery.deliveryId};
        const received=await window.api.reportScreenshotDelivery({...ids,state:'received'});
        const processing=await window.api.reportScreenshotDelivery({...ids,state:'processing'});
        probe.progress={received,processing};
        await new Promise(resolve=>probe.releases.push(resolve));
        probe.resumed.push(ids);
      });
      probe.stop=()=>{stopDelivery();stopState();for(const release of probe.releases.splice(0))release();};
      window.__captureDeliveryProbe=probe;
    })()`)
    const hung = await output('source')
    await until(
      () => coordinator.deliverySnapshot().state === 'processing',
      'actual preload consumer entered processing'
    )
    const processing = snapshot('processing-started')
    assert.ok(processing.processingRemainingMs > 0 && processing.processingRemainingMs <= 30000)
    assert.equal(coordinator.progress(sender, { ...lost, state: 'received' }, sourceFrame), false)
    assert.equal(coordinator.ack(sender, { ...lost, accepted: true }, sourceFrame), false)
    assert.equal(coordinator.progress(sender, { ...hung, state: 'received' }, sourceFrame), false)
    assert.equal(coordinator.progress(sender, { ...hung, state: 'processing' }, {}), false)
    assert.equal(coordinator.ack(sender, { ...hung, accepted: true }, {}), false)
    assert.equal(
      await js(
        `window.api.reportScreenshotDelivery(${JSON.stringify({ ...hung, state: 'processing' })})`
      ),
      false
    )
    assert.equal(coordinator.deliverySnapshot().deadlineAt, processing.deadlineAt)
    await until(
      () => ackFor(hung),
      'default cumulative processing deadline restored native selection',
      32000
    )
    assert.equal(ackFor(hung).accepted, false)
    assertReleased(snapshot('processing-rejected'), 'processing-timeout')
    assert.equal(coordinator.active.id, sourceSession)
    await until(
      () => js('window.__captureDeliveryProbe.resumed.length===1'),
      'terminal notification released the test-owned pending callback'
    )
    summary.processingProbe = await js(`({
      deliveries:window.__captureDeliveryProbe.deliveries,
      states:window.__captureDeliveryProbe.states,
      progress:window.__captureDeliveryProbe.progress,
      resumed:window.__captureDeliveryProbe.resumed
    })`)
    assert.deepEqual(summary.processingProbe.progress, { received: true, processing: true })
    await js('window.__captureDeliveryProbe.stop();true')
    coordinator.cancel()
    assert.equal(coordinator.active, null)
    scenarios.push(
      'received processing that never finishes expires without duplicate/old/frame-invalid progress renewing its budget'
    )

    await until(
      () => js("Boolean(document.querySelector('.nnp-root textarea'))"),
      'real list draft textarea available'
    )
    await js(`(() => {
      const textarea=document.querySelector('.nnp-root textarea');
      textarea.value='E7.2 preserves the original list draft';
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>state.dirty&&!state.blocked)'),
      'actual list draft is safely dirty before global delivery'
    )
    const waitingSession = await start()
    const waiting = await output('note')
    await until(
      () => coordinator.deliverySnapshot().state === 'awaiting-user',
      'real CaptureDelivery entered its actual user confirmation'
    )
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      'real draft confirmation is mounted'
    )
    const waitingBefore = snapshot('awaiting-user-started')
    assert.equal(waitingBefore.timerActive, false)
    assert.equal(waitingBefore.deadlineAt, null)
    await captureFrame('capture-delivery-awaiting-user.png', draftConfirmation)
    const userWaitStarted = Date.now()
    await wait(31000)
    assert.ok(Date.now() - userWaitStarted >= 30000)
    assert.equal(coordinator.active.id, waitingSession)
    assert.equal(coordinator.active.delivery, waiting.deliveryId)
    const waitingAfter = snapshot('awaiting-user-after-processing-budget')
    assert.equal(waitingAfter.state, 'awaiting-user')
    assert.equal(waitingAfter.processingRemainingMs, waitingBefore.processingRemainingMs)
    assert.equal(waitingAfter.timerActive, false)
    assert.equal(ackFor(waiting), undefined)
    coordinator.cancel()
    assertReleased(snapshot('cancelled-awaiting-user'), 'cancelled')
    await until(
      () => js(`!document.querySelector(${JSON.stringify(draftConfirmation)})`),
      'only the cancelled capture confirmation finished leaving'
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(captureModal)}))`),
      false
    )
    assert.equal(
      await js("document.querySelector('.nnp-root textarea').value"),
      'E7.2 preserves the original list draft'
    )
    assert.equal(
      coordinator.progress(sender, { ...waiting, state: 'processing' }, sourceFrame),
      false
    )
    assert.equal(coordinator.ack(sender, { ...waiting, accepted: true }, sourceFrame), false)
    scenarios.push(
      'real user confirmation survives the product processing budget; cancellation invalidates its continuation and preserves the original dirty form'
    )

    // Keep cancellation above independent. First exercise an actual product
    // navigation request while another owner still holds the capture dialog.
    const navigationSession = await start()
    const navigatingDelivery = await output('note')
    await until(
      () => coordinator.deliverySnapshot().state === 'awaiting-user',
      'the independent navigation case is still waiting for actual user confirmation'
    )
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      'the capture-owned confirmation is mounted before requesting navigation'
    )
    const navigationFrame = sender.mainFrame
    const navigationUrl = sender.getURL()
    const navigationCase = {
      delivery: navigatingDelivery,
      before: snapshot('awaiting-user-before-product-navigation'),
      sourceBefore: await js('window.api.getSettingsSnapshot().then(value=>value.source)')
    }
    summary.navigationAwaitingUser = navigationCase
    await js(`(() => {
      const probe={finished:0};
      probe.stop=window.api.onMainViewSwitchFinished(()=>probe.finished++);
      window.__captureNavigationProbe=probe;
      return true;
    })()`)
    navigationCase.requestAccepted = await js("window.api.switchMainView('month')")
    assert.equal(
      navigationCase.requestAccepted,
      true,
      'the IPC only acknowledges the queued request'
    )
    await until(
      () => js('window.__captureNavigationProbe.finished===1'),
      'the actual queued navigation completed its negotiation'
    )
    await js('window.__captureNavigationProbe.stop();delete window.__captureNavigationProbe;true')
    assert.equal(sender.getURL(), navigationUrl)
    assert.equal(sender.mainFrame, navigationFrame)
    assert.equal(hooks.navigationState().mode, 'list')
    assert.equal(hooks.navigationState().switching, false)
    navigationCase.afterRequest = snapshot('awaiting-user-product-navigation-safely-refused')
    assert.equal(navigationCase.afterRequest.state, 'awaiting-user')
    assert.equal(navigationCase.afterRequest.sessionId, navigationSession)
    assert.equal(navigationCase.afterRequest.deliveryId, navigatingDelivery.deliveryId)
    assert.equal(navigationCase.afterRequest.timerActive, false)
    assert.equal(navigationCase.afterRequest.deadlineAt, null)
    assert.equal(navigationCase.afterRequest.observingReceiver, true)
    assert.equal(ackFor(navigatingDelivery), undefined)
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      true
    )
    scenarios.push(
      'a real view-switch request cannot borrow the capture-owned confirmation; its queued reply is not a successful cross-view navigation'
    )

    // This is an explicitly controlled same-view document reload, using the
    // existing reload fixture protocol, not a successful cross-view switch.
    // No capture cancel or confirmation is issued before the real navigation.
    let navigationReloaded = false
    const onNavigationReloaded = () => {
      navigationReloaded = true
    }
    sender.once('did-finish-load', onNavigationReloaded)
    try {
      sender.reload()
      await until(
        () => navigationReloaded,
        'controlled same-view reload replaced the waiting document'
      )
    } finally {
      sender.removeListener('did-finish-load', onNavigationReloaded)
    }
    await until(
      () =>
        js(
          "typeof window.api?.getSettingsSnapshot==='function' && Boolean(document.querySelector('.nnp-root textarea'))"
        ),
      'the reloaded list document initialized its real receiver and draft form'
    )
    navigationCase.sourceAfterReload = await js(
      'window.api.getSettingsSnapshot().then(value=>value.source)'
    )
    assert.notEqual(navigationCase.sourceAfterReload.token, navigationCase.sourceBefore.token)
    assert.equal(navigationCase.sourceAfterReload.scope, navigationCase.sourceBefore.scope)
    // A document epoch changes even if Chromium reuses a frame-host object.
    navigationCase.frameObjectReusedAfterReload = sender.mainFrame === navigationFrame
    navigationCase.afterReload = snapshot('awaiting-user-document-invalid-after-controlled-reload')
    assertReleased(navigationCase.afterReload, 'document-invalid')
    assert.equal(ackFor(navigatingDelivery).accepted, false)
    assert.equal(coordinator.active.id, navigationSession)
    assert.equal(coordinator.active.delivery, null)
    assert.equal(
      coordinator.progress(sender, { ...navigatingDelivery, state: 'processing' }, navigationFrame),
      false
    )
    assert.equal(
      coordinator.ack(sender, { ...navigatingDelivery, accepted: true }, navigationFrame),
      false
    )
    await until(
      () =>
        js(
          "document.querySelector('.nnp-root textarea')?.value==='E7.2 preserves the original list draft'"
        ),
      'the original ordinary draft survived the document reload'
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(captureModal)}))`),
      false
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      false
    )
    assert.equal(
      (await captureJournals()).some(
        (journal) => journal.pendingAsset?.deliveryId === navigatingDelivery.deliveryId
      ),
      false,
      'a screenshot that never obtained confirmation acquired no renderer pending-asset ownership'
    )
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>state.dirty&&!state.blocked)'),
      'the reloaded ordinary draft is safely ready for the next delivery'
    )

    const nextDelivery = await output('note')
    navigationCase.nextDelivery = nextDelivery
    assert.equal(nextDelivery.sessionId, navigationSession)
    assert.notEqual(nextDelivery.deliveryId, navigatingDelivery.deliveryId)
    await until(
      () => coordinator.deliverySnapshot().state === 'awaiting-user',
      'a new delivery uses a fresh confirmation in the actual replacement document'
    )
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      'the new delivery owns its own actual confirmation'
    )
    await clickConfirmation('保留并切换')
    await until(
      () =>
        js(`document.querySelectorAll(${JSON.stringify(captureModal + ' .ip-thumb')}).length===1`),
      'the next delivery reached one real thumbnail after navigation invalidated the previous receiver'
    )
    await until(
      () => !coordinator.active,
      'the accepted next delivery finished its synthetic host session'
    )
    assert.equal(ackFor(nextDelivery).accepted, true)
    navigationCase.nextAccepted = snapshot('delivery-after-controlled-navigation-accepted')
    assert.equal(navigationCase.nextAccepted.state, 'accepted')
    assert.equal(navigationCase.nextAccepted.deliveryId, nextDelivery.deliveryId)
    assert.equal(
      hostMessages.filter(
        (message) =>
          message.type === 'ack' &&
          message.deliveryId === navigatingDelivery.deliveryId &&
          message.accepted
      ).length,
      0
    )
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>state.dirty&&!state.blocked)'),
      'the next delivery completed its durable pending-to-draft transfer'
    )
    await clickExposed(captureModal + ' .app-modal-close')
    await until(
      () =>
        js(
          'Boolean(document.querySelector(\'.confirm-card.active[aria-label="放弃这张便签草稿？"]\'))'
        ),
      'the navigation-case screenshot uses its ordinary discard confirmation'
    )
    await clickConfirmation('放弃草稿')
    await until(
      () => js(`!document.querySelector(${JSON.stringify(captureModal)})`),
      'the navigation-case screenshot draft closed through actual controls'
    )
    const nextSession = await start()
    navigationCase.nextSession = nextSession
    assert.notEqual(
      nextSession,
      navigationSession,
      'a fresh capture session can start after the accepted delivery'
    )
    coordinator.cancel()
    assert.equal(coordinator.active, null)
    await until(
      () => current.isVisible(),
      'the ordinary main window is available after the fresh-session check'
    )
    assert.equal(
      await js("document.querySelector('.nnp-root textarea').value"),
      'E7.2 preserves the original list draft'
    )
    scenarios.push(
      'controlled reload during awaiting-user releases the old frame as document-invalid; a new delivery and a fresh session remain usable without accepting the old screenshot'
    )

    assert.equal(await js("window.api.switchMainView('month')"), true)
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(draftConfirmation)}))`),
      'navigation owns a fresh independent draft confirmation'
    )
    await clickConfirmation('保留并切换')
    await until(
      () =>
        /\/month\.html(?:$|[?#])/.test(sender.getURL()) &&
        current.isVisible() &&
        !hooks.navigationState().switching,
      'actual month navigation completed after its own confirmation'
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(captureModal)}))`),
      false
    )
    scenarios.push(
      'subsequent navigation confirms independently and the old screenshot never opens in the new document'
    )

    // This target-limited fault occurs after the real receiver has durably
    // flushed its pending journal, but before main accepts its positive ACK.
    // The old image must remain recoverable without opening an expired editor.
    const unconfirmedSession = await start()
    const observedAck = coordinator.ack
    const unconfirmed = { attempts: 0, cancelled: false }
    coordinator.ack = async function (receiver, data, frame) {
      if (data.sessionId !== unconfirmedSession || data.accepted !== true)
        return Reflect.apply(observedAck, this, [receiver, data, frame])
      unconfirmed.attempts += 1
      unconfirmed.delivery = identity(data)
      unconfirmed.beforeCancel = coordinator.deliverySnapshot()
      try {
        unconfirmed.journalsBeforeCancel = await captureJournals()
      } catch (error) {
        unconfirmed.journalError = error.message
      }
      trace.push({
        type: 'cancel-before-positive-ack',
        ...identity(data),
        at: Date.now()
      })
      coordinator.cancel()
      unconfirmed.cancelled = true
      return false
    }
    let unconfirmedDelivery
    try {
      unconfirmedDelivery = await output('note')
      await until(
        () => unconfirmed.cancelled,
        'targeted positive ACK reached cancellation after the real durable journal flush'
      )
    } finally {
      coordinator.ack = observedAck
    }
    assert.equal(unconfirmed.attempts, 1)
    assert.equal(unconfirmed.journalError, undefined)
    assert.deepEqual(unconfirmed.delivery, unconfirmedDelivery)
    assert.equal(unconfirmed.beforeCancel.state, 'processing')
    const pendingBefore = unconfirmed.journalsBeforeCancel.find(
      (journal) =>
        journal.pendingAsset?.sessionId === unconfirmedDelivery.sessionId &&
        journal.pendingAsset.deliveryId === unconfirmedDelivery.deliveryId
    )?.pendingAsset
    assert.ok(
      pendingBefore?.image.assetId,
      'the cancelled ACK already had a real durable pending asset'
    )
    assert.match(pendingBefore.image.sha256, /^[a-f\d]{64}$/)
    assert.equal(coordinator.active, null)
    assert.equal(ackFor(unconfirmedDelivery).accepted, false)
    assertReleased(snapshot('unconfirmed-durable-cancelled'), 'cancelled')
    const recoverySelector = 'button[aria-label="恢复暂存截图"]'
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(recoverySelector)}))`),
      'unconfirmed durable screenshot exposes its explicit recovery entry'
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(captureModal)}))`),
      false,
      'the expired delivery must not open its old editor automatically'
    )
    unconfirmed.sourceBeforeReload = await js(
      'window.api.getSettingsSnapshot().then(value=>value.source)'
    )
    let recoveryReloaded = false
    const onRecoveryReloaded = () => {
      recoveryReloaded = true
    }
    sender.once('did-finish-load', onRecoveryReloaded)
    try {
      sender.reload()
      await until(
        () => recoveryReloaded,
        'same-view reload completed with the durable pending screenshot'
      )
    } finally {
      sender.removeListener('did-finish-load', onRecoveryReloaded)
    }
    await until(
      () =>
        js(
          "typeof window.api?.getSettingsSnapshot==='function' && Boolean(document.querySelector('.month-scene'))"
        ),
      'reloaded month document initialized its actual API and workspace'
    )
    unconfirmed.sourceAfterReload = await js(
      'window.api.getSettingsSnapshot().then(value=>value.source)'
    )
    assert.notEqual(unconfirmed.sourceAfterReload.token, unconfirmed.sourceBeforeReload.token)
    assert.equal(unconfirmed.sourceAfterReload.scope, unconfirmed.sourceBeforeReload.scope)
    await until(
      () => js(`Boolean(document.querySelector(${JSON.stringify(recoverySelector)}))`),
      'new document explicitly exposes its restored pending screenshot for recovery'
    )
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(captureModal)}))`),
      false,
      'restoring the durable journal must not automatically open a note editor in the new document'
    )
    assert.equal(
      await js('Boolean(document.querySelector(\'[data-modal-layer="wallpaper-crop"]\'))'),
      false,
      'restoring the durable journal must not automatically open a crop editor'
    )
    const beforeRecovery = await captureJournals()
    assert.deepEqual(
      beforeRecovery.find((journal) => journal.pendingAsset)?.pendingAsset,
      pendingBefore,
      'the explicit recovery entry still owns the original delivery and pending image metadata'
    )
    unconfirmed.normalRecoverySurface = await recoveryFixtureState(recoverySelector)
    assert.equal(unconfirmed.normalRecoverySurface.buttonEnabled, true)
    assert.equal(
      unconfirmed.normalRecoverySurface.buttonHit,
      true,
      'normal product recovery entry is unoccluded before any visual fixture'
    )
    await recoveryReadingSurfaces(recoverySelector)
    await clickExposed(recoverySelector)
    await until(
      () =>
        js(`document.querySelectorAll(${JSON.stringify(captureModal + ' .ip-thumb')}).length===1`),
      'clicking the actual recovery control loads one pending image into its real draft'
    )
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>state.dirty&&!state.blocked)'),
      'explicit recovery completed its durable pending-to-target ownership transfer'
    )
    const afterRecovery = await captureJournals()
    assert.equal(
      afterRecovery.some((journal) => journal.pendingAsset),
      false
    )
    const recoveredTarget = afterRecovery.find((journal) => journal.key.endsWith(':new:capture'))
    assert.ok(recoveredTarget)
    assert.equal(recoveredTarget.addedImages.length, 1)
    const matchingReceipts = recoveredTarget.captureReceipts.filter(
      (receipt) =>
        receipt.sessionId === unconfirmedDelivery.sessionId &&
        receipt.deliveryId === unconfirmedDelivery.deliveryId
    )
    assert.equal(matchingReceipts.length, 1)
    const recoveredImage = recoveredTarget.addedImages[0]
    assert.equal(matchingReceipts[0].assetId, recoveredImage.assetId)
    // The target owner stages an independent asset before releasing pending;
    // content hash/size and delivery identity establish the same original image.
    assert.notEqual(recoveredImage.assetId, pendingBefore.image.assetId)
    assert.equal(recoveredImage.sha256, pendingBefore.image.sha256)
    assert.equal(recoveredImage.size, pendingBefore.image.size)
    assert.equal(
      await js(`Boolean(document.querySelector(${JSON.stringify(recoverySelector)}))`),
      false,
      'successful recovery consumes its explicit recovery entry'
    )
    assert.equal(
      coordinator.ack(sender, { ...unconfirmedDelivery, accepted: true }, sender.mainFrame),
      false,
      'late ACK cannot turn the cancelled delivery into a new accepted one'
    )
    await captureFrame('capture-delivery-explicitly-recovered.png', captureModal)
    summary.explicitRecovery = {
      ...unconfirmed,
      beforeRecovery,
      afterRecovery
    }
    await clickExposed(captureModal + ' .app-modal-close')
    await until(
      () =>
        js(
          'Boolean(document.querySelector(\'.confirm-card.active[aria-label="放弃这张便签草稿？"]\'))'
        ),
      'recovered test screenshot uses its ordinary discard confirmation'
    )
    await clickConfirmation('放弃草稿')
    await until(
      () => js(`!document.querySelector(${JSON.stringify(captureModal)})`),
      'explicitly recovered test screenshot discarded through actual controls'
    )
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>!state.dirty&&!state.blocked)'),
      'month document clean after the explicit recovery scenario'
    )
    scenarios.push(
      'cancellation before positive ACK and a same-view document reload preserve the durable pending image; its exposed recovery control restores the same content and delivery identity once without an automatic expired editor'
    )

    // Recovery is verified by the actual business receiver and then by the
    // actual ScreenshotPicker -> ImagePicker -> durable draft path.
    await start()
    const acceptedGlobal = await output('note')
    await until(
      () =>
        js(`document.querySelectorAll(${JSON.stringify(captureModal + ' .ip-thumb')}).length===1`),
      'recovered global capture reached one real draft thumbnail'
    )
    await until(
      () => !coordinator.active,
      'accepted global delivery finished its synthetic host session'
    )
    assert.equal(ackFor(acceptedGlobal).accepted, true)
    assert.equal(snapshot('global-accepted').state, 'accepted')
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>state.dirty&&!state.blocked)'),
      'global receiver finished durable pending-to-target handoff'
    )
    await clickExposed(captureModal + ' .sp-btn')
    await until(
      () => coordinator.active?.origin === 'note',
      'real ScreenshotPicker started its own source session'
    )
    const acceptedSource = await output('source')
    await until(
      () =>
        js(`document.querySelectorAll(${JSON.stringify(captureModal + ' .ip-thumb')}).length===2`),
      'recovered source capture reached the same real draft'
    )
    await until(
      () => !coordinator.active,
      'source durable ownership released its synthetic host session'
    )
    assert.equal(ackFor(acceptedSource).accepted, true)
    assert.equal(snapshot('source-accepted').state, 'accepted')
    for (const delivered of [acceptedGlobal, acceptedSource]) {
      assert.deepEqual(
        trace
          .filter(
            (event) =>
              event.type === 'progress' && event.deliveryId === delivered.deliveryId && event.result
          )
          .map((event) => event.state),
        ['received', 'processing']
      )
      assert.equal(
        trace.filter(
          (event) =>
            event.type === 'ack' &&
            event.deliveryId === delivered.deliveryId &&
            event.accepted &&
            event.result
        ).length,
        1
      )
    }
    await captureFrame('capture-delivery-recovered-draft.png', captureModal)
    summary.recoveredJournals = await js(`Object.keys(localStorage)
      .filter(key=>key.startsWith('abandon:editing-draft:'))
      .map(key=>{const value=JSON.parse(localStorage.getItem(key));return {
        key,version:value.version,pendingAsset:Boolean(value.data?.pendingAsset),
        addedImages:value.data?.attachments?.addedImages?.map(image=>({assetId:image.assetId,size:image.size}))||[]
      }})`)
    assert.ok(summary.recoveredJournals.some((journal) => journal.addedImages.length === 2))
    await clickExposed(captureModal + ' .app-modal-close')
    await until(
      () =>
        js(
          'Boolean(document.querySelector(\'.confirm-card.active[aria-label="放弃这张便签草稿？"]\'))'
        ),
      'test screenshot draft uses its ordinary discard confirmation'
    )
    await clickConfirmation('放弃草稿')
    await until(
      () => js(`!document.querySelector(${JSON.stringify(captureModal)})`),
      'test capture draft discarded through actual controls'
    )
    await until(
      () => js('window.__prepareEditingDrafts().then(state=>!state.dirty&&!state.blocked)'),
      'active month document ready for normal application quit'
    )
    assert.equal(hooks.getDockRuntimeState().screenshotCaptureActive, false)
    assert.equal(
      trace.some((event) => event.hostError),
      false
    )
    scenarios.push(
      'recovery accepts a new global delivery and a real source attachment only after durable draft ownership, then cleans the owned test draft normally'
    )
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
    if (typeof coordinator?.deliverySnapshot === 'function')
      summary.failureDelivery = snapshot('failure')
    if (current && !current.isDestroyed()) {
      try {
        summary.failureRenderer = await js(`({
          visibility:document.visibilityState,
          modals:Array.from(document.querySelectorAll('.app-modal-card,.confirm-card')).map(node=>({label:node.getAttribute('aria-label'),active:node.classList.contains('active')})),
          draft:typeof window.__prepareEditingDrafts
        })`)
      } catch (diagnosticError) {
        summary.failureRendererError = diagnosticError.message
      }
    }
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      restore,
      summary: {
        ...summary,
        scenarios,
        trace,
        hostMessages,
        snapshots,
        frames,
        fixtureObservations
      }
    })
  }
}
try {
  app.setPath('userData', root)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'actual application main chunk exists')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  void lifecycle.finish({ error })
}
