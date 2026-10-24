import { describe, expect, it } from 'vitest'
import { crc32, deflateSync } from 'node:zlib'
import {
  IMAGE_DECODE_LIMITS,
  assertImageDimensions,
  inspectImageDecodeBudget
} from '../src/main/images/image-decode-budget.js'
import { MAX_IMAGE_BYTES } from '../src/shared/attachment-rules.js'

const signature = Buffer.from('89504e470d0a1a0a', 'hex')
const pngData = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]))
// A real 4x2 baseline JPEG from the independently validated Chromium fixture.
const baselineJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAbEAACAQUAAAAAAAAAAAAAAAAAAwECBBMjkf/EABUBAQEAAAAAAAAAAAAAAAAAAAUI/8QAGhEAAgIDAAAAAAAAAAAAAAAAAAECBDEzcf/aAAwDAQACEQMRAD8AirZK8Ua6eAAKq6IcRUkss//Z',
  'base64'
)

function chunk(type, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(payload.length + 12)
  result.writeUInt32BE(payload.length)
  result.write(type, 4, 4, 'ascii')
  payload.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4)
  return result
}

function header({
  width = 2,
  height = 1,
  depth = 8,
  color = 6,
  interlace = 0,
  compression = 0,
  filter = 0
} = {}) {
  const result = Buffer.alloc(13)
  result.writeUInt32BE(width)
  result.writeUInt32BE(height, 4)
  result[8] = depth
  result[9] = color
  result[10] = compression
  result[11] = filter
  result[12] = interlace
  return chunk('IHDR', result)
}

function png(parts = [header(), chunk('IDAT', pngData), chunk('IEND')]) {
  return Buffer.concat([signature, ...parts])
}

function segment(marker, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(payload.length + 4)
  result[0] = 0xff
  result[1] = marker
  result.writeUInt16BE(payload.length + 2, 2)
  payload.copy(result, 4)
  return result
}

function frame({ marker = 0xc0, width = 4, height = 2, ids = [1, 2, 3], precision = 8 } = {}) {
  const payload = Buffer.alloc(6 + 3 * ids.length)
  payload[0] = precision
  payload.writeUInt16BE(height, 1)
  payload.writeUInt16BE(width, 3)
  payload[5] = ids.length
  ids.forEach((id, index) => {
    payload[6 + index * 3] = id
    payload[7 + index * 3] = 0x11
  })
  return segment(marker, payload)
}

function scan({ ids = [1, 2, 3], start = 0, end = 63, approximation = 0 } = {}) {
  const payload = Buffer.alloc(4 + 2 * ids.length)
  payload[0] = ids.length
  ids.forEach((id, index) => {
    payload[1 + index * 2] = id
  })
  payload[payload.length - 3] = start
  payload[payload.length - 2] = end
  payload[payload.length - 1] = approximation
  return segment(0xda, payload)
}

// Structural fixtures deliberately do not duplicate a JPEG entropy encoder.
// They exercise preflight only; actual pixel validity remains the decoder's job.
function jpeg(parts = [frame(), scan(), Buffer.from([3, 4, 5])]) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts, Buffer.from([0xff, 0xd9])])
}

function rejected(bytes, code, options) {
  expect(() => inspectImageDecodeBudget(bytes, options)).toThrow(expect.objectContaining({ code }))
}

