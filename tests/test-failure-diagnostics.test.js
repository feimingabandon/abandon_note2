import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import diagnostics from '../scripts/test-failure-diagnostics.cjs'

const roots = []
const controllers = []
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'abandon-failure-diagnostics-'))
  roots.push(root)
  return root
}
function fakeCollector() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = vi.fn()
  child.unref = vi.fn()
  return child
}
function controller({
  collect = vi.fn(async () => ({ version: 1, status: 'complete' })),
  ...extra
} = {}) {
  const root = directory()
  const instance = diagnostics.createFailureDiagnostics(
    {
      gui: true,
      directory: root,
      command: process.execPath,
      args: ['tests/owned-case.mjs'],
      spawnedMs: Date.now(),
      pid: 24680,
      cwd: process.cwd(),
      writeEvidence: (name, value) =>
        writeFileSync(join(root, name), JSON.stringify(value), { flag: 'wx' })
    },
    { collect, platform: 'win32', exitPendingMs: 20, ...extra }
  )
  controllers.push(instance)
  return { instance, root, collect }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const item of controllers.splice(0)) await item.finish()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('bounded external Windows failure collection', () => {
  it('marks a hidden Error root and its button as text unavailable, even if UIA traversal completed', () => {
    const result = diagnostics.annotateDialogText({
      version: 1,
      status: 'complete',
      windows: [
        {
          Handle: 1234,
          ProcessId: 5678,
          ClassName: '#32770',
          Text: 'Error',
          Visible: false,
          Children: [{ ClassName: 'Button', Text: '确定' }]
        }
      ],
      dialogAutomation: [
        {
          handle: 1234,
          pid: 5678,
          status: 'complete',
          elements: [
            { controlType: 'ControlType.Window', name: 'Error' },
            { controlType: 'ControlType.Button', name: '确定' }
          ]
        }
      ]
    })
    expect(result.dialogAutomation[0]).toMatchObject({
      status: 'text-unavailable',
      providerStatus: 'complete',
      visible: false,
      textAvailable: false
    })
    expect(result.dialogAutomation[0].reason).toContain('no body text')
  })

  it('distinguishes readable dialog body text from captions and preserves provider failure reasons', () => {
    const window = {
      Handle: 1234,
      ProcessId: 5678,
      ClassName: '#32770',
      Visible: true,
      Children: []
    }
    const read = diagnostics.annotateDialogText({
      windows: [window],
      dialogAutomation: [
        {
          handle: 1234,
          status: 'complete',
          elements: [{ controlType: 'ControlType.Text', name: '对象已销毁' }]
        }
      ]
    })
    expect(read.dialogAutomation[0]).toMatchObject({
      status: 'complete',
      visible: true,
      textAvailable: true
    })
    const unavailable = diagnostics.annotateDialogText({
      windows: [window],
      dialogAutomation: [
        { handle: 1234, status: 'unavailable', reason: 'controlled provider error' }
      ]
    })
    expect(unavailable.dialogAutomation[0]).toMatchObject({
      status: 'text-unavailable',
      providerStatus: 'unavailable',
      reason: 'controlled provider error'
    })
  })

  it('records absent UIA output as unavailable and can retain native Static body text', () => {
    const window = { Handle: 1234, ProcessId: 5678, ClassName: '#32770', Visible: false }
    expect(diagnostics.annotateDialogText({ windows: [window] }).dialogAutomation[0]).toMatchObject(
      {
        status: 'text-unavailable',
        providerStatus: 'not-completed',
        textAvailable: false
      }
    )
    window.Children = [{ ClassName: 'Static', Text: 'known native body' }]
    expect(diagnostics.annotateDialogText({ windows: [window] }).dialogAutomation[0]).toMatchObject(
      {
        status: 'native-only',
        textAvailable: true
      }
    )
  })

  it('preserves a native snapshot if the UIAutomation provider blocks, without changing the failed test', async () => {
    vi.useFakeTimers()
    const child = fakeCollector()
    const spawnProcess = vi.fn(() => child)
    const result = diagnostics.collectWindowsFailure(
      { version: 1, rootPid: 1234 },
      { spawnProcess }
    )
    child.stdout.write(
      JSON.stringify({ version: 1, status: 'partial', windows: [{ Text: 'Error' }] }) + '\n'
    )
    await vi.advanceTimersByTimeAsync(diagnostics.CAPTURE_TIMEOUT_MS)
    expect(await result).toMatchObject({
      status: 'timeout',
      partial: { windows: [{ Text: 'Error' }] }
    })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(spawnProcess.mock.calls[0][1]).toContain('-NonInteractive')
    expect(spawnProcess.mock.calls[0][2].windowsHide).toBe(true)
  })

  it('decodes split UTF-8 dialog text and takes the final structured snapshot', async () => {
    const child = fakeCollector()
    const result = diagnostics.collectWindowsFailure({}, { spawnProcess: () => child })
    child.stdout.write('{"version":1,"status":"partial"}\n')
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, status: 'complete', text: '对象已销毁' }) + '\n'
    )
    const split = bytes.indexOf(Buffer.from('对')) + 1
    child.stdout.write(bytes.subarray(0, split))
    child.stdout.write(bytes.subarray(split))
    child.emit('close', 0, null)
    expect(await result).toMatchObject({
      status: 'complete',
      text: '对象已销毁',
      collector: { code: 0 }
    })
  })

  it('bounds output and retains a preceding native snapshot', async () => {
    const child = fakeCollector()
    const result = diagnostics.collectWindowsFailure({}, { spawnProcess: () => child })
    child.stdout.write('{"version":1,"status":"partial","rootPid":4321}\n')
    child.stdout.write(Buffer.alloc(diagnostics.MAX_OUTPUT_BYTES + 1, 65))
    expect(await result).toMatchObject({ status: 'output-limit', partial: { rootPid: 4321 } })
    expect(child.kill).toHaveBeenCalledOnce()
  })
})

