import { crc32 } from 'node:zlib'
import { MAX_IMAGE_BYTES } from '../../shared/attachment-rules.js'
import { inspectRasterPreview } from './image-preview-raster-budget.js'

export const IMAGE_DECODE_LIMITS = Object.freeze({
  maxBytes: MAX_IMAGE_BYTES,
  maxPixels: 32 * 1024 * 1024,
  maxEdge: 16_384,
  maxNodes: 4096
})

export const IMAGE_PREVIEW_LIMITS = Object.freeze({
  ...IMAGE_DECODE_LIMITS,
  maxDecodedPixels: 128 * 1024 * 1024
})

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const PNG_DEPTHS = new Map([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]]
])

function reject(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function resolveLimits(overrides) {
  const limits = { ...IMAGE_DECODE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      reject('IMAGE_LIMITS_INVALID', `Invalid image decode limit: ${name}`)
    }
  }
  return limits
}

/** The RGBA8 pixel budget is an admission bound, not a native decoder RSS limit. */
export function assertImageDimensions(width, height, limits = IMAGE_DECODE_LIMITS) {
  const budget = resolveLimits(limits)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    reject('IMAGE_DIMENSIONS_INVALID', 'Image dimensions must be positive integers')
  }
  if (width > budget.maxEdge || height > budget.maxEdge) {
    reject('IMAGE_EDGE_EXCEEDED', 'Image edge exceeds the decode budget')
  }
  if (width > Math.floor(budget.maxPixels / height)) {
    reject('IMAGE_PIXELS_EXCEEDED', 'Image pixels exceed the decode budget')
  }
  return { width, height }
}

function pngError(message) {
  reject('IMAGE_PNG_STRUCTURE_INVALID', message)
}

function inspectPng(bytes, limits, preview = false) {
  let offset = PNG_SIGNATURE.length
  let nodes = 0
  let width
  let height
  let depth
  let color
  let paletteEntries = 0
  let hasTransparency = false
  let hasData = false
  let dataEnded = false
  let dataBytes = 0
  let animationFrames
  let frameCount = 0
  let sequence = 0
  let frame
  let posterFrames = 0

  while (offset < bytes.length) {
    if (++nodes > limits.maxNodes) {
      reject('IMAGE_STRUCTURE_NODES_EXCEEDED', 'PNG chunk count exceeds the decode budget')
    }
    if (bytes.length - offset < 12) pngError('PNG chunk is truncated')
    const length = bytes.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > bytes.length) pngError('PNG chunk payload is truncated')
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type) || bytes[offset + 6] & 32) {
      pngError('PNG chunk type is invalid')
    }
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      pngError('PNG chunk CRC is invalid')
    }
    if (nodes === 1 && type !== 'IHDR') pngError('PNG must start with IHDR')
    const dataOffset = offset + 8
    if (type !== 'IDAT' && hasData) dataEnded = true

    if (type === 'IHDR') {
      if (nodes !== 1 || length !== 13) pngError('PNG IHDR is duplicated or invalid')
      width = bytes.readUInt32BE(dataOffset)
      height = bytes.readUInt32BE(dataOffset + 4)
      assertImageDimensions(width, height, limits)
      depth = bytes[dataOffset + 8]
      color = bytes[dataOffset + 9]
      if (
        !PNG_DEPTHS.get(color)?.includes(depth) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] > 1
      ) {
        pngError('PNG IHDR encoding fields are invalid')
      }
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      if (!preview) {
        // A first-frame thumbnail does not prove an animation's decode resources.
        reject('IMAGE_PNG_ANIMATION_UNSUPPORTED', 'Animated PNG is outside the decode budget')
      }
      if (type === 'acTL') {
        if (animationFrames !== undefined || hasData || length !== 8)
          pngError('APNG animation control is invalid or out of order')
        animationFrames = bytes.readUInt32BE(dataOffset)
        if (!animationFrames) pngError('APNG must declare at least one frame')
      } else {
        if (animationFrames === undefined) pngError('APNG frame is missing animation control')
        if (length < 4 || bytes.readUInt32BE(dataOffset) !== sequence++)
          pngError('APNG frame sequence is invalid')
        if (type === 'fcTL') {
          if (length !== 26 || (frame && !frame.dataBytes))
            pngError('APNG frame control or preceding data is invalid')
          const w = bytes.readUInt32BE(dataOffset + 4)
          const h = bytes.readUInt32BE(dataOffset + 8)
          const x = bytes.readUInt32BE(dataOffset + 12)
          const y = bytes.readUInt32BE(dataOffset + 16)
          if (
            !w ||
            !h ||
            x + w > width ||
            y + h > height ||
            bytes[dataOffset + 24] > 2 ||
            bytes[dataOffset + 25] > 1
          )
            pngError('APNG frame rectangle or operations are invalid')
          if (!hasData && (frameCount || x || y || w !== width || h !== height))
            pngError('APNG default animation frame must fill the canvas')
          if (!frameCount && hasData) posterFrames = 1
          frame = { usesIdat: !hasData, dataBytes: 0 }
          frameCount++
        } else {
          if (!hasData || !frame || frame.usesIdat) pngError('APNG frame data is out of order')
          frame.dataBytes += length - 4
        }
      }
    } else if (type === 'PLTE') {
      if (
        paletteEntries ||
        hasData ||
        hasTransparency ||
        color === 0 ||
        color === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        pngError('PNG palette is invalid or out of order')
      }
      paletteEntries = length / 3
      if (color === 3 && paletteEntries > 2 ** depth) pngError('PNG palette exceeds its bit depth')
    } else if (type === 'tRNS') {
      if (
        hasTransparency ||
        hasData ||
        !(
          (color === 0 && length === 2) ||
          (color === 2 && length === 6) ||
          (color === 3 && paletteEntries > 0 && length > 0 && length <= paletteEntries)
        )
      ) {
        pngError('PNG transparency is invalid or out of order')
      }
      hasTransparency = true
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !paletteEntries)) {
        pngError('PNG image data is out of order')
      }
      hasData = true
      dataBytes += length
      if (frame?.usesIdat) frame.dataBytes += length
    } else if (type === 'IEND') {
      if (length || end !== bytes.length || !hasData || !dataBytes) {
        pngError('PNG image data or end is incomplete')
      }
      if (animationFrames !== undefined && (frameCount !== animationFrames || !frame?.dataBytes))
        pngError('APNG actual frame count or data does not match its declaration')
      return {
        format: 'png',
        width,
        height,
        ...(preview ? { frameCount: frameCount || 1, posterFrames } : {})
      }
    } else if (!(bytes[offset + 4] & 32)) {
      pngError('PNG contains an unknown critical chunk')
    }
    offset = end
  }
  pngError('PNG is missing IEND')
}

