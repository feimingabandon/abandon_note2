import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectImageDecodeBudget,
  assertImageDimensions,
  IMAGE_DECODE_LIMITS,
  IMAGE_PREVIEW_LIMITS,
  inspectImagePreviewBudget
} from './image-decode-budget.js'
import { imageFileVersion } from './image-decode-child.js'
import { imagePreviewMime, readImagePreviewSource } from './image-preview-reader.js'
import { imagePreviewPage } from './image-preview-renderer.js'

const fail = (code) => Object.assign(new Error(code), { code })

function previewPreload() {
  const directory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(directory, '..', '..', 'preload', 'image-preview.cjs'),
    join(directory, '..', 'preload', 'image-preview.js')
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) throw fail('IMAGE_PREVIEW_PRELOAD_MISSING')
  return path
}

async function runPreviewRenderer(input) {
  // File pages retain the secure-context capability already verified for
  // ImageDecoder. The fixed HTML belongs to this child's private profile.
  const page = join(app.getPath('userData'), 'image-preview.html')
  await writeFile(page, imagePreviewPage(), { flag: 'wx' })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: previewPreload()
    }
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
  const accept = (event) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
      throw fail('IMAGE_PREVIEW_INVALID_SENDER')
  }
  let inputSent = false
  const outcome = new Promise((done, reject) => {
    ipcMain.handle('image-preview-input', (event) => {
      accept(event)
      if (inputSent) throw fail('IMAGE_PREVIEW_INPUT_CONSUMED')
      inputSent = true
      return input
    })
    ipcMain.handle('image-preview-complete', (event, response) => {
      accept(event)
      done(response)
      return true
    })
    contents.once('render-process-gone', () => reject(fail('IMAGE_PREVIEW_RENDERER_EXIT')))
    window.once('closed', () => reject(fail('IMAGE_PREVIEW_WINDOW_CLOSED')))
  })
  // Observe a renderer crash even if initial navigation has not completed yet.
  void outcome.catch(() => {})
  try {
    await window.loadFile(page)
    const response = await outcome
    if (!response?.ok) throw fail(response?.error?.code || 'IMAGE_PREVIEW_FAILED')
    assertImageDimensions(response.value?.width, response.value?.height)
    return response.value
  } finally {
    ipcMain.removeHandler('image-preview-input')
    ipcMain.removeHandler('image-preview-complete')
    if (!window.isDestroyed()) window.destroy()
  }
}

async function preview(request) {
  if (!['original', 'thumbnail'].includes(request.purpose))
    throw fail('IMAGE_PREVIEW_INVALID_REQUEST')
  const { payload: bytes, version } = await readImagePreviewSource(request.source)
  let header
  try {
    header = inspectImagePreviewBudget(bytes)
  } catch (error) {
    const prefix = bytes.toString('utf8', 0, 4096).trimStart()
    const xml =
      prefix.startsWith('<') ||
      (bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff)
    if (error.code !== 'IMAGE_FORMAT_UNSUPPORTED' || !xml) throw error
    // SVG's real root is parsed in the fixed sandbox, never as application HTML.
    header = { format: 'svg' }
  }
  const mime = imagePreviewMime(header.format)
  const rendered =
    request.purpose === 'thumbnail' || header.format === 'svg'
      ? await runPreviewRenderer({
          bytes,
          header,
          mime,
          purpose: request.purpose,
          size: request.size,
          limits: IMAGE_PREVIEW_LIMITS
        })
      : { width: header.width, height: header.height }
  return {
    ...rendered,
    format: header.format,
    mime,
    version,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}
const profile = process.env.ABANDON_IMAGE_DECODER_PROFILE
if (!profile || typeof process.send !== 'function') app.exit(1)
else {
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.disableHardwareAcceleration()
  let admitted = false
  let closing = false
  process.once('disconnect', () => {
    if (!closing) app.exit(1)
  })
  process.on('message', async (request) => {
    if (admitted) return
    admitted = true
    let response
    try {
      if (
        !request ||
        typeof request.id !== 'string' ||
        request.id.length !== 36 ||
        (request.mode === undefined &&
          (typeof request.path !== 'string' || resolve(request.path) !== request.path)) ||
        (request.mode !== undefined && request.mode !== 'preview') ||
        !Number.isInteger(request.size) ||
        request.size < 32 ||
        request.size > 512
      )
        throw fail('IMAGE_DECODE_INVALID_REQUEST')
      if (request.mode === 'preview') {
        response = { id: request.id, type: 'result', ok: true, value: await preview(request) }
      } else {
        const file = await open(request.path, 'r')
        let bytes, version
        try {
          const before = await file.stat({ bigint: true })
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size <= 0n ||
            before.size > BigInt(IMAGE_DECODE_LIMITS.maxBytes)
          )
            throw fail('IMAGE_DECODE_FILE_BUDGET')
          bytes = Buffer.alloc(Number(before.size))
          let offset = 0
          while (offset < bytes.length) {
            const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
            if (!bytesRead) throw fail('IMAGE_DECODE_FILE_CHANGED')
            offset += bytesRead
          }
          const after = await file.stat({ bigint: true })
          version = imageFileVersion(before)
          if (version !== imageFileVersion(after)) throw fail('IMAGE_DECODE_FILE_CHANGED')
        } finally {
          await file.close()
        }
        // The exact admitted bytes are decoded once. No path-based second read is allowed.
        const header = inspectImageDecodeBudget(bytes)
        const image = nativeImage.createFromBuffer(bytes)
        if (image.isEmpty()) throw fail('IMAGE_DECODE_EMPTY')
        const { width, height } = image.getSize()
        assertImageDimensions(width, height)
        if (
          !(
            (width === header.width && height === header.height) ||
            (height === header.width && width === header.height)
          )
        )
          throw fail('IMAGE_DECODE_DIMENSIONS_CHANGED')
        const thumbnail =
          width >= height
            ? image.resize({ width: Math.min(width, request.size), quality: 'good' })
            : image.resize({ height: Math.min(height, request.size), quality: 'good' })
        const data = thumbnail.toDataURL()
        if (!data.startsWith('data:image/png;base64,') || data.length > 2 * 1024 * 1024)
          throw fail('IMAGE_DECODE_OUTPUT_BUDGET')
        response = {
          id: request.id,
          type: 'result',
          ok: true,
          value: { width, height, data, version, bytes: bytes.length }
        }
      }
    } catch (error) {
      response = {
        id: request?.id,
        type: 'result',
        ok: false,
        error: {
          code: error.code || 'IMAGE_DECODE_FAILED',
          message: String(error.message).slice(0, 240)
        }
      }
    }
    process.send(response, (error) => {
      closing = true
      if (error) app.exit(1)
      else app.quit()
    })
  })
  void app.whenReady().then(() => process.send({ type: 'ready' }))
}
