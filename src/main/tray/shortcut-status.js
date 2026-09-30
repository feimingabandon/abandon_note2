import { nativeImage } from 'electron'

/** Keep the app icon recognizable and overlay a red minus badge when paused. */
export function createShortcutTrayImages(iconPath) {
  const enabled = nativeImage.createFromPath(iconPath)
  if (enabled.isEmpty()) throw new Error('无法加载托盘图标')
  const disabled = nativeImage.createEmpty()
  // Render at 4x before downsampling so the badge stays legible at small sizes.
  // Separate representations cover Windows tray DPI from 100% through 300%.
  for (const size of [16, 20, 24, 32, 40, 48]) {
    const pixels = size * 4
    const bitmap = enabled.resize({ width: pixels, height: pixels }).toBitmap()
    const center = pixels * 0.74
    for (let y = 0; y < pixels; y += 1) {
      for (let x = 0; x < pixels; x += 1) {
        const dx = x + 0.5 - center
        const dy = y + 0.5 - center
        const distance = Math.hypot(dx, dy)
        if (distance > pixels * 0.25) continue
        const white =
          distance > pixels * 0.21 ||
          (Math.abs(dx) < pixels * 0.12 && Math.abs(dy) < pixels * 0.035)
        const offset = (y * pixels + x) * 4
        // Electron native bitmaps use premultiplied BGRA; badge pixels are opaque.
        // Red/white are semantic disabled-state colors, not application theme chrome.
        bitmap[offset] = white ? 255 : 54
        bitmap[offset + 1] = white ? 255 : 59
        bitmap[offset + 2] = white ? 255 : 224
        bitmap[offset + 3] = 255
      }
    }
    const image = nativeImage
      .createFromBitmap(bitmap, { width: pixels, height: pixels })
      .resize({ width: size, height: size, quality: 'best' })
    disabled.addRepresentation({ scaleFactor: size / 16, buffer: image.toPNG() })
  }
  return { enabled, disabled }
}
