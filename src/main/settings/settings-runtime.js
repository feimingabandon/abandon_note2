import { createDefaultSettings, resolveSettingsRows } from '../../shared/settings-schema.js'

/** Resolve stored view rows with application values and the session-only shortcut gate. */
export function assembleResolvedSettings({
  viewRows,
  viewMode,
  applicationSettings,
  shortcutsEnabled
}) {
  const next = resolveSettingsRows(viewRows, viewMode)
  next.appearance.uiScale = applicationSettings.appearance.uiScale
  next.appearance.titlebarIconScale = applicationSettings.appearance.titlebarIconScale
  next.appearance.iconColor = applicationSettings.appearance.iconColor
  next.shortcuts = { ...applicationSettings.shortcuts, enabled: shortcutsEnabled }
  next.calendar = { ...applicationSettings.calendar }
  next.interaction = { ...applicationSettings.interaction }
  next.notes = { ...applicationSettings.notes }
  next.window = { ...applicationSettings.window }
  next.remote = { ...applicationSettings.remote }
  next.almanac = { ...applicationSettings.almanac }
  next.weather = structuredClone(applicationSettings.weather)
  next.onboarding = { ...applicationSettings.onboarding }
  return next
}

function freezeValues(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeValues(child)
  return Object.freeze(value)
}

/** Owns resolved values, revision and the shortcut session gate; providers only read runtime state. */
export function createSettingsRuntime({
  initialViewMode,
  getViewMode,
  readApplication,
  readViewRows,
  onResolved = () => {},
  readRuntime
}) {
  // Entry assembly can seed immutable schema defaults before the navigation owner exists.
  // Later refreshes always obtain the current mode from that sole owner.
  let values = freezeValues(createDefaultSettings(initialViewMode ?? getViewMode()))
  let revision = 0
  let shortcutsEnabled = true

  return Object.freeze({
    get values() {
      return values
    },
    get revision() {
      return revision
    },
    get shortcutsEnabled() {
      return shortcutsEnabled
    },
    resetForView(viewMode) {
      values = freezeValues(createDefaultSettings(viewMode))
    },
    refresh({ incrementRevision = false } = {}) {
      // Preserve read, publish, material/theme sync, then revision ordering.
      const applicationSettings = readApplication()
      const viewMode = getViewMode()
      const next = assembleResolvedSettings({
        applicationSettings,
        viewRows: readViewRows(viewMode),
        viewMode,
        shortcutsEnabled
      })
      const changed = JSON.stringify(next) !== JSON.stringify(values)
      values = freezeValues(next)
      onResolved(values)
      const revisionChanged = incrementRevision || changed
      if (revisionChanged) revision += 1
      return revisionChanged
    },
    setShortcutsEnabled(enabled) {
      shortcutsEnabled = Boolean(enabled)
      const next = structuredClone(values)
      next.shortcuts.enabled = shortcutsEnabled
      values = freezeValues(next)
      revision += 1
      return shortcutsEnabled
    },
    advanceRevision() {
      revision += 1
      return revision
    },
    snapshot() {
      const runtime = readRuntime(values)
      return {
        revision,
        values: {
          ...structuredClone(values),
          system: { autoStart: runtime.autoStart.value }
        },
        runtime
      }
    }
  })
}
