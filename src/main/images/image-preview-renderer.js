// Kept in this function so the fixed script is embedded in the private page at
// build time. No untrusted SVG text is ever interpolated into document HTML.
async function runImagePreview() {
  const fail = (code) => Object.assign(new Error(code), { code })
  const input = await window.ownedImagePreview.read()
  const { bytes, header, purpose, size, limits, mime } = input
  const dimensions = (width, height) => {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > limits.maxEdge ||
      height > limits.maxEdge ||
      width * height > limits.maxPixels
    )
      throw fail('IMAGE_PREVIEW_DIMENSIONS_EXCEEDED')
  }
  let decoder, frame, image, url, canvas
  let response
  try {
    let width = header?.width,
      height = header?.height
    if (mime === 'image/svg+xml') {
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? 'utf-16be'
            : 'utf-8'
      const parsed = new DOMParser().parseFromString(
        new TextDecoder(encoding).decode(bytes),
        'image/svg+xml'
      )
      const root = parsed.documentElement
      if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg')
        throw fail('IMAGE_PREVIEW_SVG_INVALID')
      if (parsed.getElementsByTagName('*').length > limits.maxNodes)
        throw fail('IMAGE_PREVIEW_NODES_EXCEEDED')
      // Explicit root dimensions are checked before loading. Percent/style and
      // intrinsic fallbacks are checked again against the loaded natural size.
      // SVG internal surfaces remain the user's explicitly accepted boundary.
      const rootWidth = root.width?.baseVal?.value,
        rootHeight = root.height?.baseVal?.value
      if (rootWidth > 0 && rootHeight > 0) dimensions(Math.ceil(rootWidth), Math.ceil(rootHeight))
      image = new Image()
      url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      image.src = url
      await image.decode()
      width = image.naturalWidth
      height = image.naturalHeight
      dimensions(width, height)
    } else {
      dimensions(width, height)
      decoder = new ImageDecoder({ data: bytes, type: mime, preferAnimation: true })
      void decoder.completed.catch(() => {})
      await decoder.tracks.ready
      const decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true })
      frame = decoded.image
      const actualWidth = frame.displayWidth,
        actualHeight = frame.displayHeight
      dimensions(actualWidth, actualHeight)
      if (
        !(
          (width === actualWidth && height === actualHeight) ||
          (mime === 'image/jpeg' && width === actualHeight && height === actualWidth)
        )
      )
        throw fail('IMAGE_PREVIEW_DIMENSIONS_CHANGED')
      width = actualWidth
      height = actualHeight
    }
    let data
    if (purpose === 'thumbnail') {
      const scale = Math.min(1, size / Math.max(width, height))
      canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      canvas.getContext('2d').drawImage(image || frame, 0, 0, canvas.width, canvas.height)
      data = canvas.toDataURL('image/png')
      if (!data.startsWith('data:image/png;base64,') || data.length > 2 * 1024 * 1024)
        throw fail('IMAGE_PREVIEW_OUTPUT_EXCEEDED')
    }
    response = { ok: true, value: { width, height, ...(data ? { data } : {}) } }
  } catch (error) {
    response = {
      ok: false,
      error: {
        code: error.code || 'IMAGE_PREVIEW_FAILED',
        message: String(error.message).slice(0, 240)
      }
    }
  } finally {
    if (frame) frame.close()
    if (decoder) decoder.close()
    if (image) image.src = ''
    if (url) URL.revokeObjectURL(url)
    if (canvas) canvas.width = canvas.height = 0
  }
  await window.ownedImagePreview.complete(response)
}

export function imagePreviewPage() {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; img-src blob: data:"><script>(${runImagePreview.toString()})().catch(error=>console.error(error))</script>`
}
