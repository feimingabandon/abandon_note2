// Run with bundled Node and an explicit --dir --publish never Windows candidate.
const { spawn, execFile } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { isAbsolute, relative, resolve, join, sep } = require('node:path')
const { promisify } = require('node:util')
const {
  createAssertionRecorder,
  prepareTestProfile
} = require('./helpers/test-result-recorder.cjs')

const recorder = createAssertionRecorder({
  suite: 'tests/capture-package-smoke.cjs',
  mode: 'node-packaged-app-candidate',
  metadata: {
    actualPackagedApp: true,
    realNativeCaptureInput: true,
    appLocalQt: true,
    asarImageAndLogWorkers: true,
    ownedSingleDisplayPattern: true,
    coldRestartSameProfile: true,
    installerUpgradeUninstall: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-packaged-candidate-' })
const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || join(profile.directory, 'evidence')
mkdirSync(evidence, { recursive: true })
const execute = promisify(execFile)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const report = {
  candidate: null,
  launches: [],
  phases: [],
  exports: [],
  ownershipChecks: [],
  cleanup: []
}
const launches = report.launches
const marker = 'packaged-candidate-note-' + randomUUID()
let packageDir, executable, helperExecutable, driver, current, socket, originalCursor
let sequence = 0,
  completed = false,
  failure = null,
  timedOut = false
const requests = new Map()
const expectedVersion = '1.4.0'
const businessDeadline = Date.now() + 210000
let cleanupDeadline = null
const timeout = setTimeout(() => {
  timedOut = true
  rejectRequests(new Error('Packaged candidate timed out'))
  socket?.close()
}, 210000)

function remainingTimeout(maximum) {
  const remaining = (cleanupDeadline ?? businessDeadline) - Date.now()
  if (remaining <= 0)
    throw new Error(
      cleanupDeadline ? 'Owned cleanup deadline exceeded' : 'Packaged candidate timed out'
    )
  return Math.min(maximum, remaining)
}

function inside(root, target) {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}
function ownedFile(root, target) {
  const actual = realpathSync(target)
  if (!inside(root, actual) || !statSync(actual).isFile())
    throw new Error('File escapes expected owner: ' + target)
  return actual
}
function fileEvidence(file) {
  const bytes = readFileSync(file)
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
function quotePowerShell(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}
function samePath(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    resolve(a).toLowerCase() === resolve(b).toLowerCase()
  )
}
function sameProcess(a, b) {
  return Boolean(
    a &&
    b &&
    a.pid === b.pid &&
    a.parentPid === b.parentPid &&
    a.creationTime === b.creationTime &&
    samePath(a.executable, b.executable)
  )
}
function powerShellArguments(code) {
  // PS 5.1 otherwise emits its legacy console encoding. Preserve Unicode paths in both
  // the command transport and JSON output; ownership comparisons must remain exact.
  const source =
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n' +
    '$OutputEncoding = [Console]::OutputEncoding\n' +
    code
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64')
  ]
}
async function queryProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process PID')
  const code = `$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($null -eq $taskProcess) { 'null' } else { @{ pid=[int]$taskProcess.ProcessId; parentPid=[int]$taskProcess.ParentProcessId; executable=[string]$taskProcess.ExecutablePath; creationTime=$taskProcess.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`
  const result = await execute(powershell, powerShellArguments(code), {
    windowsHide: true,
    encoding: 'utf8',
    timeout: remainingTimeout(10000),
    maxBuffer: 1024 * 1024
  })
  return JSON.parse(result.stdout.trim())
}
async function stillOwned(identity) {
  const observed = await queryProcess(identity.pid)
  report.ownershipChecks.push({ at: new Date().toISOString(), expected: identity, observed })
  return sameProcess(identity, observed)
}
async function terminateVerified(identity) {
  const observed = await queryProcess(identity.pid)
  report.ownershipChecks.push({
    at: new Date().toISOString(),
    action: 'before-terminate',
    expected: identity,
    observed
  })
  if (!observed) return { action: 'already-exited', identity }
  if (!sameProcess(identity, observed))
    throw new Error(
      'Owned process identity changed; refusing termination: ' +
        JSON.stringify({ identity, observed })
    )
  // The same PowerShell invocation rechecks all owner fields immediately before Kill.
  const code = `$taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" -ErrorAction Stop; if ($null -eq $taskProcess) { 'exited' } elseif ([int]$taskProcess.ParentProcessId -ne ${identity.parentPid} -or [string]$taskProcess.ExecutablePath -ine ${quotePowerShell(identity.executable)} -or $taskProcess.CreationDate.ToUniversalTime().ToString('o') -ne ${quotePowerShell(identity.creationTime)}) { throw 'Owner identity mismatch; termination refused' } else { $ownedProcess=Get-Process -Id ${identity.pid} -ErrorAction Stop; $null=$ownedProcess.Handle; $taskAgain=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" -ErrorAction Stop; if ($null -eq $taskAgain -or [int]$taskAgain.ParentProcessId -ne ${identity.parentPid} -or [string]$taskAgain.ExecutablePath -ine ${quotePowerShell(identity.executable)} -or $taskAgain.CreationDate.ToUniversalTime().ToString('o') -ne ${quotePowerShell(identity.creationTime)}) { throw 'Owner changed before Kill; termination refused' }; $ownedProcess.Kill(); $ownedProcess.WaitForExit(5000); 'terminated' }`
  const result = await execute(powershell, powerShellArguments(code), {
    windowsHide: true,
    encoding: 'utf8',
    timeout: remainingTimeout(12000),
    maxBuffer: 1024 * 1024
  })
  return { action: result.stdout.trim(), identity }
}
async function until(check, label, timeoutMs = 20000, cleanup = false) {
  const deadline = Date.now() + remainingTimeout(timeoutMs)
  while (Date.now() < deadline) {
    if (timedOut && !cleanup) throw new Error('Packaged candidate timed out: ' + label)
    const value = await check()
    if (value) return value
    await wait(Math.min(40, remainingTimeout(40)))
  }
  throw new Error(label)
}
function rejectRequests(error) {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  requests.clear()
}
function evaluate(expression) {
  let requestTimeout
  try {
    requestTimeout = remainingTimeout(cleanupDeadline ? 2000 : 15000)
  } catch (error) {
    return Promise.reject(error)
  }
  if (!socket || socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error('Inspector is unavailable'))
  return new Promise((resolveResult, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      requests.delete(id)
      reject(new Error('Inspector evaluation timed out'))
    }, requestTimeout)
    requests.set(id, { timer, reject, resolve: resolveResult })
    try {
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    } catch (error) {
      clearTimeout(timer)
      requests.delete(id)
      reject(error)
    }
  })
}
function renderer(source) {
  return evaluate(`capturePackageMain.webContents.executeJavaScript(${JSON.stringify(source)})`)
}
function childEnvironment() {
  const env = {
    ...process.env,
    ABANDON_INTEGRATION_TEST: '1',
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'QT_PLUGIN_PATH',
    'QT_QPA_PLATFORM_PLUGIN_PATH',
    'QT_ROOT_DIR',
    'QTDIR',
    'ABANDON_INTEGRATION_APP_ROOT',
    'ABANDON_INTEGRATION_NATIVE_DLL'
  ])
    delete env[key]
  return env
}
async function connectToApp() {
  const launch = {
    index: launches.length + 1,
    output: '',
    exitCode: null,
    signal: null,
    exited: false,
    closed: false,
    spawned: false,
    identity: null,
    helper: null
  }
  launches.push(launch)
  current = launch
  const child = spawn(executable, ['--inspect=0', `--user-data-dir=${profile.directory}`], {
    env: childEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  launch.child = child
  child.stdout.on('data', (bytes) => {
    launch.output += bytes.toString()
  })
  child.stderr.on('data', (bytes) => {
    launch.output += bytes.toString()
  })
  child.on('error', (error) => {
    launch.spawnError = error.stack || error.message
  })
  child.on('exit', (code, signal) => {
    launch.exited = true
    launch.exitCode = code
    launch.signal = signal
  })
  child.on('close', (code, signal) => {
    launch.closed = true
    launch.exitCode = code
    launch.signal = signal
  })
  await new Promise((done, reject) => {
    const spawnTimeout = setTimeout(
      () => reject(new Error('Candidate spawn timed out')),
      remainingTimeout(10000)
    )
    child.once('spawn', () => {
      clearTimeout(spawnTimeout)
      launch.spawned = true
      done()
    })
    child.once('error', (error) => {
      clearTimeout(spawnTimeout)
      reject(error)
    })
  })
  launch.identity = await until(
    () => queryProcess(child.pid),
    'Spawned app process identity unavailable'
  )
  assert.equal(launch.identity.parentPid, process.pid, 'app is not owned by this test process')
  assert.equal(
    samePath(launch.identity.executable, executable),
    true,
    'app process exe differs from candidate'
  )
  const url = await until(() => {
    if (launch.spawnError || launch.exited)
      throw new Error(
        'Candidate exited before inspector: ' +
          JSON.stringify({
            spawnError: launch.spawnError,
            exitCode: launch.exitCode,
            signal: launch.signal
          })
      )
    return launch.output.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0]
  }, 'Packaged app inspector did not start')
  const connected = new WebSocket(url)
  socket = connected
  await new Promise((done, reject) => {
    const openTimeout = setTimeout(() => {
      connected.close()
      reject(new Error('Inspector open timed out'))
    }, remainingTimeout(10000))
    connected.addEventListener(
      'open',
      () => {
        clearTimeout(openTimeout)
        done()
      },
      { once: true }
    )
    connected.addEventListener(
      'error',
      () => {
        clearTimeout(openTimeout)
        reject(new Error('Inspector connection failed'))
      },
      { once: true }
    )
  })
  connected.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch (error) {
      rejectRequests(error)
      return
    }
    const pending = requests.get(message.id)
    if (!pending) return
    requests.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error || message.result?.exceptionDetails)
      pending.reject(new Error(JSON.stringify(message)))
    else pending.resolve(message.result?.result?.value)
  })
  connected.addEventListener('close', () => rejectRequests(new Error('Inspector closed')))
  connected.addEventListener('error', () => rejectRequests(new Error('Inspector transport error')))
  await wait(1000)
  await evaluate(
    `globalThis.captureTestElectron = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'); true`
  )
  const identity = await evaluate(
    `({packaged:captureTestElectron.app.isPackaged,profile:captureTestElectron.app.getPath('userData'),appPath:captureTestElectron.app.getAppPath(),resourcesPath:process.resourcesPath,pid:process.pid,version:captureTestElectron.app.getVersion()})`
  )
  assert.equal(identity.packaged, true)
  assert.equal(identity.version, expectedVersion, 'candidate version differs from expected 1.4.0')
  assert.equal(identity.pid, child.pid, 'inspector is not spawned candidate')
  assert.equal(samePath(identity.profile, profile.directory), true)
  assert.equal(samePath(identity.resourcesPath, join(packageDir, 'resources')), true)
  assert.equal(samePath(identity.appPath, join(packageDir, 'resources', 'app.asar')), true)
  launch.applicationIdentity = identity
  await until(
    () =>
      evaluate(
        `(()=>{globalThis.capturePackageMain=captureTestElectron.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().endsWith('/index.html'));return Boolean(capturePackageMain&&!capturePackageMain.webContents.isLoadingMainFrame());})()`
      ),
    'packaged list main missing'
  )
  let startupConflictHandled = false
  await until(async () => {
    const setup = await renderer(
      `(async()=>{
          const welcome=document.querySelector('.app-modal-card[aria-label="欢迎使用 Abandon 便签"]');
          if(welcome){welcome.querySelector('button[data-modal-initial-focus]:not(:disabled)')?.click();return false};
          const notice=document.querySelector('.app-modal-card[aria-label="软件通知"]');
          if(notice){notice.querySelector('.app-modal-close:not(:disabled)')?.click();return false};
          const conflict=document.querySelector('.app-modal-card[aria-label="快捷键启用提示"]');
          if(conflict){
            if(${startupConflictHandled})return false;
            const button=[...conflict.querySelectorAll('button')].find(item=>item.textContent.trim()==='稍后处理'&&!item.disabled);
            if(!button)throw Error('Known startup shortcut notice has no enabled defer button');
            const snapshot=await window.api.getSettingsSnapshot();
            const recorded={text:conflict.textContent.trim(),items:[...conflict.querySelectorAll('li')].map(item=>item.textContent.trim()),runtime:snapshot.runtime.shortcuts};
            button.click();
            return {startupConflict:recorded};
          };
          const snapshot=await window.api.getSettingsSnapshot();
          return snapshot.values.onboarding.noticeVersion>0&&!document.querySelector('.app-modal-card');
        })()`
    )
    if (setup?.startupConflict) {
      startupConflictHandled = true
      launch.startupShortcutConflict = setup.startupConflict
      report.phases.push({
        phase: 'startup-shortcut-conflict-deferred',
        launch: launch.index,
        ...setup.startupConflict
      })
      return false
    }
    return setup === true
  }, 'packaged first-use setup did not finish')
  await until(
    () => evaluate('globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.nativeCaptureState().ready === true'),
    'packaged native capture not ready'
  )
  const native = await evaluate(
    `({...__ABANDON_WINDOW_TEST_HOOKS__.nativeCaptureState(),directory:__ABANDON_WINDOW_TEST_HOOKS__.captureCoordinator().host.directory})`
  )
  assert.equal(
    samePath(native.directory, join(packageDir, 'resources', 'native_capture')),
    true,
    'Qt runtime was not app-local'
  )
  launch.helper = await queryProcess(native.pid)
  assert.ok(launch.helper, 'native helper process missing')
  assert.equal(launch.helper.parentPid, child.pid, 'capture helper is not child of candidate')
  assert.equal(
    samePath(launch.helper.executable, helperExecutable),
    true,
    'capture helper executable differs'
  )
  launch.workerSources = await evaluate(
    `(()=>{const req=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json');const fs=req('node:fs'),crypto=req('node:crypto');return ['out/main/capture-image.js','out/main/log-writer.js'].map(relativePath=>{const file=captureTestElectron.app.getAppPath()+'/'+relativePath,bytes=fs.readFileSync(file);return {relativePath,file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});})()`
  )
  assert.equal(launch.workerSources.length, 2)
  assert.ok(
    launch.workerSources.every((source) => source.bytes > 0 && source.file.includes('app.asar/')),
    'packaged worker source is not inside ASAR'
  )
  if (!originalCursor)
    originalCursor = await evaluate(
      'captureTestElectron.screen.dipToScreenPoint(captureTestElectron.screen.getCursorScreenPoint())'
    )
  return launch
}
async function press(args) {
  assert.equal(await stillOwned(current.helper), true, 'helper owner changed before driver input')
  const result = await execute(driver, [String(current.helper.pid), ...args], {
    windowsHide: true,
    timeout: remainingTimeout(10000),
    maxBuffer: 1024 * 1024,
    env: childEnvironment()
  })
  report.phases.push({
    phase: 'native-driver',
    launch: current.index,
    args,
    stdout: result.stdout,
    stderr: result.stderr
  })
}
async function createPattern() {
  const result = await evaluate(
    `(async()=>{const displays=captureTestElectron.screen.getAllDisplays();if(displays.length!==1)throw Error('Owned full-screen capture fixture requires exactly one actual display');const display=displays[0];globalThis.capturePackagePattern=new captureTestElectron.BrowserWindow({...display.bounds,frame:false,thickFrame:false,roundedCorners:false,transparent:false,focusable:false,show:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});const html='<!doctype html><html><body style="margin:0;width:100vw;height:100vh;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;overflow:hidden"><div style="background:#17385f"></div><div style="background:#b96a28"></div><div style="background:#267460"></div><div style="background:#783c67"></div></body></html>';await capturePackagePattern.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));capturePackagePattern.setBounds(display.bounds);capturePackagePattern.setAlwaysOnTop(true,'screen-saver');capturePackagePattern.showInactive();await capturePackagePattern.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');return {display,bounds:capturePackagePattern.getBounds(),contentBounds:capturePackagePattern.getContentBounds(),framePolicy:{thickFrame:false,roundedCorners:false},visible:capturePackagePattern.isVisible(),topmost:capturePackagePattern.isAlwaysOnTop(),windowId:capturePackagePattern.id};})()`
  )
  assert.equal(result.visible, true, 'test-owned desktop pattern is not visible')
  assert.equal(result.topmost, true)
  assert.deepEqual(
    result.bounds,
    result.display.bounds,
    'pattern does not cover actual single display'
  )
  assert.deepEqual(
    result.contentBounds,
    result.display.bounds,
    'pattern client area does not cover actual single display'
  )
  report.phases.push({ phase: 'owned-fullscreen-pattern', ...result })
  await evaluate(
    `(async()=>{const fs=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('node:fs');fs.writeFileSync(${JSON.stringify(join(evidence, 'owned-pattern.png'))},(await capturePackagePattern.webContents.capturePage()).toPNG(),{flag:'wx'});return true;})()`
  )
  await wait(250)
}
async function destroyPattern() {
  if (socket?.readyState === WebSocket.OPEN)
    await evaluate(
      'if(globalThis.capturePackagePattern&&!capturePackagePattern.isDestroyed()) capturePackagePattern.destroy(); true'
    )
}
async function savedNote(id) {
  const result = await renderer(
    `(async()=>{const note=await window.api.getNote(${id}),images=await window.api.listImages(${id});return {note,images,thumbnails:await Promise.all(images.map(image=>window.api.getImageThumbnail(image.file_path,240))),dimensions:await Promise.all(images.map(image=>window.api.getImageDimensions(image.file_path)))};})()`
  )
  assert.equal(result.note?.content, marker, 'saved note content differs')
  assert.equal(result.images.length, 1, 'saved screenshot attachment missing')
  const attachment = ownedFile(
    profile.directory,
    resolve(profile.directory, result.images[0].file_path)
  )
  assert.ok(
    inside(join(profile.directory, 'attachments'), attachment),
    'attachment is outside owned attachments'
  )
  assert.ok(
    typeof result.thumbnails[0] === 'string' && result.thumbnails[0].startsWith('data:image/'),
    'real saved thumbnail could not be decoded'
  )
  const thumbnail = Buffer.from(result.thumbnails[0].split(',')[1], 'base64')
  const summary = {
    note: result.note,
    images: result.images,
    dimensions: result.dimensions,
    attachment: fileEvidence(attachment),
    thumbnail: {
      bytes: thumbnail.length,
      sha256: createHash('sha256').update(thumbnail).digest('hex')
    }
  }
  assert.ok(summary.attachment.bytes > 0)
  assert.ok(summary.thumbnail.bytes > 0)
  return summary
}
async function exportDiagnostic(name) {
  const filePath = join(evidence, name + '.jsonl')
  const deep = await renderer('window.api.startDeepDiagnostics()')
  assert.equal(deep.mode, 'deep')
  await until(
    () => renderer('window.api.getDiagnosticPolicy().mode === "deep"'),
    'packaged deep policy not applied'
  )
  await renderer(
    `window.api.reportLog({level:'info',scope:'packaged-candidate.probe',message:${JSON.stringify(marker)},metadata:{ownedFixture:true,launch:${current.index}}}); true`
  )
  const exported = await evaluate(
    `(async()=>{const original=captureTestElectron.dialog.showSaveDialog;try{captureTestElectron.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(filePath)}});return await capturePackageMain.webContents.executeJavaScript('window.api.exportLogs({range:"all"})');}finally{captureTestElectron.dialog.showSaveDialog=original;}})()`
  )
  assert.equal(samePath(exported.filePath, filePath), true, 'packaged export target differs')
  const bytes = readFileSync(filePath),
    records = bytes.toString('utf8').trim().split('\n').map(JSON.parse)
  const completion = records.find((record) => record.type === 'diagnostic-complete'),
    probe = records.filter(
      (record) => record.scope === 'packaged-candidate.probe' && record.message === marker
    )
  assert.equal(
    records.find((record) => record.type === 'diagnostic-export')?.appVersion,
    expectedVersion,
    'packaged diagnostic header version differs'
  )
  assert.ok(
    probe.some((record) => record.metadata?.launch === current.index),
    'ASAR log Worker export omitted current marker'
  )
  assert.ok(
    probe
      .filter((record) => record.metadata?.launch === current.index)
      .every((record) => record.appVersion === expectedVersion),
    'packaged log Worker recorded a different application version'
  )
  assert.equal(completion?.complete, true, 'packaged diagnostic tail was incomplete')
  assert.equal(completion.exportFinished, true)
  const mainId = await evaluate('capturePackageMain.webContents.id')
  assert.ok(
    completion.manifest.capture.windows.some(
      (window) => window.webContentsId === mainId && window.status === 'complete'
    ),
    'packaged main renderer tail unconfirmed'
  )
  const state = await renderer('window.api.getDiagnosticState()')
  assert.equal(state.diagnostics.writer.status, 'ready')
  assert.equal(Number(state.diagnostics.writer.droppedRecords || 0), 0)
  assert.equal(Number(state.diagnostics.writer.writeErrors || 0), 0)
  const stopped = await renderer('window.api.stopDeepDiagnostics()')
  assert.equal(stopped.mode, 'daily')
  const summary = {
    name,
    ...fileEvidence(filePath),
    records: records.length,
    sessions: [...new Set(probe.map((record) => record.sessionId))],
    completion,
    writer: state.diagnostics.writer
  }
  report.exports.push(summary)
  return summary
}
async function quitApp() {
  const launch = current
  await destroyPattern()
  await evaluate('setTimeout(()=>captureTestElectron.app.quit(),100); true')
  socket?.close()
  socket = null
  await until(() => launch.exited, 'packaged app did not quit')
  assert.equal(launch.exitCode, 0, 'packaged normal quit exit code differs')
  assert.equal(launch.signal, null, 'packaged app ended by signal during normal quit')
  await until(
    async () => !(await stillOwned(launch.helper)),
    'packaged owned helper survived normal quit'
  )
  launch.normalQuitVerified = true
  delete launch.child
}
async function cleanupOwned() {
  const errors = []
  try {
    await destroyPattern()
  } catch (error) {
    errors.push(error.message)
  }
  if (current && !current.exited && socket?.readyState === WebSocket.OPEN) {
    try {
      await evaluate('setTimeout(()=>captureTestElectron.app.quit(),50); true')
      await until(() => current.exited, 'cleanup graceful quit timed out', 4000, true)
    } catch (error) {
      report.cleanup.push({ action: 'graceful-quit-unavailable', error: error.message })
    }
  }
  socket?.close()
  socket = null
  rejectRequests(new Error('Inspector cleanup'))
  for (const launch of launches) {
    for (const identity of [launch.helper, launch.identity].filter(Boolean)) {
      try {
        if (await stillOwned(identity)) report.cleanup.push(await terminateVerified(identity))
        await until(
          async () => !(await stillOwned(identity)),
          'owned process survived verified cleanup',
          7000,
          true
        )
      } catch (error) {
        errors.push(error.message)
        report.cleanup.push({ identity, error: error.stack || error.message })
      }
    }
    if (launch.child && !launch.spawned && !launch.closed) {
      try {
        await until(() => launch.closed, 'failed spawn did not close', 1000, true)
      } catch (error) {
        errors.push(error.message)
      }
    }
    if (launch.child && !launch.exited && !launch.closed)
      errors.push('Spawned candidate still has no verified exit: ' + launch.child.pid)
    delete launch.child
  }
  if (originalCursor) {
    try {
      const user32 = require('koffi').load('user32.dll'),
        restore = user32.func('int SetCursorPos(int X, int Y)')
      if (restore(originalCursor.x, originalCursor.y) !== 1)
        throw new Error('Cursor restoration failed')
    } catch (error) {
      errors.push(error.message)
    }
  }
  return errors
}

