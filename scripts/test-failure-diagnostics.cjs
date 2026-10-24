const { spawn } = require('node:child_process')
const { existsSync, lstatSync, readFileSync, realpathSync, watch } = require('node:fs')
const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path')

const CAPTURE_TIMEOUT_MS = 4000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_CAPTURES = 3
const EXIT_PENDING_MS = 2000

function annotateDialogText(snapshot) {
  if (!Array.isArray(snapshot.windows)) return snapshot
  const automation = Array.isArray(snapshot.dialogAutomation) ? snapshot.dialogAutomation : []
  const dialogs = snapshot.windows.filter((window) => window.ClassName === '#32770')
  return {
    ...snapshot,
    dialogAutomation: dialogs.map((window) => {
      const observed = automation.find((item) => item.handle === window.Handle)
      const nativeText = (window.Children || []).some(
        (item) => item.ClassName === 'Static' && typeof item.Text === 'string' && item.Text.trim()
      )
      const providerText = (observed?.elements || []).some(
        (item) =>
          item.controlType === 'ControlType.Text' &&
          [item.name, item.text].some((value) => typeof value === 'string' && value.trim())
      )
      const textAvailable = Boolean(nativeText || providerText)
      return {
        ...(observed || { handle: window.Handle, pid: window.ProcessId, elements: [] }),
        visible: window.Visible === true,
        textAvailable,
        providerStatus: observed?.status || 'not-completed',
        status: textAvailable
          ? observed?.status === 'complete'
            ? 'complete'
            : 'native-only'
          : 'text-unavailable',
        ...(!textAvailable
          ? {
              reason:
                observed?.reason ||
                (observed
                  ? 'The verified dialog exposed no body text; its caption and button labels are insufficient.'
                  : 'UI Automation did not return a dialog result; native body text is unavailable.')
            }
          : {})
      }
    })
  }
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

function readExitEvent(directory, filename) {
  if (basename(filename) !== 'gui-exit-events.jsonl') return null
  const root = realpathSync(directory)
  const file = resolve(directory, filename)
  const child = relative(root, file)
  if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) return null
  let current = root
  for (const part of child.split(sep)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) return null
    if (!samePath(realpathSync(current), current)) return null
  }
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 64 * 1024) return null
  const events = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return [] // The final append may still be in progress.
      }
    })
  const first = events.find((event) => event.event === 'finish-start')
  if (!first || !Number.isSafeInteger(first.pid) || first.pid <= 0) return null
  const finished = events.some((event) => event.pid === first.pid && event.event === 'quit')
  return { pid: first.pid, finished }
}

