/** Wait for presentation of a specific test-only CSS generation, not rAF or a cached surface. */
export function waitForFixtureFrame({ webContents, name, marker, palette, viewport }) {
  const trace = {
    name,
    palette,
    marker,
    viewport,
    startedAt: Date.now(),
    deadlineAt: Date.now() + 12000,
    frames: [],
    received: 0,
    selected: null,
    closed: false
  }
  let finished = false,
    timer,
    rejectReady
  const close = () => {
    if (trace.closed) return
    trace.closed = true
    clearTimeout(timer)
    try {
      webContents.endFrameSubscription()
    } catch (error) {
      trace.cleanupError = error.stack || String(error)
    }
    if (!finished) rejectReady(new Error(name + ': fixture frame subscription cancelled'))
  }
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject
    timer = setTimeout(() => {
      finished = true
      close()
      reject(new Error(name + ': no matching presented fixture frame within 12000ms'))
    }, 12000)
    webContents.beginFrameSubscription(false, (image, dirtyRect) => {
      if (finished) return
      try {
        const size = image.getSize(),
          bytes = image.toBitmap()
        if (bytes.length !== size.width * size.height * 4)
          throw new Error('Unexpected full-frame bitmap dimensions')
        const pixel = (x, y) => {
          if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            x < 0 ||
            y < 0 ||
            x >= size.width ||
            y >= size.height
          )
            throw new Error('Fixture pixel outside captured frame')
          return Array.from(bytes.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3))
        }
        const markerPixel = pixel(
          Math.floor((10 * size.width) / viewport.width),
          Math.floor((162 * size.height) / viewport.height)
        )
        const backdrop = pixel(Math.floor(size.width * 0.05), Math.floor(size.height * 0.2))
        const ordered = [...markerPixel].sort((a, b) => a - b),
          expected = [...marker].sort((a, b) => a - b)
        const markerMatches = ordered.every(
          (value, index) => Math.abs(value - expected[index]) <= 2
        )
        const paletteMatches =
          palette === 'black'
            ? Math.max(...backdrop) < 60
            : palette === 'complex'
              ? Math.max(...backdrop) - Math.min(...backdrop) > 50
              : Math.min(...backdrop) > 150
        const frame = {
          sequence: ++trace.received,
          at: Date.now(),
          size,
          dirtyRect,
          markerPixel,
          backdrop,
          markerMatches,
          paletteMatches
        }
        if (trace.frames.length < 120) trace.frames.push(frame)
        else trace.lastFrame = frame
        if (!markerMatches || !paletteMatches) return
        trace.selected = frame
        finished = true
        close()
        resolve(image)
      } catch (error) {
        finished = true
        close()
        reject(error)
      }
    })
  })
  // The caller may fail while installing CSS, before it awaits the presentation.
  ready.catch(() => {})
  return { ready, close, trace }
}
