import {
  applyApplicationSettings,
  createDefaultSettings,
  resolveSettingsRows
} from '../../shared/settings-schema.js'

/** Resolve stored view rows with application values and the session-only shortcut gate. */
export function assembleResolvedSettings({
  viewRows,
  viewMode,
  applicationSettings,
  shortcutsEnabled
}) {
  const next = applyApplicationSettings(
    resolveSettingsRows(viewRows, viewMode),
    applicationSettings
  )
  next.shortcuts.enabled = shortcutsEnabled
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
    refresh({ incrementRevision = false, notifyResolved = true } = {}) {
      // Publish a consistent value/revision pair before fallible runtime dependencies.
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
      const revisionChanged = incrementRevision || changed
      if (revisionChanged) revision += 1
      // A staged application owner can dispatch these dependencies separately.
      // Existing callers retain their synchronous notification contract.
      if (notifyResolved) onResolved(values)
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
