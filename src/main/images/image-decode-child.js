import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { assertImageDimensions, IMAGE_DECODE_LIMITS } from './image-decode-budget.js'
import { createImageDecodeProcessJob } from './image-decode-process-job.js'

export const IMAGE_DECODER_FLAG = '--abandon-image-decoder'
export const IMAGE_DECODER_GATE_FLAG = '--abandon-image-decode-gate'
export const imageFileVersion = (value) =>
  ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].map((key) => String(value[key])).join(':')

const failure = (code, message = code) => Object.assign(new Error(message), { code })

function validateDecodeResult(value) {
  assertImageDimensions(value?.width, value?.height)
  if (
    typeof value.data !== 'string' ||
    !value.data.startsWith('data:image/png;base64,') ||
    value.data.length > 2 * 1024 * 1024 ||
    typeof value.version !== 'string' ||
    value.version.length > 256 ||
    !Number.isInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > IMAGE_DECODE_LIMITS.maxBytes
  )
    throw failure('IMAGE_DECODER_INVALID_RESULT')
  return value
}

export function resolveImageDecoderEntry(app) {
  const directory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(directory, 'image-decode-entry.mjs'),
    join(directory, 'image-decode.js'),
    join(directory, '..', 'image-decode.js'),
    join(app.getAppPath(), 'out', 'main', 'image-decode.js')
  ]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (!entry) throw failure('IMAGE_DECODER_ENTRY_MISSING')
  return entry
}

export function resolveImageDecoderGate(app) {
  const directory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(directory, 'image-decode-gate.cjs'),
    join(directory, 'image-decode-gate.js'),
    join(directory, '..', 'image-decode-gate.js'),
    join(app.getAppPath(), 'out', 'main', 'image-decode-gate.js')
  ]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (!entry) throw failure('IMAGE_DECODER_GATE_MISSING')
  return entry
}