describe('image decode admission limits', () => {
  it('uses the existing encoded-byte rule and a bounded original-pixel budget', () => {
    expect(IMAGE_DECODE_LIMITS).toEqual({
      maxBytes: MAX_IMAGE_BYTES,
      maxPixels: 32 * 1024 * 1024,
      maxEdge: 16_384,
      maxNodes: 4096
    })
    expect(Object.isFrozen(IMAGE_DECODE_LIMITS)).toBe(true)
    expect(assertImageDimensions(8192, 4096)).toEqual({ width: 8192, height: 4096 })
    expect(assertImageDimensions(16_384, 2048)).toEqual({ width: 16_384, height: 2048 })
    expect(() => assertImageDimensions(8192, 4097)).toThrow(
      expect.objectContaining({ code: 'IMAGE_PIXELS_EXCEEDED' })
    )
    expect(() => assertImageDimensions(16_385, 1)).toThrow(
      expect.objectContaining({ code: 'IMAGE_EDGE_EXCEEDED' })
    )
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid dimensions %s',
    (value) => {
      expect(() => assertImageDimensions(value, 1)).toThrow(
        expect.objectContaining({ code: 'IMAGE_DIMENSIONS_INVALID' })
      )
      expect(() => assertImageDimensions(1, value)).toThrow(
        expect.objectContaining({ code: 'IMAGE_DIMENSIONS_INVALID' })
      )
    }
  )

  it('accepts exactly the encoded-byte bound and refuses the next byte', () => {
    const bytes = png()
    expect(inspectImageDecodeBudget(bytes, { limits: { maxBytes: bytes.length } })).toEqual({
      format: 'png',
      width: 2,
      height: 1
    })
    rejected(bytes, 'IMAGE_BYTES_EXCEEDED', { limits: { maxBytes: bytes.length - 1 } })
    rejected(bytes, 'IMAGE_LIMITS_INVALID', { limits: { maxNodes: 0 } })
    rejected(bytes, 'IMAGE_LIMITS_INVALID', { limits: { maxPixels: Number.NaN } })
  })

  it('reads only the supplied byte view and never rewrites the snapshot', () => {
    const bytes = png()
    const padded = Buffer.concat([Buffer.from([1, 2]), bytes, Buffer.from([3])])
    const before = Buffer.from(padded)
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 2, bytes.length)
    expect(inspectImageDecodeBudget(view)).toEqual({ format: 'png', width: 2, height: 1 })
    expect(padded).toEqual(before)
    rejected(Buffer.alloc(0), 'IMAGE_BYTES_INVALID')
    rejected('not bytes', 'IMAGE_BYTES_INVALID')
    rejected(Buffer.from('GIF89a'), 'IMAGE_FORMAT_UNSUPPORTED')
    rejected(Buffer.from('BM'), 'IMAGE_FORMAT_UNSUPPORTED')
    rejected(Buffer.from('RIFF0000WEBP'), 'IMAGE_FORMAT_UNSUPPORTED')
    rejected(Buffer.from('<svg width="2" height="1"/>'), 'IMAGE_FORMAT_UNSUPPORTED')
  })
})

