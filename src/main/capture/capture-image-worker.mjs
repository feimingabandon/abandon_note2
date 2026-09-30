import { parentPort, workerData } from 'node:worker_threads'
import { crc32, inflateSync } from 'node:zlib'

// The native engine exports normalized, non-interlaced 8-bit RGB/RGBA PNGs.
// Every filter is reversible for arbitrary bytes, so validating CRCs, the
// bounded deflate stream, row sizes and filter types proves decodability without
// allocating another RGBA image on Electron's main thread.
export function validateCapturePng(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (
    bytes.length > 50 * 1024 * 1024 ||
    bytes.length < 45 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    throw Error('截图 PNG 无效')
  let offset = 8,
    width,
    height,
    channels,
    ended = false,
    dataEnded = false
  const blocks = []
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset),
      end = offset + 12 + size
    if (end > bytes.length) throw Error('截图 PNG 数据截断')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + size)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw Error('截图 PNG 校验失败')
    if (offset === 8 && type !== 'IHDR') throw Error('截图 PNG 头无效')
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13) throw Error('截图 PNG 头重复或无效')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (!width || !height || width * height > (128 * 1024 * 1024) / 4)
        throw Error('截图解码尺寸超限')
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12])
        throw Error('截图 PNG 编码不受支持')
      channels = data[9] === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      if (dataEnded) throw Error('截图 PNG 数据块顺序无效')
      blocks.push(data)
    } else if (type === 'IEND') {
      if (size || end !== bytes.length) throw Error('截图 PNG 尾无效')
      ended = true
    } else {
      if (blocks.length) dataEnded = true
      if (type !== 'PLTE' && !(bytes[offset + 4] & 32)) throw Error('截图 PNG 包含未知关键块')
    }
    offset = end
  }
  if (!ended || !blocks.length) throw Error('截图 PNG 不完整')
  const row = width * channels + 1
  const decoded = inflateSync(Buffer.concat(blocks), { maxOutputLength: row * height })
  if (decoded.length !== row * height) throw Error('截图 PNG 像素不完整')
  for (let y = 0; y < height; y++) if (decoded[y * row] > 4) throw Error('截图 PNG 行过滤无效')
  return {
    width,
    height,
    size: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`
  }
}

if (parentPort && workerData instanceof Uint8Array) {
  try {
    parentPort.postMessage({ result: validateCapturePng(workerData) })
  } catch (error) {
    parentPort.postMessage({ error: error.message })
  }
}