describe('attempt-scoped failure diagnostic scheduling', () => {
  it('collects a still-pending child before its controller can terminate it', async () => {
    const { instance, root, collect } = controller()
    const file = join(root, 'shortcut-stages', 'session', 'gui-exit-events.jsonl')
    mkdirSync(join(root, 'shortcut-stages', 'session'), { recursive: true })
    writeFileSync(file, '{"pid":5678,"event":"finish-start"}\n')
    instance.inspect('shortcut-stages/session/gui-exit-events.jsonl')
    await new Promise((done) => setTimeout(done, 80))
    const result = await instance.finish()
    expect(collect).toHaveBeenCalledOnce()
    expect(collect.mock.calls[0][0]).toMatchObject({
      rootPid: 24680,
      focusPid: 5678,
      runnerPid: process.pid
    })
    expect(result.collections[0]).toMatchObject({ trigger: 'exit-pending', focusPid: 5678 })
    expect(
      JSON.parse(readFileSync(join(root, 'failure-diagnostics-1.json'), 'utf8'))
    ).toMatchObject({ trigger: 'exit-pending' })
  })

  it('does not launch native collection for an ordinary completed shutdown', async () => {
    const { instance, root, collect } = controller()
    const file = join(root, 'gui-exit-events.jsonl')
    writeFileSync(file, '{"pid":5678,"event":"finish-start"}\n')
    instance.inspect('gui-exit-events.jsonl')
    writeFileSync(file, '{"pid":5678,"event":"quit"}\n', { flag: 'a' })
    instance.inspect('gui-exit-events.jsonl')
    await new Promise((done) => setTimeout(done, 60))
    expect(collect).not.toHaveBeenCalled()
  })

  it('keeps a hard collection budget and preserves collector errors as supplemental evidence', async () => {
    const collect = vi.fn(async () => {
      throw new Error('controlled UIA unavailable')
    })
    const { instance } = controller({ collect })
    for (let pid = 100; pid < 110; pid++) await instance.capture('exit-pending', pid)
    instance.exited(null, 'SIGTERM')
    const result = await instance.finish()
    expect(collect).toHaveBeenCalledTimes(diagnostics.MAX_CAPTURES)
    expect(result.root.exit.signal).toBe('SIGTERM')
    expect(result.collections[0].observation).toEqual({
      status: 'unavailable',
      reason: 'controlled UIA unavailable'
    })
  })

  it('does not treat a lifecycle file as process ownership authority', () => {
    const root = directory()
    writeFileSync(join(root, 'gui-exit-events.jsonl'), '{"pid":13579,"event":"finish-start"}\n')
    expect(diagnostics.readExitEvent(root, '../gui-exit-events.jsonl')).toBeNull()
    expect(diagnostics.readExitEvent(root, 'gui-exit-events.jsonl')).toEqual({
      pid: 13579,
      finished: false
    })
    // Only the external collector's launch/parent/creation checks can authorize
    // this hint. No process information or UI is read by the file parser.
  })
})
