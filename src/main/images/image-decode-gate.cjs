// This entry must stay built-in-only. Before the owner assigns this Node-mode
// gate to its private Job and sends launch, no code here creates any process.
const { spawn } = require('node:child_process')

const READY = 'image-decode-gate-ready'
const LAUNCH = 'image-decode-gate-launch'
const MESSAGE = 'image-decode-gate-message'
const LAUNCHED = 'image-decode-gate-launched'
const CLOSED = 'image-decode-gate-child-closed'
const ERROR = 'image-decode-gate-error'
const validMode =
  process.platform === 'win32' &&
  process.arch === 'x64' &&
  process.env.ELECTRON_RUN_AS_NODE === '1' &&
  typeof process.type === 'undefined' &&
  typeof process.versions.electron === 'string' &&
  typeof process.send === 'function' &&
  !process.env.NODE_OPTIONS &&
  !process.env.NODE_PATH

if (!validMode) {
  console.error('IMAGE_DECODER_GATE_MODE_INVALID')
  process.exitCode = 1
  if (process.connected) process.disconnect()
} else {
  let child
  let launched = false
  let childClosed = false
  let fault = false
  let terminalCode = 1
  let pendingForwards = 0
  let pendingOutput = 0
  let finished = false
  const serializeError = (error) => ({
    name: error?.name,
    message: error?.message || String(error),
    code: error?.code
  })

  function finishWhenFlushed() {
    if (finished || !childClosed || pendingForwards || pendingOutput) return
    finished = true
    process.exitCode = fault ? 1 : terminalCode
    if (process.connected) process.disconnect()
    // Avoid process.exit(): buffered stdout/stderr must drain normally as well.
  }

  function sendParent(message) {
    if (!process.connected) {
      fault = true
      finishWhenFlushed()
      return
    }
    pendingForwards++
    try {
      process.send(message, (error) => {
        pendingForwards--
        if (error) fault = true
        finishWhenFlushed()
      })
    } catch {
      pendingForwards--
      fault = true
      finishWhenFlushed()
    }
  }

  function fail(code, error) {
    if (finished) return
    fault = true
    sendParent({ type: ERROR, code, error: serializeError(error) })
    if (child && !childClosed) {
      // The owner still owns the entire Job. This best-effort direct stop is not
      // an emptiness claim; the owner terminates/waits for all Job members.
      try {
        child.kill()
      } catch (killError) {
        console.error(killError.stack || killError)
      }
    } else {
      childClosed = true
      finishWhenFlushed()
    }
  }

  function forwardOutput(stream, target) {
    stream.on('data', (bytes) => {
      pendingOutput++
      try {
        target.write(bytes, (error) => {
          pendingOutput--
          if (error) fault = true
          finishWhenFlushed()
        })
      } catch (error) {
        pendingOutput--
        fail('IMAGE_DECODER_GATE_OUTPUT', error)
      }
    })
    stream.on('error', (error) => fail('IMAGE_DECODER_GATE_OUTPUT', error))
  }

  process.once('disconnect', () => {
    if (!finished)
      fail('IMAGE_DECODER_GATE_OWNER_DISCONNECTED', new Error('Owner IPC disconnected'))
  })
  process.on('message', (request) => {
    if (finished || fault) return
    if (request?.type === LAUNCH) {
      if (
        launched ||
        typeof request.token !== 'string' ||
        !request.token ||
        request.token.length > 256 ||
        !Array.isArray(request.args) ||
        request.args.length < 1 ||
        request.args.length > 32 ||
        request.args.some(
          (arg) => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0')
        )
      ) {
        fail('IMAGE_DECODER_GATE_LAUNCH_INVALID', new Error('Invalid or repeated gate launch'))
        return
      }
      launched = true
      const env = { ...process.env }
      for (const key of Object.keys(env))
        if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase()))
          delete env[key]
      try {
        child = spawn(process.execPath, request.args, {
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        })
      } catch (error) {
        fail('IMAGE_DECODER_GATE_SPAWN', error)
        return
      }
      forwardOutput(child.stdout, process.stdout)
      forwardOutput(child.stderr, process.stderr)
      child.on('message', (message) => sendParent({ type: MESSAGE, message }))
      child.once('error', (error) => fail('IMAGE_DECODER_GATE_CHILD_ERROR', error))
      child.once('spawn', () =>
        sendParent({ type: LAUNCHED, pid: child.pid, token: request.token })
      )
      child.once('close', (code, signal) => {
        childClosed = true
        terminalCode = Number.isInteger(code) && code >= 0 && code <= 255 && !signal ? code : 1
        sendParent({ type: CLOSED, pid: child.pid, code, signal, token: request.token })
        finishWhenFlushed()
      })
    } else if (request?.type === MESSAGE && child && !childClosed && child.connected) {
      try {
        child.send(request.message, (error) => {
          if (error) fail('IMAGE_DECODER_GATE_FORWARD', error)
        })
      } catch (error) {
        fail('IMAGE_DECODER_GATE_FORWARD', error)
      }
    } else {
      fail(
        'IMAGE_DECODER_GATE_PROTOCOL',
        new Error('Message arrived outside the decoder gate state')
      )
    }
  })
  sendParent({
    type: READY,
    mode: 'electron-run-as-node',
    processType: null,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    pid: process.pid
  })
}
