// Pure container scans only. Callers supply validated limits and the shared
// dimension assertion; this helper never imports the public budget entry point.
function fail(format, message, variant = false) {
  const error = new Error(message)
  error.code = `IMAGE_${format}_${variant ? 'VARIANT_UNSUPPORTED' : 'STRUCTURE_INVALID'}`
  throw error
}
function nodeCounter(limits) {
  let count = 0
  return () => {
    if (++count > limits.maxNodes) {
      const error = new Error('Image container node count exceeds the decode budget')
      error.code = 'IMAGE_STRUCTURE_NODES_EXCEEDED'
      throw error
    }
  }
}
function gif(bytes, limits, dimensions) {
  const bad = (message) => fail('GIF', message)
  if (bytes.length < 13) bad('GIF header is truncated')
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8)
  dimensions(width, height, limits)
  let offset = 13
  const globalEntries = bytes[10] & 0x80 ? 2 ** ((bytes[10] & 7) + 1) : 0
  offset += globalEntries * 3
  if (offset > bytes.length) bad('GIF global palette is truncated')
  const node = nodeCounter(limits)
  let frameCount = 0
  const subblocks = () => {
    // Each step consumes at least one encoded byte. Data sub-blocks do not spend
    // logical nodes; maxBytes bounds even a long sequence of one-byte blocks.
    while (offset < bytes.length) {
      const size = bytes[offset++]
      if (offset + size > bytes.length) bad('GIF sub-block is truncated')
      offset += size
      if (!size) return
    }
    bad('GIF sub-block terminator is missing')
  }
  while (offset < bytes.length) {
    node()
    const type = bytes[offset++]
    if (type === 0x3b) {
      if (!frameCount || offset !== bytes.length) bad('GIF trailer is invalid')
      return { format: 'gif', width, height, frameCount }
    }
    if (type === 0x21) {
      if (offset >= bytes.length) bad('GIF extension label is truncated')
      offset++ // Extension label; color/control/plain-text semantics belong to the decoder.
      subblocks()
    } else if (type === 0x2c) {
      if (offset + 9 > bytes.length) bad('GIF image descriptor is truncated')
      const x = bytes.readUInt16LE(offset),
        y = bytes.readUInt16LE(offset + 2)
      const w = bytes.readUInt16LE(offset + 4),
        h = bytes.readUInt16LE(offset + 6),
        flags = bytes[offset + 8]
      if (!w || !h || x + w > width || y + h > height) bad('GIF frame rectangle is invalid')
      const entries = flags & 0x80 ? 2 ** ((flags & 7) + 1) : globalEntries
      offset += 9 + (flags & 0x80 ? entries * 3 : 0)
      if (offset >= bytes.length) bad('GIF frame palette or image data is truncated')
      offset++ // LZW minimum code size: no pixel-code validity claim here.
      subblocks()
      frameCount++
    } else bad('GIF record type is invalid')
  }
  bad('GIF trailer is missing')
}

function bmp(bytes, limits, dimensions) {
  const bad = (message) => fail('BMP', message)
  if (bytes.length < 26) bad('BMP header is truncated')
  const size = bytes.length,
    pixels = bytes.readUInt32LE(10),
    dib = bytes.readUInt32LE(14)
  if (![12, 40, 52, 56, 108, 124].includes(dib))
    fail('BMP', 'BMP DIB variant is not supported', true)
  if (14 + dib > size) bad('BMP header is truncated')
  const core = dib === 12
  const width = core ? bytes.readUInt16LE(18) : bytes.readInt32LE(18)
  const signedHeight = core ? bytes.readUInt16LE(20) : bytes.readInt32LE(22)
  const height = Math.abs(signedHeight)
  dimensions(width, height, limits)
  const bits = bytes.readUInt16LE(core ? 24 : 28)
  const compression = core ? 0 : bytes.readUInt32LE(30)
  if (!(core ? [1, 4, 8, 24] : [1, 4, 8, 16, 24, 32]).includes(bits))
    bad('BMP bit depth does not identify a supported pixel layout')
  if (![0, 1, 2, 3, 6].includes(compression))
    fail('BMP', 'BMP compression variant is not supported', true)
  let metadataEnd = 14 + dib
  if ([3, 6].includes(compression)) {
    const count = compression === 6 ? 4 : 3
    metadataEnd = Math.max(metadataEnd, 14 + 40 + count * 4)
  }
  const used = core ? 0 : bytes.readUInt32LE(46)
  metadataEnd += (used || (bits <= 8 ? 2 ** bits : 0)) * (core ? 3 : 4)
  if (pixels < metadataEnd || pixels > size) bad('BMP palette/masks overlap pixels or exceed file')
  const declared = core ? 0 : bytes.readUInt32LE(34)
  const span = [1, 2].includes(compression) ? declared : Math.ceil((width * bits) / 32) * 4 * height
  if (!span || pixels + span > size || (declared && (declared < span || pixels + declared > size)))
    bad('BMP pixel span is truncated or inconsistent')
  // Color masks, planes, reserved fields, file-size hints and profile contents
  // are not interpreted. Only the actual buffer and required pixel/layout spans bound reads.
  return { format: 'bmp', width, height }
}

