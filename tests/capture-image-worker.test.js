import { describe, it, expect } from 'vitest'
import { deflateSync, crc32 } from 'node:zlib'
import { validateCapturePng } from '../src/main/capture/capture-image-worker.mjs'
import { decodeCaptureAsset } from '../src/main/capture/CaptureAssetStore.js'

function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12)
  buffer.writeUInt32BE(data.length)
  buffer.write(type, 4)
  data.copy(buffer, 8)
  buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4)
  return buffer
}
function png({ width = 2, height = 2, filter = 0, pixels = null } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(18, 255)
  rows[0] = rows[9] = filter
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', pixels || deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
describe('capture PNG worker', () => {
  it('validates and encodes outside the main thread', async () => {
    const image = png()
    const result = await decodeCaptureAsset(
      image,
      new URL('../src/main/capture/capture-image-worker.mjs', import.meta.url)
    )
    expect(result).toEqual({
      width: 2,
      height: 2,
      size: image.length,
      dataUrl: `data:image/png;base64,${image.toString('base64')}`
    })
  })
  it('rejects corrupt, oversized, truncated and invalid pixel streams', () => {
    const damaged = png()
    damaged[40] ^= 1
    expect(() => validateCapturePng(damaged)).toThrow()
    expect(() => validateCapturePng(png({ width: 100000, height: 100000 }))).toThrow('尺寸超限')
    expect(() => validateCapturePng(png().subarray(0, -12))).toThrow('不完整')
    expect(() => validateCapturePng(png({ filter: 5 }))).toThrow('行过滤无效')
    expect(() => validateCapturePng(png({ pixels: deflateSync(Buffer.alloc(1)) }))).toThrow(
      '像素不完整'
    )
    expect(() => validateCapturePng(png({ pixels: deflateSync(Buffer.alloc(100000)) }))).toThrow()
  })
})
