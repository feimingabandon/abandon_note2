// Opt-in Windows acceptance: real toast submission and warm/cold protocol callbacks.
// This does not claim that a human click on the notification UI was exercised.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const appId = 'AbandonReminderProbe-' + randomUUID()
const scheme = appId.toLowerCase()
const roundId = randomUUID()
const clsid = '{' + randomUUID() + '}'
const root = path.join(os.tmpdir(), appId)
const exe = path.join(root, 'electron.exe')
const log = path.join(root, 'events.jsonl')
const appRoot = path.join(root, 'resources', 'app')
fs.cpSync(path.dirname(require('electron')), root, { recursive: true })
// Electron's shortcut name comes from the executable ProductName, not app.setName.
// Give the copied test executable its own resource identity before registration.
const editorRoot = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
const editor = fs
  .readdirSync(editorRoot)
  .map((n) => path.join(editorRoot, n, 'rcedit-x64.exe'))
  .find(fs.existsSync)
assert.ok(editor, 'A cached rcedit is required for this opt-in probe')
const edited = spawnSync(editor, [exe, '--set-version-string', 'ProductName', appId], {
  windowsHide: true,
  encoding: 'utf8'
})
assert.equal(edited.status, 0, edited.stderr)
fs.mkdirSync(appRoot, { recursive: true })
fs.writeFileSync(
  path.join(appRoot, 'package.json'),
  JSON.stringify({ name: appId, main: 'main.cjs', version: '1.0.0' })
)
const code = `
import { app } from 'electron'
import { appendFileSync, existsSync } from 'node:fs'
import { NotificationService } from './src/main/services/NotificationService.js'
import { parseReminderProtocol } from './src/shared/reminder-protocol.js'
const log = ${JSON.stringify(log)}
const cold = existsSync(log)
const record = (event) => appendFileSync(log, JSON.stringify({ ...event, pid:process.pid })+'\\n')
app.setName(${JSON.stringify(appId)})
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))})
app.setAppUserModelId(${JSON.stringify(appId)})
app.setToastActivatorCLSID(${JSON.stringify(clsid)})
const service = new NotificationService({appProtocol:${JSON.stringify(scheme)},platform:'win32',capability:{supported:true},icon:${JSON.stringify(path.resolve('resources/icon.png'))}})
function handle(argv) {
  const payload = argv.map(arg => parseReminderProtocol(arg,${JSON.stringify(scheme)})).find(Boolean)
  if (payload) {
    record({kind:'action',payload,cold})
    if (cold) {
      service.sendReminder({id:${JSON.stringify(roundId)},content:'提醒测试已完成'})
      setTimeout(()=>service.closeReminder(${JSON.stringify(roundId)}),200)
      app.removeAsDefaultProtocolClient(${JSON.stringify(scheme)})
    }
    setTimeout(()=>{service.dispose();app.quit()},500)
  }
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('will-quit', () => record({kind:'quit'}))
  record({kind:'loaded',cold,args:process.argv})
  app.on('second-instance',(_event,argv)=>handle(argv))
  app.whenReady().then(() => {
    record({kind:'boot',cold})
    app.setAsDefaultProtocolClient(${JSON.stringify(scheme)},process.execPath)
    handle(process.argv)
    if (!cold) {
      service.sendReminder({id:${JSON.stringify(roundId)},content:'Abandon 便签提醒专项测试（临时测试通知）'},error=>{record({kind:'failed',error:String(error)});app.exit(1)})
      service.reminders.get(${JSON.stringify(roundId)}).on('show',()=>record({kind:'shown'}))
    }
  })
  setTimeout(()=>{record({kind:'timeout'});app.exit(1)},25000)
}
`
buildSync({
  stdin: { contents: code, resolveDir: process.cwd(), sourcefile: 'reminder-probe.js' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(appRoot, 'main.cjs')
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, [], { env, windowsHide: true, stdio: 'inherit' })
const events = () =>
  fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(predicate, label) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (predicate()) return
    await wait(80)
  }
  throw new Error('Timeout: ' + label + ' ' + JSON.stringify(events()))
}
function activate(action) {
  const args =
    action === 'cleanup'
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.resolve('tests/helpers/reminder-activation.ps1'),
          '-ExecutablePath',
          exe,
          '-AppId',
          appId,
          '-Action',
          action
        ]
      : [
          '-NoProfile',
          '-Command',
          `Start-Process -FilePath '${scheme}://notification/${action === 'preset' ? 'snooze' : 'custom'}?round=${roundId}${action === 'preset' ? '&minutes=30' : ''}' -WindowStyle Hidden`
        ]
  const result = spawnSync('powershell.exe', args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000
  })
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''))
}
async function run() {
  try {
    await until(() => events().some((e) => e.kind === 'shown'), 'native toast accepted')
    await wait(600)
    activate('preset')
    await until(() => events().some((e) => e.kind === 'action' && !e.cold), 'warm activation')
    await until(() => child.exitCode !== null, 'warm process exit')
    await wait(2500)
    assert.deepEqual(events().find((e) => e.kind === 'action').payload, {
      id: roundId,
      action: 'snooze',
      minutes: 30
    })
    activate('custom')
    await until(() => events().some((e) => e.kind === 'action' && e.cold), 'protocol cold start')
    assert.deepEqual(events().find((e) => e.kind === 'action' && e.cold).payload, {
      id: roundId,
      action: 'custom'
    })
    await wait(1000)
    const evidence = path.resolve('docs/testing/evidence/note-reminders/native-activation.json')
    fs.writeFileSync(
      evidence,
      JSON.stringify(
        {
          appId,
          events: events(),
          tested:
            'Windows toast accepted; real protocol warm preset and cold custom callbacks; no UI click'
        },
        null,
        2
      )
    )
    activate('cleanup')
    console.log(
      'REMINDER_NATIVE_ACCEPTANCE_OK: toast accepted, warm preset=30, cold custom, isolated registration removed'
    )
  } catch (error) {
    console.error(error)
    console.error('Isolated probe retained for diagnosis: ' + root)
    process.exitCode = 1
  }
}
run()