;(async () => {
  try {
    assert.equal(process.platform, 'win32')
    assert.equal(process.arch, 'x64')
    const explicit = process.argv[2],
      configured = process.env.ABANDON_TEST_PACKAGE_DIR
    if (process.argv.length > 3 || (!explicit && !configured))
      throw new Error(
        'Explicit candidate required: capture-package-smoke.cjs <absolute win-unpacked path> or ABANDON_TEST_PACKAGE_DIR'
      )
    if (explicit && !isAbsolute(explicit)) throw new Error('Candidate path must be absolute')
    if (configured && !isAbsolute(configured))
      throw new Error('Configured candidate path must be absolute')
    packageDir = realpathSync(explicit || configured)
    if (!statSync(packageDir).isDirectory()) throw new Error('Candidate is not a directory')
    if (explicit && configured && !samePath(realpathSync(explicit), realpathSync(configured)))
      throw new Error('Candidate argument and environment disagree')
    executable = ownedFile(packageDir, join(packageDir, 'AbandonNote.exe'))
    helperExecutable = ownedFile(
      packageDir,
      join(packageDir, 'resources', 'native_capture', 'AbandonCapture.exe')
    )
    const archive = ownedFile(packageDir, join(packageDir, 'resources', 'app.asar'))
    driver = realpathSync(
      process.env.ABANDON_CAPTURE_INPUT_DRIVER ||
        resolve('native_capture/build/bin/capture_input_driver.exe')
    )
    if (!statSync(driver).isFile()) throw new Error('Capture input driver missing')
    report.candidate = {
      packageDir,
      executable: fileEvidence(executable),
      helper: fileEvidence(helperExecutable),
      asar: fileEvidence(archive),
      driver: fileEvidence(driver),
      profile: profile.directory,
      ownership: profile.ownership,
      expectedVersion,
      installerExecuted: false
    }
    const first = await connectToApp()
    await createPattern()
    const started = await evaluate('__ABANDON_WINDOW_TEST_HOOKS__.startNativeCapture()')
    assert.equal(started.status, 'started')
    await wait(250)
    await press(['F'])
    await press(['N', 'ctrl'])
    await until(
      () => evaluate('__ABANDON_WINDOW_TEST_HOOKS__.nativeCaptureState().active === false'),
      'packaged ASAR image delivery did not finish'
    )
    await until(
      () =>
        renderer(
          'Boolean(document.querySelector(\'.app-modal-card[aria-label="截图新建便签"] .ip-thumb\'))'
        ),
      'native screenshot was not imported into real draft'
    )
    await destroyPattern()
    await renderer(
      `(()=>{const modal=document.querySelector('.app-modal-card[aria-label="截图新建便签"]'),input=modal.querySelector('textarea');if(!input)throw Error('Screenshot note editor missing');input.value=${JSON.stringify(marker)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`
    )
    await until(
      () =>
        renderer(
          `Boolean(document.querySelector('.app-modal-card[aria-label="截图新建便签"] button[data-diagnostic-action="note.create"]:not(:disabled)'))`
        ),
      'actual screenshot create button did not become enabled'
    )
    await renderer(
      `document.querySelector('.app-modal-card[aria-label="截图新建便签"] button[data-diagnostic-action="note.create"]').click(); true`
    )
    const saved = await until(
      () =>
        renderer(
          `window.api.queryRecentNotes({search:${JSON.stringify(marker)},cutoffTime:0}).then(notes=>{const matches=notes.filter(note=>note.content===${JSON.stringify(marker)});if(matches.length>1)throw Error('Fixture note duplicated');return matches[0]||null;})`
        ),
      'actual screenshot note was not saved'
    )
    await until(
      () => renderer('!document.querySelector(\'.app-modal-card[aria-label="截图新建便签"]\')'),
      'saved screenshot form did not finish naturally'
    )
    const before = await savedNote(saved.id)
    report.phases.push({ phase: 'saved-screenshot-note', ...before })
    const pixels = await evaluate(
      `(()=>{const image=captureTestElectron.nativeImage.createFromPath(${JSON.stringify(before.attachment.file)}),size=image.getSize(),bitmap=image.toBitmap();return {size,colors:[[.2,.2],[.8,.2],[.2,.8],[.8,.8],[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>{const offset=(Math.min(size.height-1,Math.floor(y*size.height))*size.width+Math.min(size.width-1,Math.floor(x*size.width)))*4;return [...bitmap.subarray(offset,offset+4)];})};})()`
    )
    const expected = [
      [95, 56, 23],
      [40, 106, 185],
      [96, 116, 38],
      [103, 60, 120],
      [95, 56, 23],
      [40, 106, 185],
      [96, 116, 38],
      [103, 60, 120]
    ]
    assert.ok(
      pixels.colors.every((color, index) =>
        expected[index].every((value, channel) => Math.abs(color[channel] - value) <= 6)
      ),
      'real saved screenshot did not contain owned full-screen pattern'
    )
    report.phases.push({ phase: 'pattern-pixels', ...pixels })
    const firstExport = await exportDiagnostic('packaged-before-restart')
    await evaluate(
      `(async()=>{const snapshot=await capturePackageMain.webContents.executeJavaScript('window.api.getSettingsSnapshot()');if(snapshot.values.shortcuts.enabled)__ABANDON_WINDOW_TEST_HOOKS__.getTrayMenuTemplate().find(item=>item.id==='toggle-global-shortcuts').click();const result=await capturePackageMain.webContents.executeJavaScript("window.api.setCaptureShortcut('screenshot','Control+Alt+Shift+F8')");if(result.status!=='saved')throw Error('Packaged binding did not save: '+JSON.stringify(result));return true;})()`
    )
    await quitApp()
    const second = await connectToApp()
    assert.equal(
      sameProcess(first.identity, second.identity),
      false,
      'cold restart reused same app process'
    )
    assert.equal(
      samePath(first.applicationIdentity.profile, second.applicationIdentity.profile),
      true
    )
    const after = await savedNote(saved.id)
    assert.deepEqual(after.images, before.images, 'cold restart changed saved attachment records')
    assert.equal(
      after.attachment.sha256,
      before.attachment.sha256,
      'cold restart changed attachment bytes'
    )
    assert.deepEqual(after.dimensions, before.dimensions, 'cold restart changed image dimensions')
    report.phases.push({ phase: 'cold-restart-readback', ...after })
    const restored = await evaluate(
      `(async()=>{const snapshot=await capturePackageMain.webContents.executeJavaScript('window.api.getSettingsSnapshot()');return {values:snapshot.values.shortcuts,runtime:snapshot.runtime.shortcuts.screenshot,registered:captureTestElectron.globalShortcut.isRegistered('Control+Alt+Shift+F8')};})()`
    )
    assert.equal(restored.values.enabled, true)
    assert.equal(restored.values.screenshot, 'Control+Alt+Shift+F8')
    assert.equal(restored.runtime.enabled, true)
    assert.equal(restored.runtime.registered, true)
    assert.equal(restored.registered, true)
    report.phases.push({ phase: 'cold-restart-binding', restored })
    const secondExport = await exportDiagnostic('packaged-after-restart')
    assert.ok(
      secondExport.sessions.some((session) => !firstExport.sessions.includes(session)),
      'cold restart diagnostic session did not change'
    )
    await quitApp()
    assert.equal(launches.length, 2)
    assert.ok(
      launches.every((launch) => launch.normalQuitVerified),
      'both real app/helper quits not verified'
    )
    completed = true
  } catch (error) {
    failure = error
    process.stderr.write((error.stack || error.message) + '\n')
  } finally {
    clearTimeout(timeout)
    cleanupDeadline = Date.now() + 35000
    report.cleanupDeadline = { maximumMs: 35000, startedAt: new Date().toISOString() }
    const errors = await cleanupOwned()
    report.cleanupDeadline.finishedAt = new Date().toISOString()
    if (errors.length) {
      failure ||= new Error('Owned cleanup failed: ' + errors.join('; '))
      completed = false
    }
    const cleanup = {
      status: errors.length
        ? 'failed'
        : profile.ownership === 'runner' && completed
          ? 'complete'
          : 'preserved',
      ownedProcessesClosed: errors.length === 0,
      errors,
      preservedProfile: failure || profile.ownership === 'script' ? profile.directory : undefined,
      scope:
        'Only verified spawned candidate/helper; runner owns successful managed profile deletion'
    }
    report.completed = completed
    report.error = failure?.stack || null
    report.cleanupSummary = cleanup
    report.pendingInspectorRequests = requests.size
    let evidenceState = {
      status: 'complete',
      artifacts: [
        'package-evidence.json',
        'process.log',
        'owned-pattern.png',
        ...report.exports.map((item) => item.name + '.jsonl')
      ]
    }
    try {
      writeFileSync(
        join(evidence, 'process.log'),
        launches.map((launch) => `[launch ${launch.index}]\n${launch.output}`).join('\n'),
        { flag: 'wx' }
      )
      writeFileSync(join(evidence, 'package-evidence.json'), JSON.stringify(report, null, 2), {
        flag: 'wx'
      })
      evidenceState.artifacts = evidenceState.artifacts.filter((name) =>
        existsSync(join(evidence, name))
      )
    } catch (error) {
      failure ||= error
      completed = false
      evidenceState = { status: 'failed', error: error.stack }
    }
    process.exitCode = failure ? 1 : 0
    recorder.finish({
      completed,
      error: failure,
      evidence: evidenceState,
      profileOwnership: profile.ownership,
      cleanup
    })
  }
})().catch((error) => {
  process.stderr.write((error.stack || error.message) + '\n')
  process.exitCode = 1
})