/** One Job owns one decode process tree; no product windows, DB or logger are loaded. */
export function startImageDecodeChild(
  payload,
  {
    app,
    entry,
    gateEntry,
    onDiagnostic = () => {},
    onOutput = () => {},
    validateResult = validateDecodeResult,
    createProcessJob = createImageDecodeProcessJob,
    removeProfile = (target) => rm(target, { recursive: true })
  } = {}
) {
  let child
  let processJob
  let jobAttached = false
  let jobClosed = false
  let terminationRequested = false
  let decoderPid
  let cancelled = false
  let response
  let ownerError
  let profile
  let profileParent
  let output = ''
  let resolveResult, rejectResult, resolveClosed, rejectClosed
  const result = new Promise((done, reject) => {
    resolveResult = done
    rejectResult = reject
  })
  const closed = new Promise((done, reject) => {
    resolveClosed = done
    rejectClosed = reject
  })
  const id = randomUUID()
  const diagnostic = (value) => {
    try {
      onDiagnostic(value)
    } catch {
      // Diagnostics cannot break the process owner's exit/cleanup sequence.
    }
  }
  function terminateOwnedProcess() {
    if (!child) return
    if (processJob && jobAttached && !jobClosed) {
      if (terminationRequested) return
      processJob.terminate(1)
      terminationRequested = true
    } else if (
      !jobAttached &&
      child.exitCode === null &&
      child.signalCode === null &&
      !child.kill()
    )
      throw failure('IMAGE_DECODER_CANCEL_UNCONFIRMED')
  }
  function cancelOwnedProcess() {
    cancelled = true
    terminateOwnedProcess()
  }
  async function cleanupProfile() {
    if (!profile) return
    // Only the directory returned by our own mkdtemp is eligible for recursive removal.
    const target = resolve(profile)
    if (
      dirname(target) !== profileParent ||
      !target.startsWith(join(profileParent, 'abandon-image-decode-')) ||
      (await lstat(target)).isSymbolicLink() ||
      resolve(await realpath(target)) !== target
    )
      throw failure('IMAGE_DECODER_PROFILE_OWNERSHIP')
    await removeProfile(target)
  }
  async function finish(code, signal, spawnError) {
    let cleanupError
    let jobCleanupError
    if (processJob) {
      try {
        await processJob.waitForEmpty({ timeoutMs: 2000, pollIntervalMs: 10 })
        processJob.close()
        jobClosed = true
        diagnostic({
          code: 'IMAGE_DECODER_JOB_EMPTY',
          id,
          pid: child?.pid,
          decoderPid,
          activeProcesses: 0,
          jobClosed: true
        })
      } catch (error) {
        // Keep the first failure even if the required emergency teardown succeeds.
        cleanupError = error
        jobCleanupError = error
        diagnostic({ code: 'IMAGE_DECODER_JOB_CLEANUP_FAILED', error, id, pid: child?.pid })
        try {
          terminateOwnedProcess()
          await processJob.waitForEmpty({ timeoutMs: 2000, pollIntervalMs: 10 })
          processJob.close()
          jobClosed = true
          diagnostic({
            code: 'IMAGE_DECODER_JOB_EMPTY',
            id,
            pid: child?.pid,
            decoderPid,
            activeProcesses: 0,
            jobClosed: true,
            cleanupError: error
          })
        } catch (teardownError) {
          // Unconfirmed resources retain their capacity and Job ownership.
          diagnostic({
            code: 'IMAGE_DECODER_JOB_TEARDOWN_FAILED',
            error: teardownError,
            firstError: error,
            id,
            pid: child?.pid
          })
          rejectResult(spawnError || ownerError || error)
          rejectClosed(teardownError)
          return
        }
      }
    }
    let profileCleanupError
    try {
      await cleanupProfile()
    } catch (error) {
      profileCleanupError = error
      cleanupError ||= error
      diagnostic({ code: 'IMAGE_DECODER_PROFILE_CLEANUP', error, profile })
    }
    // File cleanup failure stays visible; real process-tree termination owns execution capacity.
    if (spawnError || ownerError || jobCleanupError)
      rejectResult(spawnError || ownerError || jobCleanupError)
    else if (cancelled) rejectResult(failure('IMAGE_DECODE_CANCELLED'))
    else if (code !== 0 || signal)
      rejectResult(spawnError || failure('IMAGE_DECODER_EXIT', output || `Exit ${code}/${signal}`))
    else if (!response) rejectResult(failure('IMAGE_DECODER_NO_RESULT'))
    else if (!response.ok) {
      diagnostic({ code: response.error?.code || 'IMAGE_DECODE_REJECTED', error: response.error })
      resolveResult(null)
    } else {
      try {
        resolveResult(validateResult(response.value))
      } catch (error) {
        rejectResult(error)
      }
    }
    resolveClosed({
      code,
      signal,
      processTree: { activeProcesses: 0, jobClosed },
      profileCleanup: profileCleanupError ? 'failed' : 'complete',
      ...(cleanupError ? { cleanupError, profile } : {})
    })
  }
  void (async () => {
    try {
      profileParent = resolve(await realpath(tmpdir()))
      profile = await mkdtemp(join(profileParent, 'abandon-image-decode-'))
      if (cancelled) return finish(null, null, failure('IMAGE_DECODE_CANCELLED'))
      const env = { ...process.env, ABANDON_IMAGE_DECODER_PROFILE: profile }
      for (const key of Object.keys(env))
        if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase()))
          delete env[key]
      env.ELECTRON_RUN_AS_NODE = '1'
      const inheritedPath =
        Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
      env.PATH = [
        dirname(process.execPath),
        ...inheritedPath.split(';').filter((part) => !/volta/i.test(part))
      ].join(';')
      const args = app.isPackaged
        ? [IMAGE_DECODER_FLAG]
        : [entry || resolveImageDecoderEntry(app), IMAGE_DECODER_FLAG]
      // Redirect Chromium's profile before JS startup too; no shared product profile is opened.
      args.push(`--user-data-dir=${profile}`, '--disable-gpu', '--disable-software-rasterizer')
      const gate = gateEntry || resolveImageDecoderGate(app)
      processJob = createProcessJob()
      child = spawn(process.execPath, [gate, IMAGE_DECODER_GATE_FLAG], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      diagnostic({ code: 'IMAGE_DECODER_STARTED', pid: child.pid, id, profile })
      for (const [name, stream] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr]
      ]) {
        stream.on('data', (bytes) => {
          output = (output + bytes.toString()).slice(-16384)
          try {
            onOutput({ stream: name, bytes, pid: child.pid, id })
          } catch (error) {
            diagnostic({ code: 'IMAGE_DECODER_OUTPUT_OBSERVER_FAILED', error })
          }
        })
        stream.on('error', (error) => diagnostic({ code: 'IMAGE_DECODER_OUTPUT_ERROR', error }))
      }
      let spawnError
      let sent = false
      let launched = false
      const sendFailure = (error) => {
        if (cancelled) return
        spawnError ||= error
        diagnostic({ code: 'IMAGE_DECODER_GATE_FAILED', error, id })
        try {
          cancelOwnedProcess()
        } catch (cancelError) {
          rejectResult(error)
          rejectClosed(cancelError)
        }
      }
      const send = (message) => {
        try {
          child.send(message, (error) => {
            if (error) sendFailure(error)
          })
        } catch (error) {
          sendFailure(error)
        }
      }
      child.on('error', (error) => {
        spawnError = error
      })
      child.on('message', (event) => {
        if (cancelled) return
        if (event?.type === 'image-decode-gate-ready' && !launched) {
          try {
            if (
              !jobAttached ||
              event.mode !== 'electron-run-as-node' ||
              event.processType !== null ||
              event.pid !== child.pid ||
              event.electronVersion !== process.versions.electron ||
              !processJob.contains(child.pid)
            )
              throw failure('IMAGE_DECODER_GATE_MODE_INVALID')
            launched = true
            send({ type: 'image-decode-gate-launch', token: id, args })
          } catch (error) {
            sendFailure(error)
          }
          return
        }
        if (event?.type === 'image-decode-gate-launched') {
          try {
            if (event.token !== id || !processJob.contains(event.pid))
              throw failure('IMAGE_DECODER_JOB_MEMBERSHIP')
            decoderPid = event.pid
            diagnostic({
              code: 'IMAGE_DECODER_CONTAINED',
              id,
              pid: child.pid,
              decoderPid,
              activeProcesses: processJob.activeProcesses()
            })
          } catch (error) {
            sendFailure(error)
          }
          return
        }
        if (event?.type === 'image-decode-gate-error') {
          sendFailure(failure(event.code || 'IMAGE_DECODER_GATE_FAILED', event.error?.message))
          return
        }
        if (event?.type !== 'image-decode-gate-message') return
        const message = event.message
        if (message?.type === 'ready' && !sent) {
          sent = true
          send({ type: 'image-decode-gate-message', message: { ...payload, id } })
        } else if (message?.id === id && message.type === 'result') response = message
      })
      child.once('close', (code, signal) => {
        diagnostic({
          code: 'IMAGE_DECODER_CLOSED',
          pid: child.pid,
          decoderPid,
          id,
          exitCode: code,
          signal
        })
        void finish(code, signal, spawnError).catch((error) => {
          rejectResult(error)
          rejectClosed(error)
        })
      })
      // This built-in-only Node gate cannot create children until the launch above.
      processJob.attachRoot(child.pid)
      jobAttached = true
      if (cancelled) cancelOwnedProcess()
    } catch (error) {
      ownerError = error
      if (child) {
        diagnostic({ code: 'IMAGE_DECODER_OWNER_FAILED', error })
        // A partially created owner cannot release capacity before its real close.
        try {
          cancelOwnedProcess()
        } catch (cancelError) {
          rejectClosed(cancelError)
          rejectResult(error)
        }
      } else {
        await finish(null, null, error)
      }
    }
  })()
  return {
    result,
    closed,
    cancel() {
      cancelOwnedProcess()
    }
  }
}