function webp(bytes, limits, dimensions) {
  const bad = (message) => fail('WEBP', message)
  if (
    bytes.length < 20 ||
    bytes.toString('latin1', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    bad('WebP RIFF length or signature is invalid')
  const node = nodeCounter(limits)
  const walk = (start, end, visit) => {
    for (let offset = start; offset < end; ) {
      node()
      if (offset + 8 > end) bad('WebP chunk header is truncated')
      const type = bytes.toString('latin1', offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4)
      const next = offset + 8 + length + (length & 1)
      if (next > end) bad('WebP chunk range or padding is truncated')
      visit(type, offset + 8, length, offset)
      offset = next
    }
  }
  const bitstream = (type, start, length) => {
    let width, height
    if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) bad('WebP VP8L header is invalid')
      const header = bytes.readUInt32LE(start + 1)
      width = (header & 0x3fff) + 1
      height = ((header >>> 14) & 0x3fff) + 1
    } else {
      if (
        length < 10 ||
        bytes[start] & 1 ||
        bytes.toString('hex', start + 3, start + 6) !== '9d012a'
      )
        bad('WebP VP8 keyframe header is invalid')
      if (bytes.readUInt16LE(start + 6) & 0xc000 || bytes.readUInt16LE(start + 8) & 0xc000)
        fail('WEBP', 'Scaled VP8 frame headers are not supported', true)
      width = bytes.readUInt16LE(start + 6) & 0x3fff
      height = bytes.readUInt16LE(start + 8) & 0x3fff
    }
    dimensions(width, height, limits)
    return { width, height }
  }
  const imageChunks = (visit) => {
    let image
    return {
      accept(type, start, length) {
        if (type === 'VP8 ' || type === 'VP8L') {
          if (image) bad('WebP frame bitstream dimensions are ambiguous')
          image = bitstream(type, start, length)
        }
      },
      finish() {
        if (!image) bad('WebP frame bitstream is missing')
        visit(image)
      }
    }
  }
  let width,
    height,
    extended = false,
    frameCount = 0,
    anim = false,
    hasStill = false,
    image
  const still = imageChunks((value) => {
    image = value
  })
  walk(12, bytes.length, (type, start, length) => {
    if (type === 'VP8X') {
      if (extended || length !== 10) bad('WebP canvas dimensions are ambiguous or truncated')
      extended = true
      width = bytes.readUIntLE(start + 4, 3) + 1
      height = bytes.readUIntLE(start + 7, 3) + 1
      dimensions(width, height, limits)
    } else if (type === 'ANIM') {
      if (anim || hasStill || frameCount || length !== 6) bad('WebP animation control is invalid')
      anim = true
    } else if (type === 'ANMF') {
      if (!anim || !extended || hasStill || length < 24)
        bad('WebP animation frame is invalid or out of order')
      const x = bytes.readUIntLE(start, 3) * 2,
        y = bytes.readUIntLE(start + 3, 3) * 2
      const w = bytes.readUIntLE(start + 6, 3) + 1,
        h = bytes.readUIntLE(start + 9, 3) + 1
      if (x + w > width || y + h > height) bad('WebP frame rectangle exceeds its canvas')
      const nested = imageChunks((value) => {
        if (value.width !== w || value.height !== h)
          bad('WebP inner frame dimensions disagree with ANMF')
      })
      walk(start + 16, start + length, nested.accept)
      nested.finish()
      frameCount++
    } else if (['ALPH', 'VP8 ', 'VP8L'].includes(type)) {
      if (anim || frameCount) bad('WebP still and animation dimensions are ambiguous')
      still.accept(type, start, length)
      if (type !== 'ALPH') hasStill = true
    }
    // Metadata (including ICC/EXIF/XMP/unknown ancillary chunks) is opaque and
    // bounded by walk(). It still spends a node; no color or ordering policy.
  })
  // Actual ANMF records determine the count, never VP8X feature/alpha hints.
  if (anim || frameCount) {
    if (!frameCount) bad('WebP animation has no frames')
  } else {
    still.finish()
    if (extended && (image.width !== width || image.height !== height))
      bad('WebP inner dimensions disagree with VP8X')
    width = image.width
    height = image.height
    frameCount = 1
  }
  return { format: 'webp', width, height, frameCount }
}

export function inspectRasterPreview(bytes, limits, dimensions) {
  // Preserve every byte: Node's 'ascii' decoder clears bit 7 and would turn
  // malformed high-bit tokens into a different, recognized container signature.
  const signature = bytes.toString('latin1', 0, 6)
  if (signature === 'GIF87a' || signature === 'GIF89a') return gif(bytes, limits, dimensions)
  if (bytes.length >= 2 && bytes.toString('latin1', 0, 2) === 'BM')
    return bmp(bytes, limits, dimensions)
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'RIFF')
    return webp(bytes, limits, dimensions)
  const error = new Error('Preview metadata supports PNG, JPEG, GIF, BMP and WebP only')
  error.code = 'IMAGE_FORMAT_UNSUPPORTED'
  throw error
}
