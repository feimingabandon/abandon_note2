import { performance } from 'node:perf_hooks'
import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads'
import koffi from 'koffi'

export const probeClock = () => performance.timeOrigin + performance.now()

// Test-only bindings. Each Node environment owns its Koffi wrappers; the DLL's
// Engine singleton is still process-wide. The parent never calls it concurrently.
export function createNativeProbe(dllPath, expectedAbi) {
  const library = koffi.load(dllPath)
  const abi = library.func('int AbandonNative_GetAbiVersion()')()
  if (abi !== expectedAbi) throw new Error(`Prototype ABI mismatch: ${abi} != ${expectedAbi}`)
  const native = {
    initialize: library.func('int Blur_Init(uintptr_t)'),
    destroy: library.func('void Blur_Destroy()'),
    initialized: library.func('int Blur_IsInitialized()'),
    healthy: library.func('int Blur_IsHealthy()'),
    errorCode: library.func('int Blur_GetLastErrorCode()'),
    errorMessage: library.func('str Blur_GetLastErrorMessage()'),
    failureJson: library.func('str Blur_GetLastFailureJson()')
  }
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const currentThread = kernel.func('uint32_t GetCurrentThreadId()')
  const currentProcess = kernel.func('uintptr_t GetCurrentProcess()')
  const sleep = kernel.func('void Sleep(uint32_t)')
  const openThread = kernel.func('uintptr_t OpenThread(uint32_t, int, uint32_t)')
  const wait = kernel.func('uint32_t WaitForSingleObject(uintptr_t, uint32_t)')
  const close = kernel.func('int CloseHandle(uintptr_t)')
  const handleCount = kernel.func('int GetProcessHandleCount(uintptr_t, _Out_ uint32_t *)')
  const guiResources = user.func('uint32_t GetGuiResources(uintptr_t, uint32_t)')
  const find = user.func('uintptr_t FindWindowExA(uintptr_t, uintptr_t, str, str)')
  const getOwner = user.func('uint32_t GetWindowThreadProcessId(uintptr_t, _Out_ uint32_t *)')
  const isWindow = user.func('int IsWindow(uintptr_t)')

  function overlays() {
    const found = []
    let after = 0n
    for (let count = 0; count < 64; count++) {
      const value = BigInt(find(0n, after, 'BlurOverlayWindow', null))
      if (value === 0n) return found
      const pid = [0]
      const tid = getOwner(value, pid)
      if (pid[0] === process.pid) found.push({ hwnd: value.toString(), pid: pid[0], tid })
      after = value
    }
    throw new Error('Prototype overlay observation did not reach the end')
  }

  return {
    // Keep wrappers/libraries alive until every owned STA and the worker close.
    library,
    abi,
    native,
    currentThread,
    sleep,
    overlays,
    isWindow: (hwnd) => Boolean(isWindow(BigInt(hwnd))),
    openSta: (tid) => BigInt(openThread(0x100000 | 0x0800, 0, tid)),
    staExited: (handle) => wait(handle, 0) === 0,
    closeHandle: (handle) => close(handle) === 1,
    state: () => ({ initialized: native.initialized() === 1, healthy: native.healthy() === 1 }),
    readError: () => ({
      code: native.errorCode(),
      message: native.errorMessage(),
      details: native.failureJson()
    }),
    resources() {
      const count = [0]
      if (!handleCount(currentProcess(), count)) throw new Error('GetProcessHandleCount failed')
      return {
        handles: count[0],
        user: guiResources(currentProcess(), 1),
        gdi: guiResources(currentProcess(), 0)
      }
    }
  }
}

export function measureProbeCall(probe, operation, work) {
  const startedAt = probeClock()
  const value = work()
  const returnedAt = probeClock()
  return {
    operation,
    startedAt,
    returnedAt,
    durationMs: returnedAt - startedAt,
    callerOsThread: probe.currentThread(),
    nodeThreadId: threadId,
    value: value ?? null
  }
}