function jpegError(message) {
  reject('IMAGE_JPEG_STRUCTURE_INVALID', message)
}

function jpegVariant(message) {
  reject('IMAGE_JPEG_VARIANT_UNSUPPORTED', message)
}

function inspectJpeg(bytes, limits) {
  let offset = 2
  let nodes = 0
  let width
  let height
  let frameMarker
  let componentIds
  let hasScan = false

  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) jpegError('JPEG marker prefix is missing')
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) jpegError('JPEG marker is truncated')
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (!frameMarker || !hasScan) jpegError('JPEG is missing frame or scan data')
      // Some encoders append padding. Other trailing payloads are not single images.
      for (; offset < bytes.length; offset++) {
        if (![0, 9, 10, 13, 32].includes(bytes[offset])) {
          jpegVariant('JPEG contains a trailing payload')
        }
      }
      return { format: 'jpeg', width, height }
    }
    if (marker === 0xdc) jpegVariant('JPEG DNL dimensions are not supported')
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
      jpegError('JPEG contains an unexpected standalone marker')
    }
    if (++nodes > limits.maxNodes) {
      reject('IMAGE_STRUCTURE_NODES_EXCEEDED', 'JPEG segment count exceeds the decode budget')
    }
    const isFrame = marker === 0xc0 || marker === 0xc1 || marker === 0xc2
    if (
      !isFrame &&
      marker !== 0xc4 &&
      marker !== 0xdb &&
      marker !== 0xdd &&
      marker !== 0xda &&
      marker !== 0xfe &&
      !(marker >= 0xe0 && marker <= 0xef)
    ) {
      jpegVariant('JPEG coding variant is not supported')
    }
    if (bytes.length - offset < 2) jpegError('JPEG segment length is truncated')
    const length = bytes.readUInt16BE(offset)
    const end = offset + length
    if (length < 2 || end > bytes.length) jpegError('JPEG segment payload is truncated')
    const dataOffset = offset + 2

    if (isFrame) {
      if (frameMarker || hasScan || length < 8) jpegError('JPEG frame is duplicated or invalid')
      const count = bytes[dataOffset + 5]
      if (count < 1 || count > 4 || length !== 8 + 3 * count) {
        jpegError('JPEG frame components are invalid')
      }
      if (bytes[dataOffset] !== 8) jpegVariant('JPEG sample precision is not supported')
      height = bytes.readUInt16BE(dataOffset + 1)
      width = bytes.readUInt16BE(dataOffset + 3)
      if (!height) jpegVariant('JPEG deferred dimensions are not supported')
      assertImageDimensions(width, height, limits)
      componentIds = new Set()
      for (let index = 0; index < count; index++) {
        const componentOffset = dataOffset + 6 + index * 3
        const id = bytes[componentOffset]
        const sampling = bytes[componentOffset + 1]
        if (
          componentIds.has(id) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          bytes[componentOffset + 2] > 3
        ) {
          jpegError('JPEG frame component fields are invalid')
        }
        componentIds.add(id)
      }
      frameMarker = marker
    } else if (
      marker === 0xe2 &&
      length >= 6 &&
      bytes.toString('latin1', dataOffset, dataOffset + 4) === 'MPF\0'
    ) {
      reject('IMAGE_JPEG_MPO_UNSUPPORTED', 'JPEG multiple-picture format is not supported')
    } else if (marker === 0xdd && length !== 4) {
      jpegError('JPEG restart interval is invalid')
    } else if (marker === 0xda) {
      if (!frameMarker || length < 6) jpegError('JPEG scan appears before its frame')
      const count = bytes[dataOffset]
      if (count < 1 || count > componentIds.size || length !== 6 + 2 * count) {
        jpegError('JPEG scan components are invalid')
      }
      const scanIds = new Set()
      for (let index = 0; index < count; index++) {
        const id = bytes[dataOffset + 1 + index * 2]
        const tables = bytes[dataOffset + 2 + index * 2]
        if (!componentIds.has(id) || scanIds.has(id) || tables >> 4 > 3 || (tables & 15) > 3) {
          jpegError('JPEG scan component fields are invalid')
        }
        scanIds.add(id)
      }
      const spectralStart = bytes[end - 3]
      const spectralEnd = bytes[end - 2]
      const approximation = bytes[end - 1]
      if (frameMarker === 0xc2) {
        const high = approximation >> 4
        const low = approximation & 15
        if (
          spectralStart > spectralEnd ||
          spectralEnd > 63 ||
          (spectralStart === 0 && spectralEnd !== 0) ||
          (spectralStart > 0 && count !== 1) ||
          high > 13 ||
          low > 13 ||
          (high !== 0 && high !== low + 1)
        ) {
          jpegError('JPEG progressive scan fields are invalid')
        }
      } else if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) {
        jpegError('JPEG sequential scan fields are invalid')
      }
      hasScan = true
      offset = end
      // Stuffed bytes, fill bytes and restart markers are not structural nodes.
      // Their work is bounded by maxBytes and the owner's process deadline.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++
          continue
        }
        const markerStart = offset++
        while (offset < bytes.length && bytes[offset] === 0xff) offset++
        if (offset >= bytes.length) jpegError('JPEG entropy marker is truncated')
        const scanMarker = bytes[offset]
        if (scanMarker === 0) {
          if (offset !== markerStart + 1) jpegError('JPEG entropy stuffing is invalid')
          offset++
        } else if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset++
        } else {
          offset = markerStart
          break
        }
      }
      continue
    }
    offset = end
  }
  jpegError('JPEG is missing EOI')
}

