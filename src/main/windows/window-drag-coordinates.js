/** Shared screen coordinate conversion; both drag domains retain one display per rectangle. */
export function createWindowDragCoordinates(screen) {
  function dipBoundsToPhysical(window, bounds) {
    // A rectangle touching a mixed-DPI display boundary must use one display's
    // scale for all four edges. Converting two independent points can select two
    // displays and distort the native transition width or height.
    return screen.dipToScreenRect(window, bounds)
  }

  function resolvedDragPoint(point) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x: Math.round(x), y: Math.round(y) }
      : screen.getCursorScreenPoint()
  }
  return { dipBoundsToPhysical, resolvedDragPoint }
}