if (!isMainThread) {
  let probe
  try {
    probe = createNativeProbe(workerData.dllPath, workerData.expectedAbi)
  } catch (error) {
    parentPort.postMessage({ type: 'fatal', error: error.stack || error.message })
    parentPort.close()
  }
  if (probe) {
    let tail = Promise.resolve()
    let active = 0
    let maximumActive = 0
    let commands = 0
    let stopping = false
    const gates = new Map()
    const releases = new Map()
    const entries = []
    const emit = (value) => parentPort.postMessage({ ...value, at: probeClock() })
    const destroy = () => measureProbeCall(probe, 'Blur_Destroy', () => probe.native.destroy())
    const terminal = () => ({ ...probe.state(), overlays: probe.overlays() })
    function waitForRelease(id) {
      if (releases.has(id)) {
        const result = releases.get(id)
        releases.delete(id)
        return Promise.resolve(result)
      }
      return new Promise((resolve) => gates.set(id, resolve))
    }

    async function run(message) {
      active++
      maximumActive = Math.max(maximumActive, active)
      const enteredAt = probeClock()
      emit({ type: 'entered', id: message.id, operation: message.operation, active })
      let result
      try {
        if (message.operation === 'sleep-control') {
          result = {
            controlOnly: true,
            call: measureProbeCall(probe, 'kernel32.Sleep(120)', () => probe.sleep(120))
          }
        } else if (message.operation === 'invalid-init') {
          const call = measureProbeCall(probe, 'Blur_Init(invalid HWND)', () =>
            probe.native.initialize(0n)
          )
          const error = probe.readError()
          result = { call, error, cleanup: destroy(), terminal: terminal() }
        } else if (message.operation === 'init') {
          const call = measureProbeCall(probe, 'Blur_Init', () =>
            probe.native.initialize(BigInt(message.hwnd))
          )
          const error = call.value === 1 ? null : probe.readError()
          const candidate = { call, error, ...probe.state(), overlays: probe.overlays() }
          if (message.holdResult && call.value === 1) {
            // This gate is AFTER the real FFI return. It tests delivery ownership,
            // never interruption or cancellation inside the synchronous export.
            emit({ type: 'held', id: message.id, generation: message.generation, candidate })
            const release = await waitForRelease(message.id)
            if (release.cancelled !== true) throw new Error('Held prototype Init must be retired')
            result = {
              candidate,
              retired: true,
              cancellationPhase: 'after-native-return-before-result-delivery',
              cleanup: destroy(),
              terminal: terminal()
            }
          } else result = { candidate, retired: false }
        } else if (message.operation === 'destroy') {
          result = { call: destroy(), terminal: terminal() }
        } else if (message.operation === 'stop') {
          result = { cleanup: destroy(), terminal: terminal() }
        } else throw new Error('Unknown prototype operation')
        const returnedAt = probeClock()
        entries.push({ id: message.id, operation: message.operation, enteredAt, returnedAt })
        emit({
          type: 'result',
          id: message.id,
          result: { ...result, enteredAt, returnedAt, maximumActive, commands }
        })
        if (message.operation === 'stop') {
          emit({ type: 'stopped', entries, maximumActive, terminal: terminal() })
          parentPort.close()
        }
      } catch (error) {
        emit({ type: 'result', id: message.id, error: error.stack || error.message })
      } finally {
        active--
      }
    }

    parentPort.on('message', (message) => {
      if (message.type === 'release') {
        const resolve = gates.get(message.id)
        if (resolve) {
          gates.delete(message.id)
          resolve(message)
        } else releases.set(message.id, message)
        return
      }
      if (message.type !== 'run' || stopping || ++commands > 16) {
        emit({ type: 'result', id: message.id, error: 'Prototype fixed command limit/protocol' })
        return
      }
      if (message.operation === 'stop') stopping = true
      // The gate is included in this tail: a queued operation cannot bypass an
      // Init whose candidate has not yet been published or actually destroyed.
      tail = tail.then(() => run(message))
    })
    emit({
      type: 'ready',
      abi: probe.abi,
      callerOsThread: probe.currentThread(),
      nodeThreadId: threadId
    })
  }
}