/**
 * Preflight only: no inflate or pixel decode. The caller must decode this same
 * immutable byte snapshot in its bounded owner, then check the decoded size.
 * Animated PNG and JPEG MPO/DNL/other coding variants are conservatively refused.
 */
export function inspectImageDecodeBudget(input, { limits } = {}) {
  const budget = resolveLimits(limits)
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    reject('IMAGE_BYTES_INVALID', 'Image bytes must be a nonempty Buffer or Uint8Array')
  }
  if (input.byteLength > budget.maxBytes) {
    reject('IMAGE_BYTES_EXCEEDED', 'Image encoded bytes exceed the decode budget')
  }
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return inspectPng(bytes, budget)
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return inspectJpeg(bytes, budget)
  }
  reject('IMAGE_FORMAT_UNSUPPORTED', 'Only PNG and JPEG are supported by this decode path')
}

/**
 * Metadata admission only, with no inflate/pixel decode or byte mutation. The
 * owner must decode this exact snapshot and check decoder dimensions/frame count.
 * APNG retains format='png'. frameCount counts actual image frames; an independent
 * APNG default poster adds posterFrames=1. animated means frameCount>1, not the
 * decoder API's animation capability/loop flag. Repetition is never multiplied.
 * decodedPixels counts full canvases, not frame rectangles or an RSS guarantee.
 */
export function inspectImagePreviewBudget(input, { limits } = {}) {
  const budget = resolveLimits({ ...IMAGE_PREVIEW_LIMITS, ...limits })
  if (!(input instanceof Uint8Array) || !input.byteLength)
    reject('IMAGE_BYTES_INVALID', 'Image bytes must be a nonempty Buffer or Uint8Array')
  if (input.byteLength > budget.maxBytes)
    reject('IMAGE_BYTES_EXCEEDED', 'Image encoded bytes exceed the decode budget')
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let result
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    result = inspectPng(bytes, budget, true)
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
    result = inspectJpeg(bytes, budget)
  else result = inspectRasterPreview(bytes, budget, assertImageDimensions)
  const { format, width, height, frameCount = 1, posterFrames = 0 } = result
  const pixels = width * height
  if (frameCount + posterFrames > Math.floor(budget.maxDecodedPixels / pixels))
    reject(
      'IMAGE_DECODED_PIXELS_EXCEEDED',
      'Full animation canvases exceed the preview decode budget'
    )
  return {
    format,
    width,
    height,
    frameCount,
    posterFrames,
    decodedPixels: pixels * (frameCount + posterFrames),
    animated: frameCount > 1
  }
}