describe('PNG preflight', () => {
  it.each([
    { depth: 1, color: 0, data: [0, 0x80] },
    { depth: 2, color: 0, data: [0, 0x40] },
    { depth: 4, color: 0, data: [0, 0x10] },
    { depth: 8, color: 0, data: [0, 100] },
    { depth: 16, color: 0, data: [0, 1, 2] },
    { depth: 8, color: 2, data: [0, 1, 2, 3] },
    { depth: 16, color: 2, data: [0, 1, 2, 3, 4, 5, 6] },
    { depth: 8, color: 4, data: [0, 1, 255] },
    { depth: 16, color: 4, data: [0, 1, 2, 255, 255] },
    { depth: 8, color: 6, data: [0, 1, 2, 3, 255] },
    { depth: 16, color: 6, data: [0, 1, 2, 3, 4, 5, 6, 255, 255] }
  ])('admits ordinary depth $depth / color $color PNG', ({ depth, color, data }) => {
    const bytes = png([
      header({ width: 1, height: 1, depth, color }),
      chunk('IDAT', deflateSync(Buffer.from(data))),
      chunk('IEND')
    ])
    expect(inspectImageDecodeBudget(bytes)).toEqual({ format: 'png', width: 1, height: 1 })
  })

  it('retains palette transparency, ancillary metadata and Adam7 headers', () => {
    const indexed = png([
      header({ color: 3, depth: 1 }),
      chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
      chunk('tRNS', Buffer.from([255, 0])),
      chunk('tEXt', Buffer.from('Title\0Two colors')),
      chunk('IDAT', deflateSync(Buffer.from([0, 0x40]))),
      chunk('IEND')
    ])
    expect(inspectImageDecodeBudget(indexed)).toEqual({ format: 'png', width: 2, height: 1 })
    const adam7 = png([
      header({ width: 1, height: 1, interlace: 1 }),
      chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 255]))),
      chunk('IEND')
    ])
    expect(inspectImageDecodeBudget(adam7)).toEqual({ format: 'png', width: 1, height: 1 })
  })

  it.each([1, 2, 4, 8])('admits palette PNG at bit depth %s', (depth) => {
    const bytes = png([
      header({ color: 3, depth }),
      chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
      chunk('IDAT', deflateSync(Buffer.alloc(1 + Math.ceil((2 * depth) / 8)))),
      chunk('IEND')
    ])
    expect(inspectImageDecodeBudget(bytes)).toEqual({ format: 'png', width: 2, height: 1 })
  })

  it('admits grayscale and RGB tRNS without restricting to alpha-channel PNG', () => {
    for (const [color, transparency] of [
      [0, Buffer.alloc(2)],
      [2, Buffer.alloc(6)]
    ]) {
      expect(
        inspectImageDecodeBudget(
          png([
            header({ color }),
            chunk('tRNS', transparency),
            chunk('IDAT', pngData),
            chunk('IEND')
          ])
        )
      ).toEqual({ format: 'png', width: 2, height: 1 })
    }
  })

  it('checks the header budgets before any pixel decode', () => {
    const metadataFixture = (width, height) =>
      png([header({ width, height }), chunk('IDAT', pngData), chunk('IEND')])
    expect(inspectImageDecodeBudget(metadataFixture(8192, 4096))).toEqual({
      format: 'png',
      width: 8192,
      height: 4096
    })
    rejected(metadataFixture(8192, 4097), 'IMAGE_PIXELS_EXCEEDED')
    rejected(metadataFixture(16_385, 1), 'IMAGE_EDGE_EXCEEDED')
    rejected(metadataFixture(0, 1), 'IMAGE_DIMENSIONS_INVALID')
  })

  it('allows consecutive IDAT chunks and enforces the exact structural-node bound', () => {
    const halves = [chunk('IDAT', pngData.subarray(0, 4)), chunk('IDAT', pngData.subarray(4))]
    expect(inspectImageDecodeBudget(png([header(), ...halves, chunk('IEND')])).width).toBe(2)
    const comments = Array.from({ length: 4093 }, () => chunk('tEXt', Buffer.from('a\0b')))
    const exact = [header(), ...comments, chunk('IDAT', pngData), chunk('IEND')]
    expect(inspectImageDecodeBudget(png(exact)).format).toBe('png')
    rejected(png([chunk('tEXt'), ...exact]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(
      png([header(), chunk('tEXt', Buffer.from('c\0d')), ...exact.slice(1)]),
      'IMAGE_STRUCTURE_NODES_EXCEEDED'
    )
  })

  it.each(['acTL', 'fcTL', 'fdAT'])('explicitly rejects unbudgeted APNG chunk %s', (type) => {
    rejected(
      png([header(), chunk(type, Buffer.alloc(8)), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_ANIMATION_UNSUPPORTED'
    )
  })

  it('rejects CRC, chunk boundaries, invalid header fields and trailing content', () => {
    const invalidCrc = png()
    invalidCrc[invalidCrc.length - 1] ^= 1
    rejected(invalidCrc, 'IMAGE_PNG_STRUCTURE_INVALID')
    const truncated = png().subarray(0, -1)
    rejected(truncated, 'IMAGE_PNG_STRUCTURE_INVALID')
    const oversizedChunk = png()
    oversizedChunk.writeUInt32BE(0xffffffff, 8)
    rejected(oversizedChunk, 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(
      png([header({ color: 6, depth: 4 }), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(
      png([header({ interlace: 2 }), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(
      png([header({ compression: 1 }), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(
      png([header({ filter: 1 }), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(Buffer.concat([png(), Buffer.from([0])]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(
      png([header(), header(), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(
      png([header(), chunk('ABCD'), chunk('IDAT', pngData), chunk('IEND')]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(png([header(), chunk('IDAT', pngData)]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(png([header(), chunk('IEND')]), 'IMAGE_PNG_STRUCTURE_INVALID')
  })

  it('rejects palette/transparency mistakes and noncontiguous image data', () => {
    const end = [chunk('IDAT', pngData), chunk('IEND')]
    const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255]))
    rejected(png([header({ color: 3, depth: 1 }), ...end]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(png([header({ color: 0 }), palette, ...end]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(
      png([header({ color: 3, depth: 1 }), palette, palette, ...end]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(
      png([header({ color: 3, depth: 1 }), palette, chunk('tRNS', Buffer.alloc(3)), ...end]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
    rejected(png([header(), chunk('tRNS', Buffer.alloc(1)), ...end]), 'IMAGE_PNG_STRUCTURE_INVALID')
    rejected(
      png([header(), chunk('IDAT', pngData), chunk('tEXt', Buffer.from('a\0b')), ...end]),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
  })

  it('leaves compressed pixel validity to the isolated decoder', () => {
    expect(
      inspectImageDecodeBudget(png([header(), chunk('IDAT', Buffer.from([1])), chunk('IEND')]))
    ).toEqual({ format: 'png', width: 2, height: 1 })
  })
})

describe('JPEG preflight', () => {
  it('admits the independently decoded baseline JPEG', () => {
    expect(inspectImageDecodeBudget(baselineJpeg)).toEqual({ format: 'jpeg', width: 4, height: 2 })
  })

  it.each([0xc0, 0xc1, 0xc2])(
    'admits common SOF marker %s with its valid scan structure',
    (marker) => {
      const scans =
        marker === 0xc2
          ? [scan({ end: 0 }), Buffer.from([1]), scan({ ids: [1], start: 1, end: 63 })]
          : [scan()]
      expect(
        inspectImageDecodeBudget(jpeg([frame({ marker }), ...scans, Buffer.from([2])]))
      ).toEqual({
        format: 'jpeg',
        width: 4,
        height: 2
      })
    }
  )

  it.each([{ ids: [1] }, { ids: [1, 2, 3, 4] }])(
    'retains grayscale and four-component frame structure $ids',
    ({ ids }) => {
      expect(
        inspectImageDecodeBudget(jpeg([frame({ ids }), scan({ ids }), Buffer.from([1])])).width
      ).toBe(4)
    }
  )

  it('skips EXIF, ICC and comments as bounded metadata without interpreting TIFF', () => {
    const metadata = [
      segment(0xe1, Buffer.from('Exif\0\0II*\0', 'latin1')),
      segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1')),
      segment(0xfe, Buffer.from([0xff, 0xc0, 0xff, 0xd9]))
    ]
    expect(
      inspectImageDecodeBudget(jpeg([...metadata, frame(), scan(), Buffer.from([1])]))
    ).toEqual({
      format: 'jpeg',
      width: 4,
      height: 2
    })
  })

  it('handles byte stuffing, marker fill and many restart markers without spending structural nodes', () => {
    const restarts = Buffer.from(
      Array.from({ length: 5000 }, (_, index) => [0xff, 0xd0 + (index % 8)]).flat()
    )
    const bytes = jpeg([
      segment(0xdd, Buffer.from([0, 1])),
      frame(),
      scan(),
      Buffer.from([1, 0xff, 0, 2]),
      restarts,
      Buffer.from([0xff])
    ])
    expect(inspectImageDecodeBudget(bytes, { limits: { maxNodes: 3 } })).toEqual({
      format: 'jpeg',
      width: 4,
      height: 2
    })
  })

  it('enforces exact segment, edge and pixel boundaries', () => {
    const comments = Array.from({ length: 4094 }, () => segment(0xfe, Buffer.from('x')))
    const exact = jpeg([...comments, frame(), scan(), Buffer.from([1])])
    expect(inspectImageDecodeBudget(exact).format).toBe('jpeg')
    rejected(jpeg([segment(0xfe), ...comments, frame(), scan()]), 'IMAGE_STRUCTURE_NODES_EXCEEDED')
    expect(
      inspectImageDecodeBudget(jpeg([frame({ width: 8192, height: 4096 }), scan()])).width
    ).toBe(8192)
    rejected(jpeg([frame({ width: 8192, height: 4097 }), scan()]), 'IMAGE_PIXELS_EXCEEDED')
    rejected(jpeg([frame({ width: 16_385, height: 1 }), scan()]), 'IMAGE_EDGE_EXCEEDED')
  })

  it('uses explicit unsupported codes for MPO, deferred dimensions and other coding variants', () => {
    rejected(
      jpeg([segment(0xe2, Buffer.from('MPF\0', 'latin1')), frame(), scan()]),
      'IMAGE_JPEG_MPO_UNSUPPORTED'
    )
    rejected(jpeg([frame({ height: 0 }), scan()]), 'IMAGE_JPEG_VARIANT_UNSUPPORTED')
    rejected(
      jpeg([frame(), scan(), segment(0xdc, Buffer.from([0, 2]))]),
      'IMAGE_JPEG_VARIANT_UNSUPPORTED'
    )
    rejected(jpeg([frame({ marker: 0xc3 }), scan()]), 'IMAGE_JPEG_VARIANT_UNSUPPORTED')
    rejected(jpeg([frame({ precision: 12 }), scan()]), 'IMAGE_JPEG_VARIANT_UNSUPPORTED')
    rejected(Buffer.concat([baselineJpeg, baselineJpeg]), 'IMAGE_JPEG_VARIANT_UNSUPPORTED')
  })

  it('rejects truncated markers and entropy, duplicate frame and invalid component references', () => {
    rejected(baselineJpeg.subarray(0, -2), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(Buffer.from([0xff, 0xd8, 0xff]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 20]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), frame(), scan()]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([scan(), frame()]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), scan({ ids: [4] })]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame({ ids: [1, 1] }), scan({ ids: [1] })]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), scan({ ids: [1, 1] })]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), scan(), Buffer.from([0xff, 0xff, 0])]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), scan(), Buffer.from([0xff, 0xd8])]), 'IMAGE_JPEG_STRUCTURE_INVALID')
  })

  it('retains normal padding but does not mistake ordinary bytes outside scans for markers', () => {
    expect(
      inspectImageDecodeBudget(Buffer.concat([baselineJpeg, Buffer.from([0, 9, 10, 13, 32])])).width
    ).toBe(4)
    rejected(jpeg([Buffer.from([1]), frame(), scan()]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame(), scan({ end: 62 })]), 'IMAGE_JPEG_STRUCTURE_INVALID')
    rejected(jpeg([frame({ marker: 0xc2 }), scan({ end: 63 })]), 'IMAGE_JPEG_STRUCTURE_INVALID')
  })
})
