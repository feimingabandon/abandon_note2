function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function quickNoteEditorPosition(
  anchor,
  panel,
  { viewportWidth, viewportHeight, padding = 12, gap = 8 }
) {
  const maxLeft = Math.max(padding, viewportWidth - panel.width - padding)
  const maxTop = Math.max(padding, viewportHeight - panel.height - padding)
  const pointAnchor = Number(anchor.width) === 0 && Number(anchor.height) === 0
  const preferredLeft = pointAnchor ? anchor.left - panel.width / 2 : anchor.left
  const preferredTop = anchor.bottom + gap
  const top =
    preferredTop + panel.height <= viewportHeight - padding
      ? preferredTop
      : anchor.top - panel.height - gap

  return {
    left: clamp(preferredLeft, padding, maxLeft),
    top: clamp(top, padding, maxTop)
  }
}