/** A separate process can inspect a native modal even when the test's JS loop is blocked. */
function collectWindowsFailure(request, { spawnProcess = spawn } = {}) {
  return new Promise((done) => {
    const executable = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    let collector
    let timer
    let settled = false
    const stdout = []
    const stderr = []
    let outputBytes = 0
    const lastSnapshot = () => {
      const lines = Buffer.concat(stdout)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\r?\n/)
      for (const line of lines.reverse()) {
        try {
          const result = JSON.parse(line)
          if (result.version === 1 && typeof result.status === 'string')
            return annotateDialogText(result)
        } catch {
          // A bounded stop can leave the last line incomplete; keep the earlier native snapshot.
        }
      }
      return null
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const stop = (status) => {
      if (settled) return
      collector?.kill()
      collector?.stdout?.destroy()
      collector?.stderr?.destroy()
      collector?.unref()
      finish({
        status,
        reason: 'The read-only diagnostic collector exceeded its bound',
        partial: lastSnapshot()
      })
    }
    try {
      collector = spawnProcess(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(__dirname, 'test-failure-windows.ps1')
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      for (const name of ['stdout', 'stderr']) {
        collector[name].on('data', (chunk) => {
          if (settled) return
          outputBytes += chunk.length
          if (outputBytes > MAX_OUTPUT_BYTES) return stop('output-limit')
          if (name === 'stdout') stdout.push(Buffer.from(chunk))
          else stderr.push(Buffer.from(chunk))
        })
      }
      collector.stdin.on('error', () => {}) // Process exit can close stdin before a request is read.
      collector.once('error', (error) => finish({ status: 'unavailable', reason: error.message }))
      collector.once('close', (code, signal) => {
        if (settled) return
        try {
          const result = lastSnapshot()
          if (!result) throw new Error('No valid collector snapshot')
          finish({
            ...result,
            collector: {
              code,
              signal,
              stderr: Buffer.concat(stderr).toString('utf8').slice(0, 4096)
            }
          })
        } catch {
          finish({ status: 'unavailable', reason: 'Collector did not return JSON', code, signal })
        }
      })
      timer = setTimeout(() => stop('timeout'), CAPTURE_TIMEOUT_MS)
      collector.stdin.end(JSON.stringify(request), 'utf8')
    } catch (error) {
      finish({ status: 'unavailable', reason: error.message })
    }
  })
}

/** Supplemental observations never replace process status, stderr, or the first failure. */
function createFailureDiagnostics(
  { gui, directory, command, args, spawnedMs, pid, cwd, writeEvidence },
  {
    collect = collectWindowsFailure,
    platform = process.platform,
    exitPendingMs = EXIT_PENDING_MS
  } = {}
) {
  const collections = []
  const timers = new Map()
  const requested = new Set()
  let watcher
  let watching = false
  let watchStatus = 'not-started'
  let inFlight = Promise.resolve()
  let attempts = 0
  let rootExitAtMs = null
  let rootExit = null
  const enabled = Boolean(gui && platform === 'win32' && Number.isSafeInteger(pid) && pid > 0)
  const report = () => ({
    status: collections.length ? 'recorded' : enabled ? 'not-requested' : 'not-applicable',
    root: { pid, command, spawnedMs, ...(rootExit ? { exit: rootExit } : {}) },
    watchStatus,
    limits: {
      maxCaptures: MAX_CAPTURES,
      captureTimeoutMs: CAPTURE_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES
    },
    collections
  })
  const capture = (trigger, focusPid = pid) => {
    if (!enabled || attempts >= MAX_CAPTURES) return inFlight
    const key = `${trigger}:${focusPid}`
    if (requested.has(key)) return inFlight
    requested.add(key)
    attempts++
    inFlight = inFlight.then(async () => {
      const entry = { trigger, focusPid, requestedAt: new Date().toISOString() }
      try {
        // A lifecycle PID is only a hint. The collector must independently prove
        // the root launch and every parent/creation-time link before reading UI.
        const observation = await collect({
          version: 1,
          runnerPid: process.pid,
          rootPid: pid,
          command,
          args,
          cwd,
          spawnedMs,
          rootExitAtMs,
          focusPid
        })
        entry.observation = observation
      } catch (error) {
        entry.observation = { status: 'unavailable', reason: error.message }
      }
      entry.finishedAt = new Date().toISOString()
      try {
        const name = `failure-diagnostics-${collections.length + 1}.json`
        writeEvidence(name, entry)
        entry.artifact = name
      } catch (error) {
        entry.writeError = error.message
      }
      collections.push(entry)
    })
    return inFlight
  }
  const inspect = (filename) => {
    if (!watching || !filename) return
    try {
      const event = readExitEvent(directory, String(filename))
      if (!event) return
      if (event.finished) {
        clearTimeout(timers.get(event.pid))
        timers.delete(event.pid)
      } else if (!timers.has(event.pid)) {
        const timer = setTimeout(() => {
          // Reread after the grace period so ordinary short shutdowns do not
          // launch a Windows diagnostic process or disturb performance tests.
          try {
            const latest = readExitEvent(directory, String(filename))
            if (watching && latest && !latest.finished) void capture('exit-pending', latest.pid)
          } catch {
            // Missing/linked child files cannot authorize a capture.
          }
        }, exitPendingMs)
        timers.set(event.pid, timer)
      }
    } catch {
      // Evidence may be atomically replaced or removed while a test shuts down.
    }
  }
  if (enabled && existsSync(directory)) {
    try {
      watching = true
      watcher = watch(directory, { recursive: true }, (_event, filename) => inspect(filename))
      watchStatus = 'enabled'
      watcher.on('error', () => {
        watchStatus = 'unavailable'
        // Timeout/exit capture remains available if filesystem watching is unavailable.
      })
    } catch {
      watching = false
      watchStatus = 'unavailable'
    }
  }
  return {
    capture,
    inspect,
    exited(code, signal) {
      rootExitAtMs ??= Date.now()
      rootExit = { code, signal, atMs: rootExitAtMs }
      if ((code !== 0 || signal) && attempts === 0) void capture('process-exit')
    },
    async finish() {
      watching = false
      watcher?.close()
      for (const timer of timers.values()) clearTimeout(timer)
      await inFlight
      return report()
    }
  }
}

module.exports = {
  collectWindowsFailure,
  createFailureDiagnostics,
  readExitEvent,
  CAPTURE_TIMEOUT_MS,
  MAX_CAPTURES,
  MAX_OUTPUT_BYTES,
  annotateDialogText
}
