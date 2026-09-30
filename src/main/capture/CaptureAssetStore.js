import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'

export function decodeCaptureAsset(bytes, workerFile) {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(workerFile, { workerData: bytes })
    let replied = false
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('截图图像校验超时'))
    }, 15000)
    worker.once('message', (message) => {
      replied = true
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error))
      else resolveResult(message.result)
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (code || !replied) reject(new Error('截图图像校验工作线程异常'))
    })
  })
}

const UUID = /^[a-f0-9-]{36}$/
export class CaptureAssetStore {
  constructor(root, decode) {
    this.root = resolve(root)
    this.decode = decode
    this.sessions = new Set()
  }
  async create() {
    const id = randomUUID()
    await fs.mkdir(join(this.root, id), { recursive: true })
    this.sessions.add(id)
    return id
  }
  async read(sessionId, assetId) {
    if (!this.sessions.has(sessionId) || !UUID.test(assetId)) throw new Error('截图资产已失效')
    const file = join(this.root, sessionId, `${assetId}.png`)
    if (resolve(await fs.realpath(file)) !== resolve(file)) throw new Error('截图资产路径无效')
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('截图超过 50 MiB 上限')
    const bytes = await fs.readFile(file)
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('截图资产不是 PNG')
    }
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20)
    if (!width || !height || width * height > (128 * 1024 * 1024) / 4)
      throw new Error('截图解码尺寸超限')
    return await this.decode(bytes)
  }
  async release(id) {
    if (!this.sessions.has(id)) return
    await fs.rm(join(this.root, id), { recursive: true, force: true })
    this.sessions.delete(id)
  }
  async dispose() {
    await Promise.all([...this.sessions].map((id) => this.release(id)))
    await fs.rmdir(this.root).catch(() => {})
  }
}
