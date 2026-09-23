const databaseTests = Object.freeze([
  'tests/backend-integration.mjs',
  'tests/note-duration-db.mjs',
  'tests/note-remark-db.mjs',
  'tests/note-text-color-db.mjs',
  'tests/recurring-preview-db.mjs'
])

const storageTests = Object.freeze([
  'tests/attachment-storage-electron.mjs',
  'tests/wallpaper-storage-electron.mjs'
])

const windowFrameTests = Object.freeze([
  'tests/window-frame-electron.mjs',
  'tests/dock-trigger-electron.mjs',
  'tests/blur-z-order-electron.mjs',
  'tests/window-z-order-electron.mjs',
  'tests/window-border-electron.mjs',
  'tests/note-duration-electron.mjs',
  'tests/main-view-enhancements-electron.mjs',
  'tests/daily-report-electron.mjs',
  'tests/template-quarterly-electron.mjs',
  'tests/month-view-electron.mjs',
  'tests/week-view-electron.mjs',
  'tests/weather-settings-electron.mjs',
  'tests/sticky-persistence-electron.mjs',
  'tests/quick-note-edit-electron.mjs',
  'tests/titlebar-icon-scale-electron.mjs',
  'tests/view-visibility-shortcut-electron.mjs',
  'tests/note-draft-conflict-electron.mjs',
  'tests/note-draft-conflict-ui-electron.mjs'
])

const electronFeatureTests = Object.freeze([
  'tests/calendar-font-electron.mjs',
  'tests/draft-dialog-ui-electron.mjs',
  'tests/first-use-notice-electron.mjs',
  'tests/help-center-electron.mjs',
  'tests/logging-actions-electron.mjs',
  'tests/month-context-menu-electron.mjs',
  'tests/month-day-preview-status-electron.mjs',
  'tests/month-event-text-color-electron.mjs',
  'tests/note-text-color-electron.mjs',
  'tests/notice-markdown-electron.mjs',
  'tests/presentation-mode-electron.mjs',
  'tests/recurring-preview-electron.mjs',
  'tests/screenshot-recovery-electron.mjs',
  'tests/window-state-matrix-electron.mjs',
  'tests/week-day-panel-electron.mjs',
  'tests/window-control-drag-electron.mjs',
  'tests/window-z-order-recovery-electron.mjs'
])

// These suites are intentionally excluded from routine regression because they
// create acceptance artifacts, require extra host tools, or exercise large data sets.
const acceptanceTests = Object.freeze([
  'tests/maturity-db.mjs',
  'tests/maturity-electron.mjs',
  'tests/maturity-regressions-electron.mjs',
  'tests/notice-admin-electron.mjs'
])

const benchmarkTests = Object.freeze(['tests/thumbnail-benchmark-electron.mjs'])

const helperFiles = Object.freeze([
  'tests/calendar-count-preview-helper.mjs',
  'tests/helpers/renderer-evidence.mjs',
  'tests/fullscreen-foreground-electron.mjs'
])

const registeredMjsFiles = Object.freeze([
  ...databaseTests,
  ...storageTests,
  ...windowFrameTests,
  ...electronFeatureTests,
  ...acceptanceTests,
  ...benchmarkTests,
  ...helperFiles
])

module.exports = {
  acceptanceTests,
  benchmarkTests,
  databaseTests,
  electronFeatureTests,
  helperFiles,
  registeredMjsFiles,
  storageTests,
  windowFrameTests
}
