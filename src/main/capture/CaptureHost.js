import { EventEmitter } from 'node:events'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class CaptureHost extends EventEmitter {
  constructor({ directory, root, logger }) {
    super()
    Object.assign(this, { directory, root, logger })
    this.socket = null
    this.job = null
    this.starting = null
    this.stopping = false
    this.ready = false
  }
  async start() {
    if (this.stopping) throw new Error('截图组件正在退出')
    if (this.ready) return
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }
  async launch() {
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
    const token = randomBytes(32).toString('hex')
    const name = `abandon-capture-${randomBytes(16).toString('hex')}`
    const error = [0]
    this.job = this.native.launch(
      join(this.directory, 'AbandonCapture.exe'),
      name,
      token,
      this.root,
      error
    )
    if (!this.job) throw new Error(`截图受控进程启动失败 (${error[0]})`)
    this.pid = this.native.pid(this.job)
    try {
      const deadline = Date.now() + 10000
      while (!this.socket) {
        if (this.stopping || !this.native.running(this.job) || Date.now() > deadline)
          throw new Error('截图引擎启动超时或异常退出')
        this.socket = await new Promise((resolve) => {
          const socket = net.createConnection(`\\\\.\\pipe\\${name}`)
          socket.once('connect', () => {
            socket.removeAllListeners('error')
            resolve(socket)
          })
          socket.once('error', () => {
            socket.destroy()
            resolve(null)
          })
        })
        if (!this.socket) await delay(80)
      }
      let buffer = ''
      this.socket.setEncoding('utf8')
      this.socket.on('error', (err) => this.fail(err))
      this.socket.on('close', () => this.fail(new Error('截图引擎已退出，临时贴图已关闭')))
      this.socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer) > 65536) return this.fail(new Error('截图协议消息超限'))
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'),
            line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          try {
            const message = JSON.parse(line)
            if (message.type === 'ready' && message.version === 1) this.ready = true
            this.emit('message', message)
          } catch {
            this.fail(new Error('截图协议消息无效'))
            return
          }
        }
      })
      this.send({ type: 'hello', version: 1, token })
      while (!this.ready) {
        if (!this.job || Date.now() > deadline || this.stopping) throw new Error('截图协议握手失败')
        await delay(30)
      }
      this.logger?.info?.('capture.host-ready', '截图引擎已就绪', { pid: this.pid, version: 1 })
    } catch (err) {
      this.closeOwned()
      throw err
    }
  }
  send(message) {
    if (message.type === 'capture' && this.job) this.native.allowForeground(this.job)
    if (!this.socket || this.socket.destroyed) throw new Error('截图引擎连接不可用')
    const body = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(body) > 65536) throw new Error('截图协议消息超限')
    this.socket.write(body)
  }
  fail(error) {
    const hadJob = Boolean(this.job)
    this.closeOwned()
    if (hadJob && !this.stopping) this.emit('failure', error)
  }
  closeOwned() {
    this.ready = false
    const socket = this.socket
    this.socket = null
    socket?.removeAllListeners()
    socket?.destroy()
    if (this.job) {
      this.native.close(this.job)
      this.job = null
    }
  }
  async dispose() {
    this.stopping = true
    if (this.socket) {
      try {
        this.send({ type: 'shutdown' })
      } catch {
        /* already disconnected */
      }
    }
    const deadline = Date.now() + 2000
    while (this.job && this.native.running(this.job) && Date.now() < deadline) await delay(30)
    this.closeOwned()
  }
}
