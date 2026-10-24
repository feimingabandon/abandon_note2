import { EventEmitter } from 'node:events'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ignoreRetiredSocketError = () => {}

export class CaptureHost extends EventEmitter {
  constructor({ directory, root, logger }) {
    super()
    Object.assign(this, { directory, root, logger })
    this.socket = null
    this.job = null
    this.starting = null
    this.stopping = false
    this.ready = false
    this.operation = null
    this.disposing = null
  }
  start() {
    if (this.stopping) return Promise.reject(new Error('截图组件正在退出'))
    if (this.starting && this.operation && !this.operation.closed) return this.starting
    if (this.ready && this.socket && !this.socket.destroyed) return Promise.resolve()
    if (this.operation) {
      this.fail(new Error('截图引擎连接不可用'), this.operation)
      // A failure listener may have started a replacement synchronously.
      return this.start()
    }

    const operation = {
      job: null,
      pid: null,
      candidate: null,
      socket: null,
      connection: null,
      buffer: '',
      deadlineAt: Date.now() + 10000,
      deadlineTimer: null,
      probeTimer: null,
      retryTimer: null,
      readyScheduled: false,
      closed: false,
      error: null,
      resolve: null,
      reject: null
    }
    const completed = new Promise((resolve, reject) => {
      operation.resolve = resolve
      operation.reject = reject
    })
    const starting = completed
      .then(() => {
        if (!this.owns(operation) || !this.ready)
          throw operation.error || new Error('截图引擎连接不可用')
      })
      .finally(() => {
        if (this.starting === starting) this.starting = null
      })
    this.operation = operation
    this.starting = starting
    try {
      this.launch(operation)
    } catch (error) {
      this.fail(error, operation)
    }
    return starting
  }
  owns(operation) {
    return this.operation === operation && !operation.closed
  }
  launch(operation) {
    if (process.platform !== 'win32') throw new Error('原生截图组件目前仅支持 Windows')
    if (!this.native) {
      const koffi = require('koffi')
      this.library = koffi.load(join(this.directory, 'capture_host.dll'))
      this.native = {
        launch: this.library.func(
          'void* CaptureLaunch(str16, str16, str16, str16, _Out_ uint32_t*)'
        ),
        running: this.library.func('int CaptureRunning(void*)'),
        pid: this.library.func('uint32_t CapturePid(void*)'),
        allowForeground: this.library.func('void CaptureAllowForeground(void*)'),
        close: this.library.func('void CaptureClose(void*)')
      }
    }
    operation.token = randomBytes(32).toString('hex')
    operation.name = `abandon-capture-${randomBytes(16).toString('hex')}`
    const error = [0]
    operation.job = this.native.launch(
      join(this.directory, 'AbandonCapture.exe'),
      operation.name,
      operation.token,
      this.root,
      error
    )
    this.job = operation.job
    if (!operation.job) throw new Error(`截图受控进程启动失败 (${error[0]})`)
    operation.pid = this.native.pid(operation.job)
    this.pid = operation.pid
    operation.deadlineTimer = setTimeout(
      () => {
        this.fail(new Error('截图引擎启动或协议握手超时'), operation)
      },
      Math.max(0, operation.deadlineAt - Date.now())
    )
    operation.probeTimer = setInterval(() => {
      if (!this.owns(operation)) return
      try {
        if (!this.native.running(operation.job))
          this.fail(new Error('截图引擎启动时异常退出'), operation)
      } catch (error) {
        this.fail(error, operation)
      }
    }, 30)
    this.connect(operation)
  }
  connect(operation) {
    if (!this.owns(operation)) return
    if (this.stopping || Date.now() >= operation.deadlineAt) {
      this.fail(new Error('截图引擎启动超时或异常退出'), operation)
      return
    }
    if (!this.native.running(operation.job)) {
      this.fail(new Error('截图引擎启动时异常退出'), operation)
      return
    }
    const socket = net.createConnection(`\\\\.\\pipe\\${operation.name}`)
    const connection = { socket, listeners: null }
    operation.connection = connection
    operation.candidate = socket
    const current = () => this.owns(operation) && operation.connection === connection
    const disconnected = (error) => {
      if (!current()) return
      if (operation.socket === socket) {
        this.fail(error, operation)
        return
      }
      this.retireConnection(operation, connection)
      operation.retryTimer = setTimeout(() => {
        operation.retryTimer = null
        if (!this.owns(operation)) return
        try {
          this.connect(operation)
        } catch (connectError) {
          this.fail(connectError, operation)
        }
      }, 80)
    }
    connection.listeners = {
      connect: () => {
        if (!current()) return
        try {
          if (this.stopping || socket.destroyed) throw new Error('截图引擎连接不可用')
          operation.candidate = null
          operation.socket = socket
          this.socket = socket
          socket.setEncoding('utf8')
          this.send({ type: 'hello', version: 1, token: operation.token })
        } catch (error) {
          this.fail(error, operation)
        }
      },
      error: (error) => disconnected(error),
      close: () => disconnected(new Error('截图引擎已退出，临时贴图已关闭')),
      data: (chunk) => {
        if (!current() || operation.socket !== socket) return
        operation.buffer += chunk.toString('utf8')
        if (Buffer.byteLength(operation.buffer) > 65536) {
          this.fail(new Error('截图协议消息超限'), operation)
          return
        }
        while (current() && operation.buffer.includes('\n')) {
          const index = operation.buffer.indexOf('\n'),
            line = operation.buffer.slice(0, index)
          operation.buffer = operation.buffer.slice(index + 1)
          try {
            const message = JSON.parse(line)
            if (message.type === 'ready' && message.version === 1 && !operation.readyScheduled) {
              operation.readyScheduled = true
              // Finish after the whole synchronous message turn. A later line or
              // same-turn disconnect must invalidate ready before start resolves.
              queueMicrotask(() => {
                if (!current() || this.stopping || socket.destroyed) return
                try {
                  if (!this.native.running(operation.job)) throw new Error('截图引擎启动时异常退出')
                } catch (error) {
                  this.fail(error, operation)
                  return
                }
                if (Date.now() >= operation.deadlineAt) {
                  this.fail(new Error('截图引擎启动或协议握手超时'), operation)
                  return
                }
                this.clearStartupTimers(operation)
                this.ready = true
                operation.resolve()
                this.logger?.info?.('capture.host-ready', '截图引擎已就绪', {
                  pid: operation.pid,
                  version: 1
                })
              })
            }
            this.emit('message', message)
          } catch {
            this.fail(new Error('截图协议消息无效'), operation)
            return
          }
        }
      }
    }
    for (const [event, listener] of Object.entries(connection.listeners)) socket.on(event, listener)
  }
  clearStartupTimers(operation) {
    clearTimeout(operation.deadlineTimer)
    clearInterval(operation.probeTimer)
    clearTimeout(operation.retryTimer)
    operation.deadlineTimer = null
    operation.probeTimer = null
    operation.retryTimer = null
  }
  retireConnection(operation, connection) {
    if (operation.connection !== connection) return
    operation.connection = null
    operation.candidate = null
    operation.socket = null
    if (this.operation === operation && this.socket === connection.socket) this.socket = null
    // A discarded socket may still deliver its queued native error. Keep a
    // stateless sink, rather than a listener retaining this operation or host.
    connection.socket.on('error', ignoreRetiredSocketError)
    for (const [event, listener] of Object.entries(connection.listeners))
      connection.socket.removeListener(event, listener)
    connection.socket.destroy()
  }
  send(message) {
    const operation = this.operation
    if (!operation || !this.owns(operation) || !operation.socket || operation.socket.destroyed)
      throw new Error('截图引擎连接不可用')
    const body = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(body) > 65536) throw new Error('截图协议消息超限')
    if (message.type === 'capture' && operation.job) this.native.allowForeground(operation.job)
    operation.socket.write(body)
  }
  fail(error, operation = this.operation) {
    if (!operation || !this.owns(operation)) return
    const hadConnection = Boolean(operation.socket)
    this.closeOwned(operation, error)
    if (hadConnection && !this.stopping) this.emit('failure', error)
  }
  closeOwned(operation = this.operation, error = new Error('截图引擎连接已关闭')) {
    if (!operation || operation.closed) return
    operation.closed = true
    operation.error = error
    this.clearStartupTimers(operation)
    if (operation.connection) this.retireConnection(operation, operation.connection)
    const job = operation.job
    operation.job = null
    if (this.operation === operation) {
      this.operation = null
      this.ready = false
      this.socket = null
      this.job = null
    }
    try {
      if (job) this.native.close(job)
    } finally {
      operation.reject(error)
    }
  }
  dispose() {
    if (this.disposing) return this.disposing
    this.stopping = true
    const operation = this.operation
    if (!operation) return Promise.resolve()
    if (!this.ready) {
      this.closeOwned(operation, new Error('截图组件正在退出'))
      return Promise.resolve()
    }
    this.disposing = this.shutdown(operation)
    return this.disposing
  }
  async shutdown(operation) {
    try {
      try {
        this.send({ type: 'shutdown' })
      } catch {
        /* already disconnected */
      }
      const deadline = Date.now() + 2000
      while (
        this.owns(operation) &&
        operation.job &&
        this.native.running(operation.job) &&
        Date.now() < deadline
      )
        await delay(Math.min(30, deadline - Date.now()))
    } finally {
      this.closeOwned(operation, new Error('截图组件正在退出'))
    }
  }
}
