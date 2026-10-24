import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import {
  IMAGE_DECODE_LIMITS,
  IMAGE_PREVIEW_LIMITS,
  inspectImageDecodeBudget,
  inspectImagePreviewBudget
} from '../src/main/images/image-decode-budget.js'

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/image-preview-budget/${name}`, import.meta.url))
const provenance = JSON.parse(fixture('provenance.json'))
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')
const rgbaData = deflateSync(Buffer.from([0, 255, 0, 0, 255]))

function expected(format, width, height, frameCount = 1, posterFrames = 0) {
  return {
    format,
    width,
    height,
    frameCount,
    posterFrames,
    decodedPixels: width * height * (frameCount + posterFrames),
    animated: frameCount > 1
  }
}

function reject(bytes, code, options) {
  expect(() => inspectImagePreviewBudget(bytes, options)).toThrow(expect.objectContaining({ code }))
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 4, 'ascii')
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
  return result
}

// These helpers edit container metadata; they do not implement pixel decoders.
// Opaque color/codec metadata is not a compatibility gate. Admission assertions
// prove only the stated budget and bounded container reads; decoder validity
// remains a separate requirement.
function pngParts(bytes) {
  const parts = []
  for (let at = 8; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at)
    parts.push({
      type: bytes.toString('ascii', at + 4, at + 8),
      data: Buffer.from(bytes.subarray(at + 8, at + 8 + size))
    })
    at += size + 12
  }
  return parts
}

const png = (parts) =>
  Buffer.concat([pngSignature, ...parts.map(({ type, data }) => pngChunk(type, data))])

function editPng(name, type, edit, occurrence = 0) {
  const parts = pngParts(fixture(name))
  const part = parts.filter((value) => value.type === type)[occurrence]
  edit(part.data)
  return png(parts)
}

function metadataPng(width = 1, height = 1) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return png([{ type: 'IHDR', data: header }, { type: 'IDAT', data: rgbaData }, { type: 'IEND' }])
}

function gifFrame({
  x = 0,
  y = 0,
  width = 1,
  height = 1,
  local = false,
  interlace = false,
  control = true,
  transparent = false,
  minCode = 2
} = {}) {
  const descriptor = Buffer.alloc(10)
  descriptor[0] = 0x2c
  descriptor.writeUInt16LE(x, 1)
  descriptor.writeUInt16LE(y, 3)
  descriptor.writeUInt16LE(width, 5)
  descriptor.writeUInt16LE(height, 7)
  descriptor[9] = (local ? 0x80 : 0) | (interlace ? 0x40 : 0)
  return Buffer.concat([
    ...(control ? [Buffer.from([0x21, 0xf9, 4, transparent ? 5 : 4, 1, 0, 0, 0])] : []),
    descriptor,
    ...(local ? [Buffer.from([255, 0, 0, 0, 0, 255])] : []),
    Buffer.from([minCode, 2, 0x44, 0x01, 0])
  ])
}

function gif({
  width = 1,
  height = 1,
  global = true,
  records = [gifFrame()],
  version = 'GIF89a'
} = {}) {
  const header = Buffer.alloc(13)
  header.write(version)
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  header[10] = global ? 0x80 : 0
  return Buffer.concat([
    header,
    ...(global ? [Buffer.from([255, 0, 0, 0, 0, 255])] : []),
    ...records,
    Buffer.from([0x3b])
  ])
}

function bmp({
  dib = 40,
  width = 3,
  height = 2,
  bits = 24,
  compression = 0,
  used = 0,
  masks,
  profile
} = {}) {
  const core = dib === 12
  const externalMasks = dib === 40 && masks ? masks.length * 4 : 0
  const palette = bits <= 8 ? (used || 2 ** bits) * (core ? 3 : 4) : used * 4
  const offset = 14 + dib + externalMasks + palette
  const span = Math.ceil((width * bits) / 32) * 4 * Math.abs(height)
  const bytes = Buffer.alloc(offset + span + (profile?.length || 0))
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(offset, 10)
  bytes.writeUInt32LE(dib, 14)
  if (core) {
    bytes.writeUInt16LE(width, 18)
    bytes.writeUInt16LE(height, 20)
    bytes.writeUInt16LE(1, 22)
    bytes.writeUInt16LE(bits, 24)
  } else {
    bytes.writeInt32LE(width, 18)
    bytes.writeInt32LE(height, 22)
    bytes.writeUInt16LE(1, 26)
    bytes.writeUInt16LE(bits, 28)
    bytes.writeUInt32LE(compression, 30)
    bytes.writeUInt32LE(span, 34)
    bytes.writeUInt32LE(used, 46)
  }
  masks?.forEach((mask, index) => bytes.writeUInt32LE(mask, 54 + index * 4))
  if (profile) {
    bytes.writeUInt32LE(0x4d424544, 70)
    bytes.writeUInt32LE(offset + span - 14, 126)
    bytes.writeUInt32LE(profile.length, 130)
    profile.copy(bytes, offset + span)
  }
  return bytes
}

function webpChunk(type, data) {
  const bytes = Buffer.alloc(8 + data.length + (data.length & 1))
  bytes.write(type, 0, 4, 'ascii')
  bytes.writeUInt32LE(data.length, 4)
  data.copy(bytes, 8)
  return bytes
}

function webpParts(bytes) {
  const parts = []
  for (let at = 12; at < bytes.length; ) {
    const size = bytes.readUInt32LE(at + 4)
    parts.push({
      type: bytes.toString('ascii', at, at + 4),
      data: Buffer.from(bytes.subarray(at + 8, at + 8 + size))
    })
    at += 8 + size + (size & 1)
  }
  return parts
}

function webp(parts) {
  const data = Buffer.concat(parts.map(({ type, data }) => webpChunk(type, data)))
  const header = Buffer.alloc(12)
  header.write('RIFF')
  header.writeUInt32LE(data.length + 4, 4)
  header.write('WEBP', 8)
  return Buffer.concat([header, data])
}

function webpExtended(width = 1, height = 1, flags = 0) {
  const data = Buffer.alloc(10)
  data[0] = flags
  data.writeUIntLE(width - 1, 4, 3)
  data.writeUIntLE(height - 1, 7, 3)
  return { type: 'VP8X', data }
}

// Fixed metadata sentinel only; compressed pixel validity belongs to the decoder.
function webpLossless(width = 1, height = 1, alpha = false) {
  const data = Buffer.alloc(6)
  data[0] = 0x2f
  data.writeUInt32LE((width - 1) | ((height - 1) << 14) | (alpha ? 0x10000000 : 0), 1)
  return { type: 'VP8L', data }
}

function webpLossy(width = 1, height = 1) {
  const data = Buffer.alloc(10)
  data.set([0x9d, 0x01, 0x2a], 3)
  data.writeUInt16LE(width, 6)
  data.writeUInt16LE(height, 8)
  return { type: 'VP8 ', data }
}

function editWebp(name, edit) {
  const parts = webpParts(fixture(name))
  edit(parts)
  return webp(parts)
}

describe('preview metadata contract', () => {
  it('extends the frozen original limits with the distinct full-animation canvas budget', () => {
    expect(IMAGE_PREVIEW_LIMITS).toEqual({
      ...IMAGE_DECODE_LIMITS,
      maxDecodedPixels: 128 * 1024 * 1024
    })
    expect(Object.isFrozen(IMAGE_PREVIEW_LIMITS)).toBe(true)
    expect(IMAGE_DECODE_LIMITS).not.toHaveProperty('maxDecodedPixels')
  })

  it.each(provenance.fixtures)(
    'admits frozen $file without modifying its source-verified bytes',
    (entry) => {
      const bytes = fixture(entry.file)
      const before = Buffer.from(bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
      expect(bytes.length).toBe(entry.bytes)
      expect(inspectImagePreviewBudget(bytes)).toEqual(
        expected(entry.format, entry.width, entry.height, entry.frameCount, entry.posterFrames)
      )
      expect(bytes).toEqual(before)
    }
  )

  it.each(['still.png', 'still.jpeg'])(
    'retains the original three-field nativeImage admission for %s',
    (name) => {
      const info = provenance.fixtures.find((entry) => entry.file === name)
      expect(inspectImageDecodeBudget(fixture(name))).toEqual({
        format: info.format,
        width: info.width,
        height: info.height
      })
    }
  )

  it.each(['apng-default-in-animation.png', 'apng-independent-poster.png'])(
    'leaves APNG refusal on the original nativeImage route: %s',
    (name) => {
      expect(() => inspectImageDecodeBudget(fixture(name))).toThrow(
        expect.objectContaining({ code: 'IMAGE_PNG_ANIMATION_UNSUPPORTED' })
      )
    }
  )

  it('respects Uint8Array view boundaries without writing outside or inside the snapshot', () => {
    const bytes = fixture('gif-restore-previous.gif')
    const padded = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xff])])
    const before = Buffer.from(padded)
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 1, bytes.length)
    expect(inspectImagePreviewBudget(view)).toEqual(expected('gif', 3, 2, 3))
    expect(padded).toEqual(before)
  })

  it.each(['still.png', 'still.jpeg', 'still.gif', 'still.bmp', 'still.webp'])(
    'enforces the exact encoded-byte boundary for %s',
    (name) => {
      const bytes = fixture(name)
      expect(
        inspectImagePreviewBudget(bytes, { limits: { maxBytes: bytes.length } }).frameCount
      ).toBe(1)
      reject(bytes, 'IMAGE_BYTES_EXCEEDED', { limits: { maxBytes: bytes.length - 1 } })
    }
  )

  it('rejects non-byte input, empty input, unsupported SVG and invalid budget values', () => {
    for (const input of ['', null, new ArrayBuffer(8), [], Buffer.alloc(0)])
      reject(input, 'IMAGE_BYTES_INVALID')
    reject(Buffer.from('<svg width="1" height="1"/>'), 'IMAGE_FORMAT_UNSUPPORTED')
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      reject(fixture('still.png'), 'IMAGE_LIMITS_INVALID', { limits: { maxDecodedPixels: value } })
    }
  })

  it.each([
    ['still.gif', 6],
    ['still.bmp', 2],
    ['still.webp', 4]
  ])('does not mask high bits in the %s container signature', (name, length) => {
    for (let offset = 0; offset < length; offset++) {
      const bytes = fixture(name)
      bytes[offset] |= 0x80
      reject(bytes, 'IMAGE_FORMAT_UNSUPPORTED')
    }
  })

  it('keeps edge, original canvas pixels and cumulative pixels as separate limits', () => {
    expect(inspectImagePreviewBudget(metadataPng(8192, 4096))).toEqual(expected('png', 8192, 4096))
    reject(metadataPng(8192, 4097), 'IMAGE_PIXELS_EXCEEDED')
    reject(metadataPng(16_385, 1), 'IMAGE_EDGE_EXCEEDED')
    expect(inspectImagePreviewBudget(metadataPng(16_384, 1)).width).toBe(16_384)
    reject(metadataPng(0, 1), 'IMAGE_DIMENSIONS_INVALID')
    reject(metadataPng(3, 2), 'IMAGE_DECODED_PIXELS_EXCEEDED', { limits: { maxDecodedPixels: 5 } })
  })
})

describe('APNG frame metadata', () => {
  it('counts actual frames, a separate default poster and full canvases despite tiny frame rectangles', () => {
    const animation = fixture('apng-default-in-animation.png')
    const poster = fixture('apng-independent-poster.png')
    expect(inspectImagePreviewBudget(animation, { limits: { maxDecodedPixels: 12 } })).toEqual(
      expected('png', 3, 2, 2)
    )
    reject(animation, 'IMAGE_DECODED_PIXELS_EXCEEDED', { limits: { maxDecodedPixels: 11 } })
    expect(inspectImagePreviewBudget(poster, { limits: { maxDecodedPixels: 18 } })).toEqual(
      expected('png', 3, 2, 2, 1)
    )
    reject(poster, 'IMAGE_DECODED_PIXELS_EXCEEDED', { limits: { maxDecodedPixels: 17 } })
  })

  it('uses actual frame count rather than the container animation flag', () => {
    const parts = pngParts(fixture('apng-default-in-animation.png'))
    const keep = parts.filter((part) => part.type !== 'fdAT')
    keep.splice(
      keep.findIndex((part, index) => part.type === 'fcTL' && index > 2),
      1
    )
    keep.find((part) => part.type === 'acTL').data.writeUInt32BE(1)
    expect(inspectImagePreviewBudget(png(keep))).toEqual(expected('png', 3, 2))
  })

  it('does not multiply the infinite loop count or a large repetition count into the budget', () => {
    const bytes = editPng('apng-default-in-animation.png', 'acTL', (data) =>
      data.writeUInt32BE(0xffffffff, 4)
    )
    expect(inspectImagePreviewBudget(bytes)).toEqual(expected('png', 3, 2, 2))
  })

  it.each([0, 1, 3, 0xffffffff])(
    'rejects declared frame count %s when it differs from the two real frames',
    (count) => {
      reject(
        editPng('apng-default-in-animation.png', 'acTL', (data) => data.writeUInt32BE(count)),
        'IMAGE_PNG_STRUCTURE_INVALID'
      )
    }
  )

  it.each(['fcTL', 'fdAT'])(
    'rejects nonconsecutive %s sequence numbers with otherwise correct CRC',
    (type) => {
      reject(
        editPng('apng-default-in-animation.png', type, (data) => data.writeUInt32BE(100)),
        'IMAGE_PNG_STRUCTURE_INVALID'
      )
    }
  )

  it('rejects frame rectangles beyond the canvas and invalid blend/disposal fields', () => {
    for (const [offset, value] of [
      [4, 0],
      [12, 3],
      [16, 2]
    ]) {
      reject(
        editPng(
          'apng-default-in-animation.png',
          'fcTL',
          (data) => data.writeUInt32BE(value, offset),
          1
        ),
        'IMAGE_PNG_STRUCTURE_INVALID'
      )
    }
    for (const [offset, value] of [
      [24, 3],
      [25, 2]
    ]) {
      reject(
        editPng(
          'apng-default-in-animation.png',
          'fcTL',
          (data) => {
            data[offset] = value
          },
          1
        ),
        'IMAGE_PNG_STRUCTURE_INVALID'
      )
    }
    reject(
      editPng('apng-default-in-animation.png', 'fcTL', (data) => data.writeUInt32BE(1, 4)),
      'IMAGE_PNG_STRUCTURE_INVALID'
    )
  })

  it('rejects missing controls/data, data before its frame, duplicate controls and reordered IDAT', () => {
    const original = pngParts(fixture('apng-default-in-animation.png'))
    reject(png(original.filter((part) => part.type !== 'acTL')), 'IMAGE_PNG_STRUCTURE_INVALID')
    reject(png(original.filter((part) => part.type !== 'fdAT')), 'IMAGE_PNG_STRUCTURE_INVALID')
    const duplicate = [...original]
    duplicate.splice(2, 0, original[1])
    reject(png(duplicate), 'IMAGE_PNG_STRUCTURE_INVALID')
    const reordered = [...original]
    const dataAt = reordered.findIndex((part) => part.type === 'fdAT')
    ;[reordered[dataAt - 1], reordered[dataAt]] = [reordered[dataAt], reordered[dataAt - 1]]
    reject(png(reordered), 'IMAGE_PNG_STRUCTURE_INVALID')
    const lateIdat = [...original]
    lateIdat.splice(
      lateIdat.length - 1,
      0,
      original.find((part) => part.type === 'IDAT')
    )
    reject(png(lateIdat), 'IMAGE_PNG_STRUCTURE_INVALID')
  })

  it('rejects CRC damage, truncated controls, trailing bytes and the exact next structural node', () => {
    const bytes = fixture('apng-independent-poster.png')
    const broken = Buffer.from(bytes)
    broken[broken.length - 1] ^= 1
    reject(broken, 'IMAGE_PNG_STRUCTURE_INVALID')
    const parts = pngParts(bytes)
    const frame = parts.find((part) => part.type === 'fcTL')
    frame.data = frame.data.subarray(0, 25)
    reject(png(parts), 'IMAGE_PNG_STRUCTURE_INVALID')
    reject(Buffer.concat([bytes, Buffer.from([0])]), 'IMAGE_PNG_STRUCTURE_INVALID')
    expect(
      inspectImagePreviewBudget(bytes, { limits: { maxNodes: pngParts(bytes).length } })
        .posterFrames
    ).toBe(1)
    reject(bytes, 'IMAGE_STRUCTURE_NODES_EXCEEDED', {
      limits: { maxNodes: pngParts(bytes).length - 1 }
    })
  })
})

describe('GIF bounded records', () => {
  it.each([
    { version: 'GIF87a', records: [gifFrame({ control: false })] },
    { global: false, records: [gifFrame({ local: true, interlace: true, transparent: true })] },
    { records: [gifFrame({ local: true, interlace: true }), gifFrame()] }
  ])('retains global/local palettes, interlace and ordinary controls: %j', (options) => {
    expect(inspectImagePreviewBudget(gif(options))).toEqual(
      expected('gif', 1, 1, options.records.length)
    )
  })

  it('charges full canvases at the default cumulative bound even for one-pixel frames', () => {
    const exact = gif({
      width: 8192,
      height: 4096,
      records: Array.from({ length: 4 }, () => gifFrame())
    })
    expect(inspectImagePreviewBudget(exact)).toEqual(expected('gif', 8192, 4096, 4))
    reject(
      gif({ width: 8192, height: 4096, records: Array.from({ length: 5 }, () => gifFrame()) }),
      'IMAGE_DECODED_PIXELS_EXCEEDED'
    )
    reject(gif({ width: 8192, height: 4097 }), 'IMAGE_PIXELS_EXCEEDED')
    reject(gif({ width: 16_385 }), 'IMAGE_EDGE_EXCEEDED')
  })

  it('bounds comment bytes without counting thousands of sub-blocks as record nodes', () => {
    const comment = Buffer.concat([
      Buffer.from([0x21, 0xfe]),
      ...Array.from({ length: 4100 }, () => Buffer.from([1, 65])),
      Buffer.from([0])
    ])
    const bytes = gif({ records: [comment, gifFrame()] })
    expect(inspectImagePreviewBudget(bytes, { limits: { maxNodes: 4 } })).toEqual(
      expected('gif', 1, 1)
    )
    reject(bytes, 'IMAGE_STRUCTURE_NODES_EXCEEDED', { limits: { maxNodes: 3 } })
  })

  it('counts extension/image/trailer records and bounds many small independent records', () => {
    const comment = Buffer.from([0x21, 0xfe, 1, 65, 0])
    const exact = gif({ records: [...Array.from({ length: 4093 }, () => comment), gifFrame()] })
    expect(inspectImagePreviewBudget(exact).format).toBe('gif')
    reject(
      gif({ records: [comment, ...Array.from({ length: 4093 }, () => comment), gifFrame()] }),
      'IMAGE_STRUCTURE_NODES_EXCEEDED'
    )
  })

  it('leaves graphics-control state, transparency and LZW validity to the decoder', () => {
    expect(inspectImagePreviewBudget(gif({ global: false }))).toEqual(expected('gif', 1, 1))
    for (const minCode of [0, 1, 9, 255])
      expect(inspectImagePreviewBudget(gif({ records: [gifFrame({ minCode })] }))).toEqual(
        expected('gif', 1, 1)
      )
    const duplicateControl = Buffer.from([0x21, 0xf9, 4, 4, 1, 0, 0, 0])
    expect(inspectImagePreviewBudget(gif({ records: [duplicateControl, gifFrame()] }))).toEqual(
      expected('gif', 1, 1)
    )
    expect(inspectImagePreviewBudget(gif({ records: [gifFrame(), duplicateControl] }))).toEqual(
      expected('gif', 1, 1)
    )
    const badIndex = gif({ records: [gifFrame({ transparent: true })] })
    badIndex[25] = 2
    expect(inspectImagePreviewBudget(badIndex)).toEqual(expected('gif', 1, 1))
    const invalidFlags = gif()
    invalidFlags[22] = 0x1c
    expect(inspectImagePreviewBudget(invalidFlags)).toEqual(expected('gif', 1, 1))
  })

  it('rejects frame bounds, missing trailer, truncated sub-blocks and trailing content', () => {
    reject(gif({ records: [gifFrame({ x: 1 })] }), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(gif({ records: [gifFrame({ height: 0 })] }), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(gif().subarray(0, -1), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(Buffer.concat([gif(), Buffer.from([0])]), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(gif({ records: [Buffer.from([0x21, 0xfe, 255, 65])] }), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(gif({ records: [] }), 'IMAGE_GIF_STRUCTURE_INVALID')
    reject(gif().subarray(0, 18), 'IMAGE_GIF_STRUCTURE_INVALID')
  })

  it('bounds plain-text and unknown extensions by their sub-block spans without a compatibility whitelist', () => {
    for (const label of [0x01, 0x42]) {
      expect(
        inspectImagePreviewBudget(
          gif({ records: [Buffer.from([0x21, label, 12, ...Array(12).fill(0), 0]), gifFrame()] })
        )
      ).toEqual(expected('gif', 1, 1))
    }
  })
})

describe('BMP bounded headers and pixel ranges', () => {
  it.each([
    { bits: 8, compression: 1, run: 0 },
    { bits: 4, compression: 2, run: 0x12 }
  ])(
    'bounds RLE encoded spans while leaving compressed-pixel validation to the decoder: %j',
    ({ bits, compression, run }) => {
      const bytes = bmp({ height: 1, bits, compression })
      const offset = bytes.readUInt32LE(10)
      bytes.set([3, run, 0, 1], offset)
      expect(inspectImagePreviewBudget(bytes)).toEqual(expected('bmp', 3, 1))
      const missingSize = Buffer.from(bytes)
      missingSize.writeUInt32LE(0, 34)
      reject(missingSize, 'IMAGE_BMP_STRUCTURE_INVALID')
      const beyondFile = Buffer.from(bytes)
      beyondFile.writeUInt32LE(5, 34)
      reject(beyondFile, 'IMAGE_BMP_STRUCTURE_INVALID')
    }
  )

  it.each([
    { dib: 12, bits: 24 },
    { dib: 12, bits: 1 },
    { dib: 40, height: -2 },
    { dib: 40, bits: 8, used: 2 },
    { dib: 52, bits: 16, compression: 3, masks: [0xf800, 0x07e0, 0x001f] },
    { dib: 56, bits: 32, compression: 6, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000] },
    { dib: 108, bits: 32, compression: 3, masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000] },
    { dib: 124, profile: Buffer.from('owned bounded ICC payload') }
  ])('retains common CORE/INFO/V4/V5 layouts: %j', (options) => {
    expect(inspectImagePreviewBudget(bmp(options))).toEqual(expected('bmp', 3, 2))
  })

  it('bounds INFO mask storage without interpreting its color-channel values', () => {
    expect(
      inspectImagePreviewBudget(bmp({ bits: 16, compression: 3, masks: [0xf800, 0x07e0, 0x001f] }))
    ).toEqual(expected('bmp', 3, 2))
    for (const masks of [
      [0xf800, 0x07e0, 0x07e0],
      [0xf800, 0x0500, 0x001f],
      [0x10000, 0x07e0, 0x001f],
      [0, 0x07e0, 0x001f]
    ]) {
      expect(inspectImagePreviewBudget(bmp({ bits: 16, compression: 3, masks }))).toEqual(
        expected('bmp', 3, 2)
      )
    }
    expect(
      inspectImagePreviewBudget(
        bmp({
          dib: 108,
          bits: 32,
          compression: 3,
          masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0x00ff0000]
        })
      )
    ).toEqual(expected('bmp', 3, 2))
    const overlap = bmp({ bits: 16, compression: 3, masks: [0xf800, 0x07e0, 0x001f] })
    overlap.writeUInt32LE(54, 10)
    reject(overlap, 'IMAGE_BMP_STRUCTURE_INVALID')
  })

  it('checks row alignment and actual pixel spans instead of trusting size fields', () => {
    const truncated = bmp().subarray(0, -1)
    truncated.writeUInt32LE(truncated.length, 2)
    reject(truncated, 'IMAGE_BMP_STRUCTURE_INVALID')
    const shortDeclared = bmp()
    shortDeclared.writeUInt32LE(1, 34)
    reject(shortDeclared, 'IMAGE_BMP_STRUCTURE_INVALID')
    const paletteOverlap = bmp({ bits: 8, used: 2 })
    paletteOverlap.writeUInt32LE(54, 10)
    reject(paletteOverlap, 'IMAGE_BMP_STRUCTURE_INVALID')
    const hugePalette = bmp({ bits: 1 })
    hugePalette.writeUInt32LE(3, 46)
    reject(hugePalette, 'IMAGE_BMP_STRUCTURE_INVALID')
  })

  it('does not interpret V5 color-profile semantics while still requiring a complete DIB', () => {
    const linked = bmp({ dib: 124 })
    linked.writeUInt32LE(0x4c494e4b, 70)
    expect(inspectImagePreviewBudget(linked)).toEqual(expected('bmp', 3, 2))
    const overlap = bmp({ dib: 124, profile: Buffer.alloc(16) })
    overlap.writeUInt32LE(124, 126)
    expect(inspectImagePreviewBudget(overlap)).toEqual(expected('bmp', 3, 2))
    const missingProfile = bmp({ dib: 124 })
    missingProfile.writeUInt32LE(0x4d424544, 70)
    expect(inspectImagePreviewBudget(missingProfile)).toEqual(expected('bmp', 3, 2))
    reject(bmp({ dib: 108 }).subarray(0, 60), 'IMAGE_BMP_STRUCTURE_INVALID')
  })

  it.each([4, 5, 11])(
    'explicitly refuses compression variant %s including embedded JPEG/PNG',
    (compression) => {
      reject(bmp({ compression }), 'IMAGE_BMP_VARIANT_UNSUPPORTED')
    }
  )

  it('bounds actual file/layout spans without treating size hints, reserved fields or planes as a compatibility gate', () => {
    const wrongSize = bmp()
    wrongSize.writeUInt32LE(1, 2)
    expect(inspectImagePreviewBudget(wrongSize)).toEqual(expected('bmp', 3, 2))
    for (const [offset, value, size] of [
      [6, 1, 4],
      [26, 2, 2]
    ]) {
      const bytes = bmp()
      bytes.writeUIntLE(value, offset, size)
      expect(inspectImagePreviewBudget(bytes)).toEqual(expected('bmp', 3, 2))
    }
    expect(inspectImagePreviewBudget(bmp({ height: -2, bits: 8, compression: 1 }))).toEqual(
      expected('bmp', 3, 2)
    )
    expect(
      inspectImagePreviewBudget(bmp({ bits: 24, compression: 3, masks: [0xff0000, 0xff00, 0xff] }))
    ).toEqual(expected('bmp', 3, 2))
    const unknown = bmp()
    unknown.writeUInt32LE(64, 14)
    reject(unknown, 'IMAGE_BMP_VARIANT_UNSUPPORTED')
    const huge = bmp()
    huge.writeInt32LE(16_385, 18)
    reject(huge, 'IMAGE_EDGE_EXCEEDED')
    const overPixels = bmp()
    overPixels.writeInt32LE(8192, 18)
    overPixels.writeInt32LE(4097, 22)
    reject(overPixels, 'IMAGE_PIXELS_EXCEEDED')
  })
})

describe('WebP bounded RIFF and animation metadata', () => {
  it('preserves the WEBP brand identity but does not interpret opaque ICC signatures', () => {
    for (let index = 0; index < 4; index++) {
      const bytes = fixture('webp-offset-alpha.webp')
      bytes[8 + index] |= 0x80
      reject(bytes, 'IMAGE_WEBP_STRUCTURE_INVALID')
      expect(
        inspectImagePreviewBudget(
          editWebp('webp-offset-alpha.webp', (parts) => {
            parts.find((part) => part.type === 'ICCP').data[36 + index] |= 0x80
          })
        )
      ).toEqual(expected('webp', 4, 2, 2))
    }
  })

  it('does not clear high FourCC bits into recognized dimension-bearing chunks', () => {
    const missingDimensions = webp([webpLossless()])
    missingDimensions[12] |= 0x80
    reject(missingDimensions, 'IMAGE_WEBP_STRUCTURE_INVALID')
    const unknownMetadata = fixture('webp-offset-alpha.webp')
    unknownMetadata[30] |= 0x80
    expect(inspectImagePreviewBudget(unknownMetadata)).toEqual(expected('webp', 4, 2, 2))
  })

  it('retains simple VP8 and VP8L dimensions and extended alpha layouts', () => {
    expect(inspectImagePreviewBudget(webp([webpLossy(3, 2)]))).toEqual(expected('webp', 3, 2))
    expect(inspectImagePreviewBudget(webp([webpLossless(3, 2)]))).toEqual(expected('webp', 3, 2))
    expect(
      inspectImagePreviewBudget(
        webp([
          webpExtended(3, 2, 0x10),
          { type: 'ALPH', data: Buffer.from([0, 255]) },
          webpLossy(3, 2)
        ])
      )
    ).toEqual(expected('webp', 3, 2))
    expect(
      inspectImagePreviewBudget(webp([webpExtended(3, 2, 0x10), webpLossless(3, 2, true)]))
    ).toEqual(expected('webp', 3, 2))
  })

  it('charges the full canvas per real ANMF despite offset/local frames and ignores loop repetitions', () => {
    const bytes = editWebp('webp-offset-alpha.webp', (parts) => {
      const control = parts.find((part) => part.type === 'ANIM')
      control.data.writeUInt16LE(65535, 4)
    })
    expect(inspectImagePreviewBudget(bytes, { limits: { maxDecodedPixels: 16 } })).toEqual(
      expected('webp', 4, 2, 2)
    )
    reject(bytes, 'IMAGE_DECODED_PIXELS_EXCEEDED', { limits: { maxDecodedPixels: 15 } })
    const noAnimationHint = editWebp('webp-offset-alpha.webp', (parts) => {
      parts[0].data[0] = 0
    })
    expect(inspectImagePreviewBudget(noAnimationHint)).toEqual(expected('webp', 4, 2, 2))
    reject(noAnimationHint, 'IMAGE_DECODED_PIXELS_EXCEEDED', {
      limits: { maxDecodedPixels: 15 }
    })
    const largeCanvas = editWebp('webp-offset-alpha.webp', (parts) => {
      parts[0].data.writeUIntLE(8191, 4, 3)
      parts[0].data.writeUIntLE(4095, 7, 3)
    })
    expect(inspectImagePreviewBudget(largeCanvas).decodedPixels).toBe(64 * 1024 * 1024)
    reject(largeCanvas, 'IMAGE_DECODED_PIXELS_EXCEEDED', {
      limits: { maxDecodedPixels: 64 * 1024 * 1024 - 1 }
    })
  })

  it('requires precise RIFF/chunk ranges and an in-range odd-size pad byte regardless of its value', () => {
    const bytes = fixture('webp-offset-alpha.webp')
    reject(bytes.subarray(0, -1), 'IMAGE_WEBP_STRUCTURE_INVALID')
    reject(Buffer.concat([bytes, Buffer.from([0])]), 'IMAGE_WEBP_STRUCTURE_INVALID')
    const tooLong = Buffer.from(bytes)
    tooLong.writeUInt32LE(0xffffffff, 16)
    reject(tooLong, 'IMAGE_WEBP_STRUCTURE_INVALID')
    const padded = webp([
      webpExtended(1, 1, 8),
      webpLossless(),
      { type: 'EXIF', data: Buffer.from([1]) }
    ])
    expect(inspectImagePreviewBudget(padded)).toEqual(expected('webp', 1, 1))
    padded[padded.length - 1] = 1
    expect(inspectImagePreviewBudget(padded)).toEqual(expected('webp', 1, 1))
    const missingPad = padded.subarray(0, -1)
    missingPad.writeUInt32LE(missingPad.length - 8, 4)
    reject(missingPad, 'IMAGE_WEBP_STRUCTURE_INVALID')
  })

  it('rejects dimension disagreements while leaving non-dimension feature bits to the decoder', () => {
    reject(webp([webpExtended(2, 1), webpLossless()]), 'IMAGE_WEBP_STRUCTURE_INVALID')
    for (const flag of [1, 0x40, 0x80])
      expect(inspectImagePreviewBudget(webp([webpExtended(1, 1, flag), webpLossless()]))).toEqual(
        expected('webp', 1, 1)
      )
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        parts.find((part) => part.type === 'ANMF').data.writeUIntLE(3, 0, 3)
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        parts.filter((part) => part.type === 'ANMF')[1].data.writeUIntLE(0, 6, 3)
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
    expect(
      inspectImagePreviewBudget(
        editWebp('webp-offset-alpha.webp', (parts) => {
          parts.find((part) => part.type === 'ANMF').data[15] = 4
        })
      )
    ).toEqual(expected('webp', 4, 2, 2))
  })

  it('requires ANIM before frames and disallows animation/still mixing or missing frames', () => {
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        parts.splice(
          parts.findIndex((part) => part.type === 'ANIM'),
          1
        )
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        parts.splice(
          parts.findIndex((part) => part.type === 'ANIM'),
          0,
          { type: 'ANIM', data: Buffer.alloc(6) }
        )
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        parts.push(webpLossless())
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        for (let index = parts.length - 1; index >= 0; index--)
          if (parts[index].type === 'ANMF') parts.splice(index, 1)
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
  })

  it('bounds opaque color metadata without imposing ICC structure, presence, ordering or feature-flag policy', () => {
    const original = fixture('webp-offset-alpha.webp')
    const profile = webpParts(original).find((part) => part.type === 'ICCP').data
    expect(createHash('sha256').update(profile).digest('hex')).toBe(
      '12afb4d9953adee0607d347daee5b78b18d6b3cab2d572b88970703f5edb37bc'
    )
    for (const edit of [
      (parts) => {
        parts.splice(1, 1)
      },
      (parts) => {
        parts.splice(2, 0, parts[1])
      },
      (parts) => {
        const [icc] = parts.splice(1, 1)
        parts.push(icc)
      },
      (parts) => {
        parts[1].data.writeUInt32BE(0xffffffff, 136)
      },
      (parts) => {
        parts[0].data[0] &= ~0x20
      }
    ]) {
      expect(inspectImagePreviewBudget(editWebp('webp-offset-alpha.webp', edit))).toEqual(
        expected('webp', 4, 2, 2)
      )
    }
    expect(fixture('webp-offset-alpha.webp')).toEqual(original)
  })

  it('keeps dimension uniqueness while leaving alpha payload and feature consistency to the decoder', () => {
    expect(
      inspectImagePreviewBudget(webp([{ type: 'ALPH', data: Buffer.from([0, 255]) }, webpLossy()]))
    ).toEqual(expected('webp', 1, 1))
    reject(webp([webpLossless(), webpLossless()]), 'IMAGE_WEBP_STRUCTURE_INVALID')
    expect(inspectImagePreviewBudget(webp([webpExtended(1, 1, 0x10), webpLossless()]))).toEqual(
      expected('webp', 1, 1)
    )
    expect(inspectImagePreviewBudget(webp([webpExtended(), webpLossless(1, 1, true)]))).toEqual(
      expected('webp', 1, 1)
    )
    expect(
      inspectImagePreviewBudget(
        webp([
          webpExtended(1, 1, 0x10),
          { type: 'ALPH', data: Buffer.from([0, 255]) },
          webpLossless()
        ])
      )
    ).toEqual(expected('webp', 1, 1))
  })

  it('counts all chunks toward the shared node budget and skips unknown payloads without inventing missing dimensions', () => {
    const bytes = fixture('webp-offset-alpha.webp')
    expect(inspectImagePreviewBudget(bytes, { limits: { maxNodes: 7 } }).frameCount).toBe(2)
    reject(bytes, 'IMAGE_STRUCTURE_NODES_EXCEEDED', { limits: { maxNodes: 6 } })
    expect(
      inspectImagePreviewBudget(webp([{ type: 'JUNK', data: Buffer.alloc(0) }, webpLossless()]))
    ).toEqual(expected('webp', 1, 1))
    const ancillary = editWebp('webp-offset-alpha.webp', (parts) => {
      const frame = parts.find((part) => part.type === 'ANMF')
      frame.data = Buffer.concat([
        frame.data.subarray(0, 16),
        webpChunk('JUNK', Buffer.from([1])),
        frame.data.subarray(16)
      ])
    })
    expect(inspectImagePreviewBudget(ancillary, { limits: { maxNodes: 8 } })).toEqual(
      expected('webp', 4, 2, 2)
    )
    reject(ancillary, 'IMAGE_STRUCTURE_NODES_EXCEEDED', { limits: { maxNodes: 7 } })
    reject(
      editWebp('webp-offset-alpha.webp', (parts) => {
        const frame = parts.find((part) => part.type === 'ANMF')
        frame.data.write('JUNK', 16, 4, 'ascii')
      }),
      'IMAGE_WEBP_STRUCTURE_INVALID'
    )
  })

  it('checks original canvas/edge and bitstream dimensions independently of the metadata wrapper', () => {
    reject(webp([webpExtended(8192, 4097), webpLossless()]), 'IMAGE_PIXELS_EXCEEDED')
    reject(webp([webpExtended(16_385, 1), webpLossless()]), 'IMAGE_EDGE_EXCEEDED')
    reject(webp([webpLossless(8192, 4097)]), 'IMAGE_PIXELS_EXCEEDED')
    const invalidVersion = webpLossless()
    invalidVersion.data[4] |= 0x20
    expect(inspectImagePreviewBudget(webp([invalidVersion]))).toEqual(expected('webp', 1, 1))
    const notKeyFrame = webpLossy()
    notKeyFrame.data[0] = 1
    reject(webp([notKeyFrame]), 'IMAGE_WEBP_STRUCTURE_INVALID')
    for (const offset of [6, 8]) {
      const scaled = webpLossy()
      scaled.data.writeUInt16LE(0x4001, offset)
      reject(webp([scaled]), 'IMAGE_WEBP_VARIANT_UNSUPPORTED')
    }
  })
})
