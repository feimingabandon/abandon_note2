const { existsSync, readFileSync, readdirSync, realpathSync, statSync } = require('node:fs')
const { dirname, extname, isAbsolute, relative, resolve, sep, win32 } = require('node:path')
const { parse } = require('@babel/parser')

const repositoryRoot = resolve(__dirname, '..')

const databaseTests = Object.freeze([
  'tests/note-state-db.mjs',
  'tests/recurrence-lifecycle-db.mjs',
  'tests/note-list-completion-db.mjs',
  'tests/reminder-database-integration.mjs',
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

const focusedDatabaseTests = Object.freeze([
  'tests/historical-note-move-db.mjs',
  'tests/settings-repository-db.mjs',
  'tests/database-runtime-db.mjs',
  'tests/business-clear-admission-electron.mjs',
  'tests/attachment-recovery-reset-electron.mjs'
])
const focusedGuiTests = Object.freeze([
  'tests/renderer-resource-lifetime-electron.mjs',
  'tests/historical-note-move-electron.mjs',
  'tests/new-note-workflow-electron.mjs',
  'tests/note-three-view-rules-ui-electron.mjs',
  'tests/note-startup-recovery-electron.mjs',
  'tests/remote-daily-electron.mjs',
  'tests/settings-runtime-electron.mjs',
  'tests/settings-queue-electron.mjs',
  'tests/application-lifecycle-electron.mjs',
  'tests/native-leaf-runtime-electron.mjs',
  'tests/dock-runtime-electron.mjs',
  'tests/background-navigation-electron.mjs',
  'tests/calendar-workspace-electron.mjs',
  'tests/feature-runtime-electron.mjs',
  'tests/app-ipc-electron.mjs',
  'tests/note-list-custom-electron.mjs'
])
const focusedNativeTests = Object.freeze(['tests/window-motion-diagnostics-native.mjs'])

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
  'tests/note-list-animation-electron.mjs',
  'tests/note-list-toolbar-electron.mjs',
  'tests/note-list-tag-refresh-electron.mjs',
  'tests/note-list-refresh-electron.mjs',
  'tests/renderer-recovery-electron.mjs',
  'tests/weather-notice-lifecycle-electron.mjs',
  'tests/note-list-completion-electron.mjs',
  'tests/reminders-electron.mjs',
  'tests/almanac-weather-electron.mjs',
  'tests/date-context-controls-electron.mjs',
  'tests/attachment-loading-electron.mjs',
  'tests/list-minimal-mode-electron.mjs',
  'tests/calendar-font-electron.mjs',
  'tests/draft-dialog-ui-electron.mjs',
  'tests/modal-queue-electron.mjs',
  'tests/first-use-notice-electron.mjs',
  'tests/help-center-electron.mjs',
  'tests/logging-actions-electron.mjs',
  'tests/logging-worker-asar-electron.mjs',
  'tests/month-context-menu-electron.mjs',
  'tests/month-day-preview-status-electron.mjs',
  'tests/month-event-text-color-electron.mjs',
  'tests/note-text-color-electron.mjs',
  'tests/notice-markdown-electron.mjs',
  'tests/presentation-mode-electron.mjs',
  'tests/titlebar-native-drag-electron.mjs',
  'tests/recurring-preview-electron.mjs',
  'tests/capture-lifecycle-electron.mjs',
  'tests/capture-host-electron.mjs',
  'tests/capture-business-electron.mjs',
  'tests/settings-scroll-memory-electron.mjs',
  'tests/window-state-matrix-electron.mjs',
  'tests/week-day-panel-electron.mjs',
  'tests/window-control-drag-electron.mjs',
  'tests/window-z-order-recovery-electron.mjs'
])

// These suites are intentionally excluded from routine regression because they
// create acceptance artifacts, require extra host tools, or exercise large data sets.
const acceptanceTests = Object.freeze([
  'tests/ui-components-electron.mjs',
  'tests/ui-responsive-electron.mjs',
  'tests/ui-feedback-electron.mjs',
  'tests/ui-feedback-app-electron.mjs',
  'tests/maturity-db.mjs',
  'tests/maturity-electron.mjs',
  'tests/maturity-regressions-electron.mjs',
  'tests/notice-admin-electron.mjs'
])

const benchmarkTests = Object.freeze([
  'tests/thumbnail-benchmark-electron.mjs',
  'tests/logging-overhead-electron.mjs',
  'tests/logging-motion-overhead-electron.mjs'
])

const helperFiles = Object.freeze([
  'tests/helpers/startup-shortcut-notice.mjs',
  'tests/calendar-count-preview-helper.mjs',
  'tests/helpers/capture-test-desktop.mjs',
  'tests/helpers/date-picker-keyboard.mjs',
  'tests/helpers/renderer-evidence.mjs',
  'tests/helpers/electron-gui-result-lifecycle.mjs',
  'tests/fullscreen-foreground-electron.mjs'
])

const registeredMjsFiles = Object.freeze([
  ...focusedNativeTests,
  ...databaseTests,
  ...focusedDatabaseTests,
  ...focusedGuiTests,
  ...storageTests,
  ...windowFrameTests,
  ...electronFeatureTests,
  ...acceptanceTests,
  ...benchmarkTests,
  ...helperFiles
])

// These are application entry capabilities, not assertions that every existing
// security test already protects all entry points. Keep the restricted preloads distinct.
const securityEntryPoints = Object.freeze(
  [
    { html: 'src/renderer/index.html', preload: 'src/preload/index.js', capability: 'main' },
    { html: 'src/renderer/month.html', preload: 'src/preload/index.js', capability: 'main' },
    { html: 'src/renderer/week.html', preload: 'src/preload/index.js', capability: 'main' },
    { html: 'src/renderer/sticky.html', preload: 'src/preload/sticky.js', capability: 'sticky' },
    {
      html: 'src/renderer/reminder.html',
      preload: 'src/preload/reminder.js',
      capability: 'reminder'
    }
  ].map(Object.freeze)
)

const buildDefinitions = Object.freeze([
  {
    id: 'build-app',
    file: 'electron.vite.config.mjs',
    runtime: 'node',
    buildInputs: [
      'src/main',
      'src/preload',
      'src/renderer',
      'electron.vite.config.mjs',
      'package-lock.json'
    ]
  },
  {
    id: 'build-native',
    file: 'native_blur/build.ps1',
    runtime: 'powershell',
    buildInputs: [
      'native_blur/CMakeLists.txt',
      'native_blur/build.ps1',
      'native_blur/blur_api.cpp',
      'native_blur/window_motion_diagnostics.cpp',
      'native_blur/window_motion_diagnostics.h',
      'src/shared/native-abi-version.js'
    ]
  },
  {
    id: 'build-capture',
    file: 'native_capture/build.ps1',
    runtime: 'powershell',
    buildInputs: [
      'native_capture/CMakeLists.txt',
      'native_capture/build.ps1',
      'native_capture/engine',
      'native_capture/host',
      'native_capture/platform',
      'native_capture/tests'
    ]
  },
  {
    id: 'build-notice-preview',
    file: 'scripts/build-notice-preview.mjs',
    runtime: 'node',
    buildInputs: ['tools/notice-preview', 'scripts/build-notice-preview.mjs', 'package-lock.json']
  }
])

const additionalHelpers = Object.freeze([
  'tests/helpers/test-result-recorder.cjs',
  'tests/helpers/capture-owner.cjs',
  'tests/helpers/z-order-event-emitter.cjs',
  'tests/helpers/ui-fixture.cjs',
  'tests/helpers/diagnostic-mode-fixture.js',
  'tests/helpers/reminder-activation.ps1',
  'native_capture/tests/input_driver.cpp',
  'native_blur/tests/window_motion_diagnostics_test.cpp'
])
const fixtureFiles = Object.freeze([
  'tests/fixtures/almanac-reference.json',
  'tests/fixtures/notice-admin-server.py',
  'tests/fixtures/ui-components.vue',
  'tests/fixtures/ui-feedback.vue'
])
const additionalTests = Object.freeze([
  'tests/capture-package-smoke.cjs',
  'tests/reminder-native-acceptance.cjs',
  'tests/sandbox-diagnostics-win.cjs',
  'tests/sandbox-electron-win.ps1',
  'tests/sandbox-installer-win.ps1',
  'tests/sandbox-permissions-win.ps1',
  'native_capture/tests/polish_test.cpp',
  'native_capture/tests/selection_test.cpp',
  'native_capture/tests/pin_halo_test.cpp',
  'native_capture/tests/ux_test.cpp',
  'native_capture/tests/core_test.cpp',
  'native_capture/tests/ui_test.cpp',
  'native_capture/tests/clipboard_test.cpp'
])

// Only reviewed read dependencies belong here. Output/evidence files read by a
// test are not production source dependencies. Braces compact literal file lists.
const sourceReadDefinitions = {
  'capture-build-selection': [
    'native_capture/CMakeLists.txt',
    'native_capture/build.ps1',
    'native_capture/run-qt-test.cmake'
  ],
  'test-entrypoints': [
    'package.json',
    'scripts/run-test-entry.cjs',
    'scripts/run-electron-node-tests.cjs',
    'scripts/run-electron-window-tests.cjs',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml'
  ],
  'ci-test-selection': [
    'scripts/run-ci-tests.cjs',
    'scripts/test-domain-rules.cjs',
    '.github/workflows/ci.yml'
  ],
  'calendar-workspace-lifecycle': ['src/renderer/src/components/month/MonthWorkspace.vue'],
  'action-bar-accessibility': ['src/renderer/src/components/list/ActionBar.vue'],
  'app-update-wiring': [
    'src/main/index.js',
    'src/main/ipc/register-app-ipc.js',
    'src/preload/index.js',
    'src/renderer/src/components/system/UpdateDialog.vue'
  ],
  'blur-settings-main-wiring': ['src/main/settings/settings-write-coordinator.js'],
  'calendar-recurring-preview-ui': [
    'src/renderer/src/components/month/{MonthCalendarToolbar,MonthEventBar,MonthWorkspace}.vue',
    'src/renderer/src/composables/useCalendarWorkspacePreferences.js'
  ],
  'clipboard-and-selection': [
    'src/main/ipc/register-business-ipc.js',
    'src/preload/index.js',
    'src/renderer/src/assets/tokens.css',
    'src/renderer/src/components/list/NoteCard.vue',
    'src/renderer/src/components/note/QuickNoteContentEditor.vue',
    'src/renderer/src/components/system/LogViewerDialog.vue',
    'src/renderer/src/components/ui/StyledSelect.vue'
  ],
  'diagnostic-noise-and-location': [
    'src/main/capture/CaptureCoordinator.js',
    'src/main/db/{db-wallpapers,attachment-recovery}.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/services/notification-activation.js',
    'src/main/application/feature-runtime.js',
    'src/main/windows/blur-runtime.js',
    'src/main/index.js',
    'src/main/ipc/register-business-ipc.js',
    'src/main/services/weather-service.js',
    'src/renderer/src/App.vue',
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/components/weather/WeatherSettings.vue'
  ],
  'dock-main-wiring': [
    'src/main/index.js',
    'src/preload/index.js',
    'src/main/window-motion/dock-runtime.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/capture/capture-window-integration.js'
  ],
  'dock-settings-ui': [
    'src/renderer/src/components/help/help-content.js',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/system/settings/DockSettingsSection.vue',
    'src/renderer/src/composables/useDockSettingsForm.js',
    'src/renderer/src/composables/useSettingsWriteQueue.js'
  ],
  'editing-draft-session': [
    'src/main/index.js',
    'src/preload/index.js',
    'src/renderer/src/composables/useDraftProtection.js',
    'src/renderer/src/composables/useNewNotePreferences.js'
  ],
  'help-navigation-ui': [
    'src/renderer/src/{App,MonthApp}.vue',
    'src/renderer/src/components/help/HelpPage.vue'
  ],
  'help-support-ui': ['src/renderer/src/components/help/HelpPage.vue'],
  'historical-note-backfill-ui': [
    'src/main/ipc/register-business-ipc.js',
    'src/main/notes/note-commands.js',
    'src/renderer/src/components/list/NewNotePanel.vue',
    'src/renderer/src/components/note/NoteEditor.vue'
  ],
  'historical-note-move-ui': [
    'src/renderer/src/components/month/HistoricalNoteMoveControl.vue',
    'src/renderer/src/components/month/MonthCalendarToolbar.vue'
  ],
  'calendar-creation-intent': ['src/renderer/src/components/month/MonthNoteCreator.vue'],
  'template-submit-lock': ['src/renderer/src/components/template/TemplateForm.vue'],
  'relative-now-picker': ['src/renderer/src/components/ui/DateTimePicker.vue'],
  'image-only-note': [
    'src/main/ipc/register-business-ipc.js',
    'src/main/notes/note-commands.js',
    'src/preload/index.js',
    'src/renderer/src/components/list/{NewNotePanel,NoteCard}.vue',
    'src/renderer/src/components/month/{MonthCalendarGrid,MonthEventBar,MonthNoteCreator}.vue',
    'src/renderer/src/components/note/{ImagePicker,ImagePreview,NoteEditor}.vue'
  ],
  'month-calendar-context-menu': [
    'docs/UI_DESIGN_STANDARD.md',
    'src/renderer/src/components/month/{MonthCalendarGrid,MonthEventBar,MonthWorkspace}.vue'
  ],
  'month-event-bar': ['src/renderer/src/components/month/MonthEventBar.vue'],
  'native-edge-monitor-source': ['native_blur/window_motion_edge_monitor.cpp'],
  'native-runtime-gate': ['native_blur/blur_api.cpp', 'src/main/index.js'],
  'platform-support': ['src/main/bootstrap.js'],
  'note-duration-mode': [
    'src/main/index.js',
    'src/preload/index.js',
    'src/renderer/src/components/list/NewNotePanel.vue',
    'src/renderer/src/components/month/{MonthCalendarToolbar,MonthNoteCreator}.vue',
    'src/renderer/src/components/note/{NoteDurationField,NoteEditor}.vue',
    'src/shared/settings-schema.js'
  ],
  'note-list-motion': ['src/renderer/src/components/list/NoteList.vue'],
  'note-remark': [
    'src/main/db/{db-notes,db-schema}.js',
    'src/main/ipc/register-business-ipc.js',
    'src/preload/index.js',
    'src/renderer/src/assets/tokens.css',
    'src/renderer/src/components/list/NoteCard.vue',
    'src/renderer/src/components/note/QuickNoteContentEditor.vue',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/utils/applySettingsSnapshot.js',
    'src/shared/settings-schema.js'
  ],
  'note-text-color': [
    'src/main/db/{db-notes,db-schema}.js',
    'src/main/ipc/register-business-ipc.js',
    'src/preload/index.js',
    'src/renderer/src/components/list/{NewNotePanel,NoteCard,SearchResultCard}.vue',
    'src/renderer/src/components/month/{MonthEventBar,MonthNoteCreator}.vue',
    'src/renderer/src/components/note/{ColoredTextEditor,NoteEditor,NoteTextColorPopover}.vue'
  ],
  'package-native-config': [
    'electron-builder.base.yml',
    'scripts/configure-packaged-native.cjs',
    'scripts/package-native-plan.cjs',
    'scripts/validate-packaged-app.cjs'
  ],
  'presentation-mode-architecture': [
    'src/main/index.js',
    'src/main/windows/main-window-host.js',
    'src/main/windows/presentation-runtime.js',
    'src/main/windows/window-drag-controller.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/settings/settings-write-coordinator.js',
    'src/main/window-motion/dock-runtime.js',
    'src/renderer/src/{App,MonthApp}.vue',
    'src/renderer/src/components/system/{AppTitlebar,CompactIsland,ResizeHandles,SettingsPanel,WindowPresentation}.vue'
  ],
  'quick-note-edit': [
    'src/renderer/src/composables/useWorkspaceRuntime.js',
    'src/renderer/src/{App,MonthApp}.vue',
    'src/renderer/src/components/list/NoteCard.vue',
    'src/renderer/src/components/month/MonthEventBar.vue',
    'src/renderer/src/components/note/QuickNoteContentEditor.vue',
    'src/renderer/src/components/system/SettingsPanel.vue'
  ],
  'recent-local-day-range': ['src/renderer/src/components/list/SearchBox.vue'],
  'security-hardening': [
    'package.json',
    'electron-builder.yml',
    'scripts/generate-app-icons.py',
    '.github/workflows/release.yml',
    'electron-builder.{base,win}.yml',
    'src/main/index.js',
    ...securityEntryPoints.map((entry) => entry.html)
  ],
  'settings-panel-density': [
    'src/renderer/src/components/note/ImagePicker.vue',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/weather/WeatherSettings.vue'
  ],
  'sticky-entry': ['src/renderer/sticky.html', 'src/renderer/sticky/{sticky.css,sticky.js}'],
  'tag-color-setting': [
    'src/main/index.js',
    'src/renderer/src/{App,MonthApp}.vue',
    'src/renderer/src/composables/useWorkspaceRuntime.js',
    'src/renderer/src/components/list/{NoteCard,SearchResultCard}.vue',
    'src/renderer/src/components/month/{MonthEventBar,MonthCalendarGrid}.vue',
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/components/system/SettingsPanel.vue'
  ],
  'tag-group-ordering-ui': [
    'src/renderer/src/components/help/help-content.js',
    'src/renderer/src/components/list/{NoteCard,NoteList}.vue',
    'src/renderer/src/components/ui/TagEditorForm.vue',
    'src/renderer/src/composables/useTagGroupListModel.js'
  ],
  'tag-selector-ui': ['src/renderer/src/components/ui/TagSelector.vue'],
  'titlebar-icon-scale-ui': [
    'resources/icons/{daily-report,recurrence,settings,help,pin,lock,close,tag,taiji,clover,switch-view,locate-current,date-panel}.svg',
    'resources/icons/{daily-report,recurrence,settings,help,pin,lock,close,tag,taiji,clover,switch-view,locate-current,date-panel}-white.svg',
    'src/renderer/src/components/month/MonthCalendarToolbar.vue',
    'src/renderer/src/components/system/{AppTitlebar,SettingsPanel,TitlebarActions,ViewSwitcher}.vue',
    'src/renderer/src/components/ui/{AppIcon,FilterTabs}.vue'
  ],
  'ui-interaction-standard': [
    'docs/UI_DESIGN_STANDARD.md',
    'src/renderer/src/{App,MonthApp}.vue',
    'src/renderer/src/assets/tokens.css',
    'src/renderer/src/components/list/NoteCard.vue',
    'src/renderer/src/components/month/{MonthCalendarGrid,MonthCalendarToolbar,MonthDayPanel,MonthEventBar,MonthWorkspace}.vue',
    'src/renderer/src/components/report/DailyReportDialog.vue'
  ],
  'view-switch-geometry-order': ['src/main/index.js', 'src/main/windows/main-view-navigation.js'],
  'view-visibility-shortcut-ui': [
    'src/renderer/src/components/help/HelpPage.vue',
    'src/renderer/src/components/list/{ActionBar,SearchBox}.vue',
    'src/main/index.js',
    'src/preload/index.js',
    'src/renderer/src/components/help/help-content.js',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/ui/ShortcutRecorder.vue'
  ],
  'weather-ipc': ['src/renderer/src/components/month/MonthWorkspace.vue'],
  'windows-sandbox-permissions': ['build/windows/installer.nsh', 'electron-builder.win.yml'],
  'window-z-order-main-wiring': ['src/main/windows/z-order-runtime.js']
}

// A reviewed protection scope is not a recorded test pass. Actual completion,
// platform and simulation evidence belong to the immutable attempt reports.
const reviewedScopes = Object.freeze({
  'tests/logging-motion-overhead-electron.mjs': {
    contracts: ['C-007', 'C-013'],
    features: ['diagnostic-motion-overhead']
  },
  'tests/application-settings.test.js': {
    contracts: ['C-003'],
    features: ['application-settings']
  },
  'tests/settings-runtime.test.js': { contracts: ['C-003'], features: ['settings-runtime'] },
  'tests/settings-repository-db.mjs': { contracts: ['C-003'], features: ['settings-repository'] },
  'tests/settings-runtime-electron.mjs': {
    contracts: ['C-003', 'C-007'],
    features: ['settings-runtime']
  },
  'tests/settings-write-queue.test.js': {
    contracts: ['C-003'],
    features: ['settings-write-queue']
  },
  'tests/settings-queue-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['settings-write-queue']
  },
  'tests/settings-form-models.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['settings-forms']
  },
  'tests/dock-settings-ui.test.js': { contracts: ['C-009'], features: ['settings-forms'] },
  'tests/main-window-host.test.js': { contracts: ['C-007'], features: ['main-window-host'] },
  'tests/window-geometry-persistence.test.js': {
    contracts: ['C-003', 'C-007'],
    features: ['window-geometry']
  },
  'tests/application-lifecycle.test.js': {
    contracts: ['C-001', 'C-013'],
    features: ['application-lifecycle']
  },
  'tests/remote-shutdown.test.js': { contracts: ['C-010'], features: ['remote-shutdown'] },
  'tests/application-lifecycle-electron.mjs': {
    contracts: ['C-001', 'C-013'],
    features: ['application-lifecycle']
  },
  'tests/database-runtime.test.js': { contracts: ['C-001'], features: ['database-runtime'] },
  'tests/platform-support.test.js': {
    contracts: ['C-006', 'C-007'],
    features: ['windows-platform']
  },
  'tests/device-info.test.js': { contracts: ['C-010'], features: ['windows-device-info'] },
  'tests/database-runtime-db.mjs': { contracts: ['C-001'], features: ['database-runtime'] },
  'tests/attachment-recovery-reset-electron.mjs': {
    contracts: ['C-002', 'C-004'],
    features: ['attachment-recovery']
  },
  'tests/attachment-reset-recovery.test.js': {
    contracts: ['C-002', 'C-004'],
    features: ['attachment-recovery']
  },
  'tests/note-commands.test.js': { contracts: ['C-002', 'C-004'], features: ['note-commands'] },
  'tests/note-draft-conflict-electron.mjs': {
    contracts: ['C-002', 'C-004'],
    features: ['note-commands']
  },
  'tests/sticky-note-commands.test.js': {
    contracts: ['C-004'],
    features: ['sticky-note-commands']
  },
  'tests/sticky-persistence-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['sticky-note-commands']
  },
  'tests/register-app-ipc.test.js': { contracts: ['C-010', 'C-012'], features: ['app-ipc'] },
  'tests/register-logging-ipc.test.js': {
    contracts: ['C-012', 'C-013'],
    features: ['logging-ipc']
  },
  'tests/register-remote-notice-ipc.test.js': {
    contracts: ['C-010', 'C-012'],
    features: ['remote-notice-ipc']
  },
  'tests/register-wallpaper-ipc.test.js': {
    contracts: ['C-002', 'C-003', 'C-012'],
    features: ['wallpaper-ipc']
  },
  'tests/window-motion-backend.test.js': {
    contracts: ['C-007'],
    features: ['windows-motion-backend']
  },
  'tests/logging-actions-electron.mjs': {
    contracts: ['C-013'],
    features: ['logging-ipc', 'diagnostic-export']
  },
  'tests/app-ipc-electron.mjs': {
    contracts: ['C-002', 'C-003', 'C-010', 'C-012'],
    features: ['app-ipc', 'remote-notice-ipc', 'wallpaper-ipc']
  },
  'tests/workspace-runtime.test.js': {
    contracts: ['C-009', 'C-010'],
    features: ['workspace-runtime']
  },
  'tests/modal-queue-electron.mjs': { contracts: ['C-009'], features: ['workspace-runtime'] },
  'tests/native-leaf-runtime.test.js': { contracts: ['C-007'], features: ['native-leaf-runtime'] },
  'tests/window-layer-diagnostics.test.js': {
    contracts: ['C-007'],
    features: ['native-leaf-runtime']
  },
  'tests/native-leaf-runtime-electron.mjs': {
    contracts: ['C-007'],
    features: ['native-leaf-runtime']
  },
  'tests/window-z-order-main-wiring.test.js': {
    contracts: ['C-007'],
    features: ['native-leaf-runtime']
  },
  'tests/capture-window-integration.test.js': {
    contracts: ['C-007', 'C-008'],
    features: ['capture-window-restoration']
  },
  'tests/capture-coordinator.test.js': {
    contracts: ['C-008', 'C-012'],
    features: ['capture-window-restoration']
  },
  'tests/capture-business-electron.mjs': {
    contracts: ['C-008'],
    features: ['capture-window-restoration']
  },
  'tests/timeline-list-model.test.js': { contracts: ['C-009'], features: ['list-timeline'] },
  'tests/business-note-reminders.test.js': {
    contracts: ['C-006', 'C-012'],
    features: ['reminder-lifecycle']
  },
  'tests/weather-notice-request-lifecycle.test.js': {
    contracts: ['C-003', 'C-009', 'C-010'],
    features: ['weather-lifecycle', 'remote-notice-ipc']
  },
  'tests/renderer-recovery-electron.mjs': {
    contracts: ['C-007', 'C-009'],
    features: ['renderer-recovery', 'window-drag', 'presentation-runtime']
  },
  'tests/weather-notice-lifecycle-electron.mjs': {
    contracts: ['C-002', 'C-003', 'C-009', 'C-010', 'C-012'],
    features: ['weather-lifecycle', 'workspace-runtime', 'remote-notice-ipc']
  },
  'tests/note-list-refresh-electron.mjs': { contracts: ['C-009'], features: ['list-timeline'] },
  'tests/custom-list-model.test.js': { contracts: ['C-009'], features: ['list-custom'] },
  'tests/note-list-custom-electron.mjs': { contracts: ['C-009'], features: ['list-custom'] },
  'tests/tag-group-list-model.test.js': { contracts: ['C-009'], features: ['list-tag-group'] },
  'tests/tag-group-ordering-ui.test.js': { contracts: ['C-009'], features: ['list-tag-group'] },
  'tests/note-list-tag-refresh-electron.mjs': {
    contracts: ['C-009'],
    features: ['list-tag-group']
  },
  'tests/dock-runtime.test.js': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/dock-main-wiring.test.js': { contracts: ['C-003', 'C-007'], features: ['dock-runtime'] },
  'tests/dock-runtime-electron.mjs': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/window-drag-controller.test.js': { contracts: ['C-007'], features: ['window-drag'] },
  'tests/window-motion-diagnostics.test.js': {
    contracts: ['C-007', 'C-011'],
    features: ['window-motion-diagnostics']
  },
  'tests/window-motion-diagnostics-native.mjs': {
    contracts: ['C-007', 'C-011'],
    features: ['window-motion-diagnostics']
  },
  'tests/window-drag-diagnostics.test.js': {
    contracts: ['C-007', 'C-011'],
    features: ['window-drag-diagnostics']
  },
  'tests/titlebar-native-drag-electron.mjs': { contracts: ['C-007'], features: ['window-drag'] },
  'tests/presentation-runtime.test.js': {
    contracts: ['C-007'],
    features: ['presentation-runtime']
  },
  'tests/presentation-mode-architecture.test.js': {
    contracts: ['C-007'],
    features: ['presentation-runtime']
  },
  'tests/presentation-mode-controller.test.js': {
    contracts: ['C-007'],
    features: ['presentation-runtime']
  },
  'tests/presentation-mode-electron.mjs': {
    contracts: ['C-007'],
    features: ['presentation-runtime']
  },
  'tests/main-view-navigation.test.js': {
    contracts: ['C-003', 'C-007'],
    features: ['view-navigation']
  },
  'tests/view-switch-geometry-order.test.js': {
    contracts: ['C-003', 'C-007'],
    features: ['view-navigation']
  },
  'tests/settings-write-coordinator.test.js': {
    contracts: ['C-003'],
    features: ['settings-write']
  },
  'tests/blur-settings-main-wiring.test.js': { contracts: ['C-003'], features: ['settings-write'] },
  'tests/background-settings-coordinator.test.js': {
    contracts: ['C-003', 'C-007'],
    features: ['background-settings']
  },
  'tests/background-navigation-electron.mjs': {
    contracts: ['C-003', 'C-007'],
    features: ['background-settings', 'view-navigation']
  },
  'tests/calendar-workspace-model.test.js': {
    contracts: ['C-009'],
    features: ['calendar-workspace']
  },
  'tests/calendar-workspace-preferences.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['calendar-workspace']
  },
  'tests/calendar-workspace-lifecycle.test.js': {
    contracts: ['C-009'],
    features: ['calendar-workspace']
  },
  'tests/calendar-recurring-preview-ui.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['calendar-workspace']
  },
  'tests/calendar-workspace-electron.mjs': {
    contracts: ['C-009'],
    features: ['calendar-workspace']
  },
  'tests/business-mutation-admission.test.js': {
    contracts: ['C-001', 'C-004'],
    features: ['business-admission']
  },
  'tests/business-data-clear.test.js': {
    contracts: ['C-001', 'C-004', 'C-013'],
    features: ['business-admission', 'feature-lifecycle']
  },
  'tests/business-clear-admission-electron.mjs': {
    contracts: ['C-001', 'C-004', 'C-006'],
    features: ['business-admission', 'reminder-lifecycle']
  },
  'tests/feature-runtime.test.js': { contracts: ['C-013'], features: ['feature-lifecycle'] },
  'tests/feature-runtime-electron.mjs': {
    contracts: ['C-001', 'C-004', 'C-013'],
    features: ['feature-lifecycle', 'business-admission']
  },
  'tests/main-tray-controller.test.js': { contracts: ['C-013'], features: ['main-tray'] },
  'tests/notification-activation.test.js': {
    contracts: ['C-006', 'C-013'],
    features: ['notification-activation']
  },
  'tests/sticky-service.test.js': { contracts: ['C-006', 'C-013'], features: ['sticky-lifecycle'] },
  'tests/reminder-service.test.js': {
    contracts: ['C-006', 'C-013'],
    features: ['reminder-lifecycle']
  },
  'tests/weather-ipc.test.js': { contracts: ['C-010', 'C-012'], features: ['weather-lifecycle'] },
  'tests/weather-refresh-controller.test.js': {
    contracts: ['C-010'],
    features: ['weather-lifecycle']
  },
  'tests/native-runtime-gate.test.js': {
    contracts: ['C-007', 'C-013'],
    features: ['native-startup-gate']
  },
  'tests/diagnostic-noise-and-location.test.js': {
    contracts: ['C-013'],
    features: ['diagnostic-consumers']
  },
  'tests/action-bar-accessibility.test.js': {
    contracts: ['C-009'],
    features: ['action-bar-accessibility']
  },
  'tests/app-update-wiring.test.js': { contracts: ['C-010'], features: ['app-update-wiring'] },
  'tests/clipboard-and-selection.test.js': {
    contracts: ['C-009'],
    features: ['clipboard-and-selection']
  },
  'tests/editing-draft-session.test.js': {
    contracts: ['C-004'],
    features: ['editing-draft-session']
  },
  'tests/help-navigation-ui.test.js': { contracts: ['C-009'], features: ['help-navigation-ui'] },
  'tests/help-support-ui.test.js': { contracts: ['C-009'], features: ['help-support-ui'] },
  'tests/historical-note-backfill-ui.test.js': {
    contracts: ['C-006'],
    features: ['historical-note-backfill-ui']
  },
  'tests/image-only-note.test.js': { contracts: ['C-002', 'C-004'], features: ['image-only-note'] },
  'tests/month-calendar-context-menu.test.js': {
    contracts: ['C-009'],
    features: ['month-calendar-context-menu']
  },
  'tests/month-note-creator-intent.test.js': {
    contracts: ['C-004', 'C-009'],
    features: ['calendar-creation-intent']
  },
  'tests/template-submit-lock.test.js': {
    contracts: ['C-004', 'C-009'],
    features: ['template-submit-lock']
  },
  'tests/date-time-picker-relative-now.test.js': {
    contracts: ['C-004', 'C-009'],
    features: ['relative-now-picker']
  },
  'tests/month-event-bar.test.js': { contracts: ['C-009'], features: ['month-event-bar'] },
  'tests/native-edge-monitor-source.test.js': {
    contracts: ['C-007'],
    features: ['native-edge-monitor-source']
  },
  'tests/note-duration-mode.test.js': {
    contracts: ['C-004', 'C-009'],
    features: ['note-duration-mode']
  },
  'tests/note-list-motion.test.js': { contracts: ['C-009'], features: ['note-list-motion'] },
  'tests/note-remark.test.js': { contracts: ['C-003', 'C-004'], features: ['note-remark'] },
  'tests/note-text-color.test.js': { contracts: ['C-004', 'C-009'], features: ['note-text-color'] },
  'tests/package-native-config.test.js': {
    contracts: ['C-012'],
    features: ['package-native-config']
  },
  'tests/quick-note-edit.test.js': { contracts: ['C-004', 'C-009'], features: ['quick-note-edit'] },
  'tests/recent-local-day-range.test.js': {
    contracts: ['C-009'],
    features: ['recent-local-day-range']
  },
  'tests/security-hardening.test.js': { contracts: ['C-012'], features: ['security-hardening'] },
  'tests/settings-panel-density.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['settings-panel-density']
  },
  'tests/sticky-entry.test.js': {
    contracts: ['C-004', 'C-007', 'C-009'],
    features: ['sticky-entry']
  },
  'tests/tag-color-setting.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['tag-color-setting']
  },
  'tests/tag-selector-ui.test.js': { contracts: ['C-009'], features: ['tag-selector-ui'] },
  'tests/titlebar-icon-scale-ui.test.js': {
    contracts: ['C-009'],
    features: ['titlebar-icon-scale-ui']
  },
  'tests/ui-interaction-standard.test.js': {
    contracts: ['C-009'],
    features: ['ui-interaction-standard']
  },
  'tests/ui-scale.test.js': { contracts: ['C-009'], features: ['ui-scale'] },
  'tests/ui-z-index.test.js': { contracts: ['C-009'], features: ['ui-z-index'] },
  'tests/view-visibility-shortcut-ui.test.js': {
    contracts: ['C-007'],
    features: ['view-visibility-shortcut-ui']
  },
  'tests/capture-build-selection.test.js': {
    contracts: ['C-008', 'C-012'],
    features: ['capture-build-selection']
  },
  'tests/windows-sandbox-permissions.test.js': {
    contracts: ['C-012'],
    features: ['windows-sandbox-permissions']
  },
  'tests/ipc-authorization.test.js': { contracts: ['C-012'], features: ['ipc-authorization'] },
  'tests/ipc-arguments.test.js': { contracts: ['C-012', 'C-013'], features: ['ipc-arguments'] },
  'tests/attachment-rules.test.js': { contracts: ['C-002'], features: ['attachment-rules'] },
  'tests/note-scheduling-rules.test.js': {
    contracts: ['C-006'],
    features: ['note-scheduling-rules']
  },
  'tests/note-appearance.test.js': { contracts: ['C-009'], features: ['note-appearance'] },
  'tests/notification-policy.test.js': { contracts: ['C-006'], features: ['notification-policy'] },
  'tests/dock-transition-state.test.js': {
    contracts: ['C-007'],
    features: ['dock-transition-state']
  },
  'tests/deferred-window-restore.test.js': {
    contracts: ['C-007'],
    features: ['deferred-window-restore']
  },
  'tests/window-bounds.test.js': { contracts: ['C-007'], features: ['window-bounds'] },
  'tests/window-compact-geometry.test.js': {
    contracts: ['C-007'],
    features: ['window-compact-geometry']
  },
  'tests/window-profiles.test.js': { contracts: ['C-007'], features: ['window-profiles'] },
  'tests/native-edge-monitor.test.js': { contracts: ['C-007'], features: ['native-edge-monitor'] },
  'tests/editing-draft-guard.test.js': { contracts: ['C-004'], features: ['editing-draft-guard'] },
  'tests/calendar-grid-navigation.test.js': {
    contracts: ['C-009'],
    features: ['calendar-grid-navigation']
  },
  'tests/calendar-day-preview.test.js': {
    contracts: ['C-009'],
    features: ['calendar-day-preview']
  },
  'tests/capture-assets.test.js': { contracts: ['C-008'], features: ['capture-assets'] },
  'tests/capture-image-worker.test.js': {
    contracts: ['C-008'],
    features: ['capture-image-worker']
  },
  'tests/capture-recorder-owner.test.js': {
    contracts: ['C-008'],
    features: ['capture-recorder-owner']
  },
  'tests/notification-guard.test.js': { contracts: ['C-006'], features: ['notification-guard'] },
  'tests/tag-rules.test.js': { contracts: ['C-005', 'C-009'], features: ['tag-rules'] },
  'tests/shortcut-status.test.js': { contracts: ['C-007', 'C-008'], features: ['shortcut-status'] },
  'tests/capture-package-smoke.cjs': {
    contracts: ['C-008', 'C-012'],
    features: ['capture-package-smoke']
  },
  'tests/sandbox-diagnostics-win.cjs': {
    contracts: ['C-012'],
    features: ['sandbox-diagnostics-win']
  },
  'tests/sandbox-electron-win.ps1': { contracts: ['C-012'], features: ['sandbox-electron-win'] },
  'tests/sandbox-installer-win.ps1': { contracts: ['C-012'], features: ['sandbox-installer-win'] },
  'tests/sandbox-permissions-win.ps1': {
    contracts: ['C-012'],
    features: ['sandbox-permissions-win']
  },
  'tests/logging-worker-asar-electron.mjs': {
    contracts: ['C-013'],
    features: ['logging-worker-asar-electron']
  },
  'tests/logging-overhead-electron.mjs': {
    contracts: ['C-013'],
    features: ['logging-overhead-electron']
  },
  'tests/capture-host-electron.mjs': { contracts: ['C-008'], features: ['capture-host-electron'] },
  'tests/capture-lifecycle-electron.mjs': {
    contracts: ['C-008'],
    features: ['capture-lifecycle-electron']
  },
  'tests/maturity-db.mjs': { contracts: ['C-001', 'C-009', 'C-013'], features: ['maturity-db'] },
  'tests/almanac-engine.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/almanac-requests.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/app-update.test.js': { contracts: ['C-010'], features: ['application-update'] },
  'tests/calendar-date-rules.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/calendar-event-layout.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/calendar-ipc.test.js': { contracts: ['C-009', 'C-012'], features: ['calendar-ipc'] },
  'tests/calendar-metadata.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/calendar-service.test.js': { contracts: ['C-009'], features: ['calendar-domain'] },
  'tests/capture-shortcut.test.js': { contracts: ['C-008'], features: ['capture-shortcut'] },
  'tests/daily-report-ipc.test.js': {
    contracts: ['C-011', 'C-012'],
    features: ['daily-report-ipc']
  },
  'tests/daily-report.test.js': { contracts: ['C-011'], features: ['daily-report'] },
  'tests/diagnostic-actions.test.js': { contracts: ['C-013'], features: ['diagnostic-protocol'] },
  'tests/diagnostic-controller.test.js': {
    contracts: ['C-012', 'C-013'],
    features: ['diagnostic-ipc']
  },
  'tests/diagnostic-evidence.test.js': { contracts: ['C-013'], features: ['diagnostic-protocol'] },
  'tests/diagnostic-ipc.test.js': { contracts: ['C-012', 'C-013'], features: ['diagnostic-ipc'] },
  'tests/diagnostic-policy.test.js': { contracts: ['C-013'], features: ['diagnostic-protocol'] },
  'tests/diagnostic-transport.test.js': { contracts: ['C-013'], features: ['diagnostic-protocol'] },
  'tests/dock-config.test.js': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/dock-display-rebuild.test.js': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/dock-health.test.js': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/dock-native-status-observer.test.js': {
    contracts: ['C-007', 'C-013'],
    features: ['dock-native-observation']
  },
  'tests/error-capture.test.js': { contracts: ['C-013'], features: ['renderer-error-capture'] },
  'tests/help-quick-links.test.js': { contracts: ['C-009'], features: ['help-navigation'] },
  'tests/help-scroll-motion.test.js': { contracts: ['C-009'], features: ['help-navigation'] },
  'tests/help-search.test.js': { contracts: ['C-009'], features: ['help-navigation'] },
  'tests/holiday-data-rules.test.js': { contracts: ['C-009', 'C-010'], features: ['holiday-data'] },
  'tests/holiday-data-service.test.js': {
    contracts: ['C-009', 'C-010'],
    features: ['holiday-data']
  },
  'tests/log-record-text.test.js': { contracts: ['C-013'], features: ['log-viewer-text'] },
  'tests/log-store.test.js': { contracts: ['C-013'], features: ['log-worker-storage'] },
  'tests/log-writer-client.test.js': { contracts: ['C-013'], features: ['log-worker-storage'] },
  'tests/main-logging.test.js': { contracts: ['C-013'], features: ['log-worker-storage'] },
  'tests/maturity-interactions.test.js': {
    contracts: ['C-004', 'C-007', 'C-009', 'C-013'],
    features: [
      'editing-draft-guard',
      'renderer-recovery',
      'popover-geometry',
      'thumbnail-cache',
      'scheduler-retry'
    ]
  },
  'tests/modal-blur.test.js': { contracts: ['C-009'], features: ['workspace-modal-lifecycle'] },
  'tests/modal-queue.test.js': { contracts: ['C-009'], features: ['workspace-modal-lifecycle'] },
  'tests/note-text-color-rules.test.js': {
    contracts: ['C-004', 'C-009'],
    features: ['note-text-color']
  },
  'tests/note-weather.test.js': { contracts: ['C-010'], features: ['weather-lifecycle'] },
  'tests/notice-markdown.test.js': {
    contracts: ['C-010', 'C-012'],
    features: ['notice-content-safety']
  },
  'tests/performance-attribution.test.js': {
    contracts: ['C-013'],
    features: ['performance-observation']
  },
  'tests/performance-diagnostics.test.js': {
    contracts: ['C-013'],
    features: ['performance-observation']
  },
  'tests/pointer-anchored-popovers.test.js': {
    contracts: ['C-009'],
    features: ['popover-geometry-and-motion']
  },
  'tests/queued-modal-lifecycle.test.js': {
    contracts: ['C-009'],
    features: ['workspace-modal-lifecycle']
  },
  'tests/recurrence-rules.test.js': {
    contracts: ['C-005'],
    features: ['recurrence-rules-and-preview']
  },
  'tests/recurring-note-preview.test.js': {
    contracts: ['C-005'],
    features: ['recurrence-rules-and-preview']
  },
  'tests/reminder-notification.test.js': {
    contracts: ['C-006'],
    features: ['reminder-notification']
  },
  'tests/remote-health-cache.test.js': {
    contracts: ['C-010'],
    features: ['remote-health-and-session']
  },
  'tests/scheduler.test.js': { contracts: ['C-013'], features: ['scheduler-lifecycle'] },
  'tests/settings-schema.test.js': {
    contracts: ['C-003', 'C-009'],
    features: ['shared-settings-schema']
  },
  'tests/sliding-workspace.test.js': {
    contracts: ['C-009'],
    features: ['workspace-modal-lifecycle']
  },
  'tests/sticky-diagnostic-ipc.test.js': {
    contracts: ['C-012', 'C-013'],
    features: ['diagnostic-ipc']
  },
  'tests/sticky-tray-menu.test.js': { contracts: ['C-007', 'C-009'], features: ['sticky-tray'] },
  'tests/sticky-utils.test.js': {
    contracts: ['C-007'],
    features: ['sticky-validation-and-placement']
  },
  'tests/system-diagnostics.test.js': {
    contracts: ['C-012', 'C-013'],
    features: ['system-diagnostic-export']
  },
  'tests/template-scheduler-guard.test.js': {
    contracts: ['C-005'],
    features: ['template-scheduler-guard']
  },
  'tests/template-ui-utils.test.js': {
    contracts: ['C-005', 'C-009'],
    features: ['template-ui-rules']
  },
  'tests/ui-popover-motion.test.js': {
    contracts: ['C-009'],
    features: ['popover-geometry-and-motion']
  },
  'tests/view-visibility-shortcut-service.test.js': {
    contracts: ['C-007'],
    features: ['view-visibility-shortcut']
  },
  'tests/view-visibility-shortcut.test.js': {
    contracts: ['C-007'],
    features: ['view-visibility-shortcut']
  },
  'tests/wallpaper-crop.test.js': { contracts: ['C-009'], features: ['wallpaper-crop-geometry'] },
  'tests/weather-rules.test.js': { contracts: ['C-010'], features: ['weather-lifecycle'] },
  'tests/weather-selection-path.test.js': { contracts: ['C-010'], features: ['weather-lifecycle'] },
  'tests/weather-service.test.js': { contracts: ['C-010'], features: ['weather-lifecycle'] },
  'tests/ci-test-selection.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/run-focused-tests.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-build-descriptors.test.js': {
    contracts: ['C-012'],
    features: ['test-infrastructure']
  },
  'tests/test-build-provenance.test.js': {
    contracts: ['C-012'],
    features: ['test-infrastructure']
  },
  'tests/test-entrypoints.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-manifest.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-result-adapters.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-result-recorder.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-runner.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'tests/test-selection.test.js': { contracts: ['C-012'], features: ['test-infrastructure'] },
  'native_capture/tests/clipboard_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-clipboard']
  },
  'native_capture/tests/core_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-image-document']
  },
  'native_capture/tests/pin_halo_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-pin-halo']
  },
  'native_capture/tests/polish_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-annotation', 'capture-native-feedback']
  },
  'native_capture/tests/selection_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-selection']
  },
  'native_capture/tests/ui_test.cpp': { contracts: ['C-008'], features: ['capture-native-ui'] },
  'native_capture/tests/ux_test.cpp': {
    contracts: ['C-008'],
    features: ['capture-native-annotation']
  },
  'tests/almanac-weather-electron.mjs': {
    contracts: ['C-003', 'C-009', 'C-010'],
    features: ['weather-lifecycle', 'calendar-workspace']
  },
  'tests/date-context-controls-electron.mjs': {
    contracts: ['C-003', 'C-009', 'C-010'],
    features: ['weather-lifecycle', 'calendar-workspace']
  },
  'tests/attachment-loading-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-attachments-ui']
  },
  'tests/attachment-storage-electron.mjs': {
    contracts: ['C-002'],
    features: ['attachment-storage']
  },
  'tests/blur-z-order-electron.mjs': { contracts: ['C-007'], features: ['native-leaf-runtime'] },
  'tests/calendar-font-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['calendar-workspace']
  },
  'tests/daily-report-electron.mjs': {
    contracts: ['C-011', 'C-009'],
    features: ['daily-report-dialog']
  },
  'tests/dock-trigger-electron.mjs': { contracts: ['C-007'], features: ['dock-runtime'] },
  'tests/draft-dialog-ui-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['editing-draft-dialog']
  },
  'tests/first-use-notice-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['onboarding-notice']
  },
  'tests/help-center-electron.mjs': { contracts: ['C-009'], features: ['help-center'] },
  'tests/list-minimal-mode-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['list-minimal-mode']
  },
  'tests/main-view-enhancements-electron.mjs': {
    contracts: ['C-009', 'C-010'],
    features: ['calendar-workspace', 'weather-lifecycle']
  },
  'tests/maturity-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-commands', 'editing-draft-dialog']
  },
  'tests/maturity-regressions-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-commands', 'editing-draft-dialog']
  },
  'tests/month-context-menu-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['calendar-workspace']
  },
  'tests/month-day-preview-status-electron.mjs': {
    contracts: ['C-009'],
    features: ['calendar-workspace']
  },
  'tests/month-event-text-color-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-text-color', 'calendar-workspace']
  },
  'tests/month-view-electron.mjs': {
    contracts: ['C-003', 'C-004', 'C-007', 'C-009'],
    features: ['calendar-workspace', 'view-navigation']
  },
  'tests/note-draft-conflict-ui-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-commands']
  },
  'tests/note-duration-electron.mjs': {
    contracts: ['C-001', 'C-004', 'C-006', 'C-009'],
    features: ['note-duration', 'notification-activation']
  },
  'tests/note-list-animation-electron.mjs': {
    contracts: ['C-009'],
    features: ['list-presence-motion']
  },
  'tests/note-list-completion-electron.mjs': {
    contracts: ['C-009'],
    features: ['list-timeline', 'list-tag-group']
  },
  'tests/note-list-toolbar-electron.mjs': { contracts: ['C-009'], features: ['list-toolbar'] },
  'tests/note-text-color-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['note-text-color']
  },
  'tests/notice-admin-electron.mjs': {
    contracts: ['C-009', 'C-010'],
    features: ['notice-admin-tooling']
  },
  'tests/notice-markdown-electron.mjs': {
    contracts: ['C-009', 'C-010', 'C-012'],
    features: ['notice-markdown']
  },
  'tests/quick-note-edit-electron.mjs': {
    contracts: ['C-004', 'C-009'],
    features: ['quick-note-edit']
  },
  'tests/recurring-preview-electron.mjs': {
    contracts: ['C-005', 'C-009'],
    features: ['calendar-recurring-preview']
  },
  'tests/reminder-native-acceptance.cjs': {
    contracts: ['C-006'],
    features: ['notification-activation']
  },
  'tests/reminders-electron.mjs': {
    contracts: ['C-006', 'C-009', 'C-012'],
    features: ['reminder-lifecycle', 'notification-activation']
  },
  'tests/settings-scroll-memory-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['settings-session-memory', 'settings-forms']
  },
  'tests/template-quarterly-electron.mjs': {
    contracts: ['C-005', 'C-009'],
    features: ['quarterly-templates']
  },
  'tests/thumbnail-benchmark-electron.mjs': {
    contracts: ['C-002', 'C-013'],
    features: ['attachment-thumbnail-cache']
  },
  'tests/titlebar-icon-scale-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['titlebar-appearance']
  },
  'tests/ui-components-electron.mjs': { contracts: ['C-009'], features: ['ui-component-fixtures'] },
  'tests/ui-feedback-app-electron.mjs': { contracts: ['C-009'], features: ['ui-feedback-app'] },
  'tests/ui-feedback-electron.mjs': { contracts: ['C-009'], features: ['ui-feedback-fixtures'] },
  'tests/ui-responsive-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['ui-responsive']
  },
  'tests/new-note-workflow-electron.mjs': {
    contracts: ['C-002', 'C-003', 'C-009'],
    features: ['note-duration-mode', 'editing-draft-session', 'ui-responsive']
  },
  'tests/note-three-view-rules-ui-electron.mjs': {
    contracts: ['C-004', 'C-006', 'C-009'],
    features: ['note-state-scheduling', 'calendar-creation-intent', 'view-navigation']
  },
  'tests/note-startup-recovery-electron.mjs': {
    contracts: ['C-004', 'C-005', 'C-006'],
    features: ['note-state-scheduling', 'recurrence-lifecycle', 'scheduler-recovery']
  },
  'tests/view-visibility-shortcut-electron.mjs': {
    contracts: ['C-003', 'C-007', 'C-009'],
    features: ['view-visibility-shortcut', 'main-tray']
  },
  'tests/wallpaper-storage-electron.mjs': { contracts: ['C-002'], features: ['wallpaper-storage'] },
  'tests/weather-settings-electron.mjs': {
    contracts: ['C-003', 'C-009', 'C-010'],
    features: ['weather-lifecycle', 'settings-forms']
  },
  'tests/week-day-panel-electron.mjs': { contracts: ['C-009'], features: ['calendar-workspace'] },
  'tests/week-view-electron.mjs': {
    contracts: ['C-003', 'C-007', 'C-009'],
    features: ['calendar-workspace', 'view-navigation']
  },
  'tests/window-border-electron.mjs': {
    contracts: ['C-003', 'C-009'],
    features: ['window-border']
  },
  'tests/window-control-drag-electron.mjs': {
    contracts: ['C-007', 'C-008'],
    features: ['window-drag', 'capture-window-restoration']
  },
  'tests/window-frame-electron.mjs': { contracts: ['C-007'], features: ['windows-motion-backend'] },
  'tests/window-state-matrix-electron.mjs': {
    contracts: ['C-007', 'C-008'],
    features: ['dock-runtime', 'presentation-runtime', 'capture-window-restoration']
  },
  'tests/window-z-order-electron.mjs': { contracts: ['C-007'], features: ['native-leaf-runtime'] },
  'tests/window-z-order-recovery-electron.mjs': {
    contracts: ['C-007'],
    features: ['native-leaf-runtime', 'view-navigation']
  },
  'tests/backend-integration.mjs': {
    contracts: ['C-001', 'C-002', 'C-005', 'C-006', 'C-009'],
    features: ['database-contracts']
  },
  'tests/note-state-db.mjs': {
    contracts: ['C-001', 'C-004', 'C-006'],
    features: ['note-state-scheduling', 'database-contracts']
  },
  'tests/recurrence-lifecycle-db.mjs': {
    contracts: ['C-005', 'C-006'],
    features: ['recurrence-lifecycle', 'database-contracts']
  },
  'tests/note-duration-db.mjs': { contracts: ['C-001', 'C-004'], features: ['database-contracts'] },
  'tests/note-list-completion-db.mjs': {
    contracts: ['C-001', 'C-009'],
    features: ['database-contracts']
  },
  'tests/note-remark-db.mjs': { contracts: ['C-001', 'C-004'], features: ['database-contracts'] },
  'tests/note-text-color-db.mjs': {
    contracts: ['C-001', 'C-004'],
    features: ['database-contracts']
  },
  'tests/recurring-preview-db.mjs': { contracts: ['C-005'], features: ['database-contracts'] },
  'tests/reminder-database-integration.mjs': {
    contracts: ['C-006'],
    features: ['database-contracts']
  }
})

// Explicit consumers loaded through the built app or dynamic helpers are reviewed
// here; they are candidates, never an automatic transitive test selection.
const extraSourceDependencies = {
  'tests/renderer-resource-lifetime-electron.mjs': [
    'tests/fixtures/renderer-resource-lifetime/index.html',
    'tests/fixtures/renderer-resource-lifetime/main.js',
    'tests/fixtures/renderer-resource-lifetime/preload.cjs',
    'src/renderer/src/components/note/ImagePicker.vue',
    'src/renderer/src/components/note/ImagePreview.vue'
  ],
  'tests/date-context-controls-electron.mjs': [
    'src/renderer/src/components/almanac/DateContextDetails.vue',
    'src/renderer/src/components/almanac/DateContextPopover.vue',
    'src/renderer/src/components/almanac/DateContextBadge.vue',
    'src/renderer/src/components/almanac/DateContextSummary.vue',
    'src/renderer/src/composables/useDateContextSettings.js',
    'src/renderer/src/components/weather/WeatherSettings.vue',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/components/month/MonthCalendarGrid.vue',
    'src/renderer/src/components/month/MonthDayPanel.vue',
    'src/renderer/src/components/month/MonthCalendarToolbar.vue'
  ],
  'tests/note-startup-recovery-electron.mjs': [
    'src/main/bootstrap.js',
    'src/main/db/db-notes.js',
    'src/main/db/db-templates.js',
    'src/main/services/recurrence.js',
    'src/main/services/scheduler.js',
    'src/preload/index.js'
  ],
  'tests/note-three-view-rules-ui-electron.mjs': [
    'src/main/db/db-notes.js',
    'src/main/notes/note-commands.js',
    'src/preload/index.js',
    'src/renderer/src/App.vue',
    'src/renderer/src/MonthApp.vue',
    'src/renderer/src/components/list/NewNotePanel.vue',
    'src/renderer/src/components/month/MonthNoteCreator.vue',
    'src/renderer/src/components/month/MonthCalendarGrid.vue',
    'src/renderer/src/components/note/NoteEditor.vue',
    'src/renderer/src/composables/useNoteStateDraft.js',
    'src/renderer/src/composables/useCalendarWorkspacePreferences.js',
    'src/shared/settings-schema.js'
  ],
  'tests/historical-note-move-electron.mjs': [
    'src/renderer/src/components/month/HistoricalNoteMoveControl.vue',
    'src/renderer/src/components/month/MonthCalendarToolbar.vue',
    'src/renderer/src/components/month/MonthCalendarGrid.vue',
    'src/renderer/src/components/month/MonthWorkspace.vue',
    'src/renderer/src/composables/useCalendarWorkspacePreferences.js',
    'src/shared/settings-schema.js',
    'src/shared/historical-note-move-rules.js',
    'src/main/settings/application-settings.js',
    'src/main/settings/settings-runtime.js',
    'src/main/settings/settings-write-coordinator.js',
    'src/main/services/automatic-note-move.js',
    'src/main/db/db-historical-note-move.js',
    'src/main/ipc/register-business-ipc.js',
    'src/main/index.js',
    'src/preload/index.js'
  ],
  'tests/reminders-electron.mjs': [
    'src/main/services/ReminderService.js',
    'src/main/services/NotificationService.js',
    'src/main/services/ReminderWindow.js',
    'src/renderer/src/components/note/NoteEditor.vue'
  ],
  'tests/month-note-creator-intent.test.js': [
    'src/renderer/src/components/month/MonthNoteCreator.vue',
    'src/renderer/src/composables/useNoteStateDraft.js',
    'src/renderer/src/composables/useDraftProtection.js',
    'src/shared/note-scheduling-rules.js'
  ],
  'tests/template-submit-lock.test.js': [
    'src/renderer/src/components/template/TemplateForm.vue',
    'src/renderer/src/utils/anchoredPopover.js'
  ],
  'tests/date-time-picker-relative-now.test.js': [
    'src/renderer/src/components/ui/DateTimePicker.vue'
  ],
  'tests/daily-report-ipc.test.js': [
    'src/main/ipc/ipc-authorization.js',
    'src/main/services/daily-report.js',
    'src/main/db/db-connection.js',
    'src/shared/calendar/calendar-date-rules.js'
  ],
  'tests/daily-report-electron.mjs': [
    'tests/helpers/test-result-recorder.cjs',
    'src/main/index.js',
    'src/main/ipc/register-daily-report-ipc.js',
    'src/main/ipc/ipc-authorization.js',
    'src/main/services/daily-report.js',
    'src/main/db/db-notes.js',
    'src/main/db/db-tags.js',
    'src/main/db/db-connection.js',
    'src/preload/index.js',
    'src/shared/calendar/calendar-date-rules.js',
    'src/renderer/src/App.vue',
    'src/renderer/src/components/report/DailyReportButton.vue',
    'src/renderer/src/components/report/DailyReportDialog.vue',
    'src/renderer/src/components/ui/TagSelector.vue',
    'src/renderer/src/components/ui/TagSelectorRow.vue',
    'src/renderer/src/components/ui/DatePicker.vue',
    'src/renderer/src/components/ui/ConfirmDialog.vue',
    'src/renderer/src/components/ui/AppModalShell.vue',
    'src/renderer/src/components/ui/BaseButton.vue',
    'src/renderer/src/utils/modalFocus.js',
    'src/renderer/src/utils/modalBlur.js',
    'src/renderer/src/utils/modalQueue.js',
    'src/renderer/src/utils/anchoredPopover.js',
    'src/renderer/src/utils/popoverMotion.js',
    'src/renderer/src/utils/inputComposition.js',
    'src/renderer/src/composables/useQueuedModal.js',
    'src/renderer/src/composables/usePopoverLifecycle.js'
  ],
  'tests/logging-motion-overhead-electron.mjs': [
    'src/main/index.js',
    'src/preload/index.js',
    'src/main/ipc/register-logging-ipc.js',
    'src/main/logging/diagnostic-controller.js',
    'src/main/logging/performance-diagnostics.js',
    'src/main/logging/window-motion-diagnostics.js',
    'src/main/logging/log-writer-client.js',
    'src/main/logging/log-store.mjs',
    'src/main/windows/window-drag-controller.js',
    'src/main/window-motion/dock-runtime.js',
    'src/main/window-motion/index.js',
    'src/main/bridge/blur_bridge.js',
    'src/renderer/src/utils/windowDragDiagnostics.js',
    'src/renderer/src/components/system/AppTitlebar.vue',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/blur_api.cpp',
    'native_blur/blur_engine.cpp'
  ],
  'tests/logging-actions-electron.mjs': [
    'src/main/ipc/register-logging-ipc.js',
    'src/main/logging/diagnostic-controller.js',
    'src/main/logging/performance-diagnostics.js',
    'src/main/logging/window-motion-diagnostics.js',
    'src/main/logging/log-writer-client.js',
    'src/main/logging/log-store.mjs',
    'src/renderer/src/components/system/LogViewerDialog.vue',
    'src/main/index.js'
  ],
  'tests/app-ipc-electron.mjs': [
    'src/main/ipc/register-remote-notice-ipc.js',
    'src/main/ipc/register-wallpaper-ipc.js',
    'src/preload/index.js',
    'src/preload/diagnostic-ipc.js',
    'src/preload/diagnostic-transport.js',
    'src/main/db/db-reminders.js',
    'src/main/db/attachment-reset-journal.js',
    'src/shared/reminder-rules.js'
  ],
  'tests/settings-runtime-electron.mjs': [
    'src/main/settings/settings-runtime.js',
    'src/main/windows/main-window-host.js',
    'src/main/windows/window-geometry-persistence.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/index.js'
  ],
  'tests/settings-queue-electron.mjs': [
    'src/main/settings/settings-write-coordinator.js',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/system/settings/DockSettingsSection.vue',
    'src/renderer/src/components/system/settings/StickySettingsSection.vue',
    'src/renderer/src/composables/useSettingsWriteQueue.js',
    'src/renderer/src/composables/useDockSettingsForm.js',
    'src/renderer/src/composables/useStickySettingsForm.js',
    'src/main/index.js'
  ],
  'tests/application-lifecycle-electron.mjs': [
    'src/main/application/bootstrap.js',
    'src/main/application/shutdown-coordinator.js',
    'src/main/application/business-mutation-admission.js',
    'src/main/application/feature-runtime.js',
    'src/main/services/remote/remote-coordinator.js',
    'src/main/index.js'
  ],
  'tests/native-leaf-runtime-electron.mjs': [
    'src/main/windows/blur-runtime.js',
    'src/main/windows/z-order-runtime.js',
    'src/main/bridge/window-layer-diagnostics.js',
    'src/main/bridge/blur_bridge.js',
    'src/main/logging/window-motion-diagnostics.js',
    'src/shared/window-motion-metrics.js',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/window_motion_diagnostics.h',
    'src/main/index.js'
  ],
  'tests/note-list-refresh-electron.mjs': [
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/composables/useNoteListQuerySession.js',
    'src/renderer/src/composables/useTimelineListModel.js',
    'src/renderer/src/utils/noteListItem.js',
    'src/renderer/src/components/list/NoteCard.vue',
    'src/renderer/src/composables/useSharedMinuteClock.js',
    'src/renderer/src/composables/useTodayKey.js',
    'src/main/index.js'
  ],
  'tests/renderer-recovery-electron.mjs': [
    'src/main/windows/renderer-recovery.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/windows/presentation-runtime.js',
    'src/main/windows/window-drag-controller.js',
    'src/main/index.js',
    'src/preload/index.js'
  ],
  'tests/weather-notice-lifecycle-electron.mjs': [
    'src/renderer/src/components/weather/WeatherSettings.vue',
    'src/renderer/src/components/weather/ChinaAreaCascader.vue',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/system/RemoteNoticeDialog.vue',
    'src/renderer/src/components/ui/AppModalShell.vue',
    'src/renderer/src/App.vue',
    'src/renderer/src/composables/useWorkspaceNotices.js',
    'src/renderer/src/composables/useWorkspaceRuntime.js',
    'src/shared/weather-rules.js',
    'src/shared/settings-schema.js',
    'src/preload/index.js',
    'src/main/ipc/register-weather-ipc.js',
    'src/main/ipc/register-remote-notice-ipc.js',
    'src/main/db/db-remote-notices.js',
    'src/main/settings/application-settings.js'
  ],
  'tests/note-list-custom-electron.mjs': [
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/composables/useNoteListQuerySession.js',
    'src/renderer/src/composables/useCustomListModel.js',
    'src/renderer/src/utils/noteListItem.js',
    'src/main/index.js'
  ],
  'tests/note-list-tag-refresh-electron.mjs': [
    'src/renderer/src/components/list/NoteList.vue',
    'src/renderer/src/composables/useNoteListQuerySession.js',
    'src/renderer/src/composables/useTagGroupListModel.js',
    'src/renderer/src/utils/noteListItem.js',
    'src/main/index.js'
  ],
  'tests/capture-business-electron.mjs': [
    'src/main/capture/capture-window-integration.js',
    'src/main/application/business-mutation-admission.js',
    'src/main/index.js'
  ],
  'tests/background-navigation-electron.mjs': [
    'src/main/ipc/register-wallpaper-ipc.js',
    'src/main/settings/background-settings-coordinator.js',
    'src/main/settings/settings-write-coordinator.js',
    'src/main/windows/main-view-navigation.js',
    'src/main/windows/blur-runtime.js',
    'src/main/index.js'
  ],
  'tests/dock-runtime-electron.mjs': [
    'src/main/window-motion/dock-runtime.js',
    'src/main/logging/window-motion-diagnostics.js',
    'src/main/logging/performance-diagnostics.js',
    'src/shared/window-motion-metrics.js',
    'src/main/bridge/blur_bridge.js',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/window_motion_diagnostics.h',
    'src/main/index.js'
  ],
  'tests/calendar-workspace-electron.mjs': [
    'src/renderer/src/components/month/MonthWorkspace.vue',
    'src/renderer/src/composables/useCalendarWorkspaceModel.js',
    'src/renderer/src/composables/useCalendarWorkspacePreferences.js',
    'src/main/index.js'
  ],
  'tests/new-note-workflow-electron.mjs': [
    'src/renderer/src/composables/useNewNotePreferences.js',
    'src/renderer/src/composables/useNoteStateDraft.js',
    'src/renderer/src/components/note/NoteStateFields.vue',
    'src/renderer/src/components/note/NoteRemarkField.vue',
    'src/renderer/src/components/capture/CaptureDelivery.vue',
    'src/renderer/src/components/list/NewNotePanel.vue',
    'src/renderer/src/components/month/MonthNoteCreator.vue',
    'src/renderer/src/components/note/NoteDurationField.vue',
    'src/renderer/src/components/note/NoteEditor.vue',
    'src/renderer/src/components/note/ReminderChannelPicker.vue',
    'src/renderer/src/components/system/SettingsPanel.vue',
    'src/renderer/src/components/system/settings/DockSettingsSection.vue',
    'src/renderer/src/components/template/TemplateForm.vue',
    'src/renderer/src/components/template/TemplateFrequencySelector.vue',
    'src/renderer/src/components/ui/BaseButton.vue',
    'src/renderer/src/components/ui/FontSizeInput.vue'
  ],
  'tests/note-draft-conflict-ui-electron.mjs': [
    'src/shared/note-scheduling-rules.js',
    'src/main/notes/note-commands.js',
    'src/renderer/src/components/note/NoteEditor.vue',
    'src/renderer/src/components/note/NoteStateFields.vue',
    'src/renderer/src/composables/useNoteStateDraft.js'
  ],
  'tests/template-quarterly-electron.mjs': [
    'src/main/db/db-templates.js',
    'src/renderer/src/components/template/TemplateForm.vue',
    'src/renderer/src/composables/useNewTemplatePreferences.js',
    'src/renderer/src/composables/useTemplatePreviewClock.js',
    'src/renderer/src/utils/templateRules.js'
  ],
  'tests/titlebar-native-drag-electron.mjs': [
    'src/main/windows/window-drag-controller.js',
    'src/main/logging/window-motion-diagnostics.js',
    'src/main/logging/performance-diagnostics.js',
    'src/shared/window-motion-metrics.js',
    'src/renderer/src/components/system/AppTitlebar.vue',
    'src/renderer/src/utils/windowDragDiagnostics.js',
    'src/preload/index.js',
    'src/main/bridge/blur_bridge.js',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/window_motion_diagnostics.h',
    'src/main/index.js'
  ],
  'tests/window-motion-diagnostics.test.js': [
    'src/main/logging/window-motion-diagnostics.js',
    'src/shared/window-motion-metrics.js',
    'src/shared/diagnostic-policy.js'
  ],
  'tests/window-motion-diagnostics-native.mjs': [
    'native_blur/tests/window_motion_diagnostics_test.cpp',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/window_motion_diagnostics.h',
    'native_blur/CMakeLists.txt'
  ],
  'tests/window-drag-diagnostics.test.js': [
    'src/renderer/src/utils/windowDragDiagnostics.js',
    'src/shared/diagnostic-policy.js'
  ],
  'tests/window-drag-controller.test.js': [
    'src/main/logging/window-motion-diagnostics.js',
    'src/shared/window-motion-metrics.js'
  ],
  'tests/dock-runtime.test.js': [
    'src/main/logging/window-motion-diagnostics.js',
    'src/shared/window-motion-metrics.js'
  ],
  'tests/performance-diagnostics.test.js': [
    'src/main/logging/window-motion-diagnostics.js',
    'src/shared/diagnostic-policy.js',
    'src/renderer/src/utils/diagnosticPolicy.js'
  ],
  'tests/presentation-mode-electron.mjs': [
    'src/main/windows/presentation-runtime.js',
    'src/main/windows/presentation-mode-controller.js',
    'src/main/index.js'
  ],
  'tests/feature-runtime-electron.mjs': [
    'src/main/application/feature-runtime.js',
    'src/main/application/business-mutation-admission.js',
    'src/main/tray/main-tray-controller.js',
    'src/main/services/notification-activation.js',
    'src/main/sticky/ElectronStickyService.js',
    'src/main/index.js'
  ],
  'tests/application-settings.test.js': ['src/main/settings/application-settings.js'],
  'tests/recent-local-day-range.test.js': [
    'src/renderer/src/composables/useTimelineListModel.js',
    'src/shared/calendar/calendar-date-rules.js'
  ],
  'tests/calendar-metadata.test.js': [
    'src/main/calendar/calendar-metadata.js',
    'src/main/calendar/almanac-service.js'
  ],
  'tests/calendar-service.test.js': ['src/main/calendar/calendar-service.js'],
  'tests/main-logging.test.js': [
    'src/main/logging/logger.js',
    'src/main/logging/window-capture.js',
    'src/main/logging/process-capture.js',
    'src/main/logging/log-writer-client.js',
    'src/main/logging/log-writer.mjs',
    'src/main/logging/crash-dump-store.mjs',
    'src/main/logging/diagnostic-state.js',
    'src/shared/diagnostic-policy.js',
    'src/shared/diagnostic-sanitize.js'
  ],
  'tests/holiday-data-service.test.js': ['src/main/calendar/holiday-data-service.js'],
  'tests/logging-overhead-electron.mjs': ['src/renderer/src/utils/performanceDiagnostics.js'],
  'tests/almanac-engine.test.js': ['tests/fixtures/almanac-reference.json'],
  'tests/dock-trigger-electron.mjs': [
    'tests/fullscreen-foreground-electron.mjs',
    'native_blur/window_motion_diagnostics.cpp',
    'native_blur/window_motion_diagnostics.h'
  ],
  'tests/capture-host-electron.mjs': ['tests/helpers/capture-owner.cjs'],
  'tests/capture-lifecycle-electron.mjs': ['tests/helpers/capture-owner.cjs'],
  'tests/helpers/capture-owner.cjs': ['src/main/capture/CaptureHost.js'],
  'tests/window-z-order-electron.mjs': ['tests/helpers/z-order-event-emitter.cjs'],
  'tests/ui-components-electron.mjs': [
    'tests/helpers/ui-fixture.cjs',
    'tests/fixtures/ui-components.vue'
  ],
  'tests/ui-feedback-electron.mjs': [
    'tests/helpers/ui-fixture.cjs',
    'tests/fixtures/ui-feedback.vue'
  ],
  'tests/notice-admin-electron.mjs': ['tests/fixtures/notice-admin-server.py'],
  'tests/reminder-native-acceptance.cjs': [
    'tests/helpers/reminder-activation.ps1',
    'src/main/services/NotificationService.js',
    'src/shared/reminder-protocol.js'
  ],
  'tests/sandbox-diagnostics-win.cjs': ['src/main/logging/windows-sandbox-permissions.js'],
  'tests/sandbox-electron-win.ps1': ['build/windows/sandbox-permissions.ps1'],
  'tests/sandbox-installer-win.ps1': [
    'build/windows/installer.nsh',
    'build/windows/sandbox-permissions.ps1'
  ],
  'tests/sandbox-permissions-win.ps1': ['build/windows/sandbox-permissions.ps1'],
  'tests/capture-shortcut.test.js': [
    'src/shared/capture-shortcuts.js',
    'src/shared/view-visibility-shortcut.js'
  ],
  'tests/diagnostic-controller.test.js': [
    'src/shared/diagnostic-policy.js',
    'src/shared/diagnostic-sanitize.js'
  ],
  'tests/diagnostic-evidence.test.js': ['src/renderer/src/utils/diagnosticPolicy.js'],
  'tests/diagnostic-ipc.test.js': ['src/shared/diagnostic-actions.js'],
  'tests/diagnostic-transport.test.js': ['src/shared/diagnostic-sanitize.js'],
  'tests/error-capture.test.js': ['src/shared/diagnostic-sanitize.js'],
  'tests/help-scroll-motion.test.js': ['src/renderer/src/utils/scrollMotion.js'],
  'tests/log-store.test.js': [
    'src/shared/diagnostic-policy.js',
    'src/shared/diagnostic-sanitize.js'
  ],
  'tests/log-writer-client.test.js': ['src/shared/diagnostic-sanitize.js'],
  'tests/note-weather.test.js': [
    'src/shared/weather-rules.js',
    'src/shared/weather-freshness.js',
    'src/shared/weather-display.js',
    'src/shared/calendar/calendar-date-rules.js'
  ],
  'tests/weather-notice-request-lifecycle.test.js': [
    'src/renderer/src/components/weather/WeatherSettings.vue',
    'src/renderer/src/components/system/RemoteNoticeDialog.vue'
  ],
  'tests/queued-modal-lifecycle.test.js': ['src/renderer/src/utils/modalQueue.js'],
  'tests/reminder-notification.test.js': ['src/shared/reminder-rules.js'],
  'tests/remote-health-cache.test.js': [
    'src/main/services/remote/remote-client.js',
    'src/main/services/remote/device-info.js'
  ],
  'tests/settings-schema.test.js': [
    'src/shared/view-visibility-shortcut.js',
    'src/shared/window-compact-geometry.js'
  ],
  'tests/sticky-diagnostic-ipc.test.js': [
    'src/preload/diagnostic-ipc.js',
    'src/shared/diagnostic-actions.js'
  ],
  'tests/sticky-tray-menu.test.js': ['src/shared/settings-schema.js'],
  'tests/sticky-utils.test.js': ['src/main/sticky/stickyConstants.js'],
  'tests/view-visibility-shortcut-service.test.js': ['src/shared/view-visibility-shortcut.js'],
  'tests/weather-service.test.js': [
    'src/shared/weather-rules.js',
    'src/shared/weather-freshness.js',
    'src/main/data/china-weather-admin-centers.js'
  ]
}

const standaloneWindows = new Set([
  'tests/window-frame-electron.mjs',
  'tests/dock-trigger-electron.mjs',
  'tests/blur-z-order-electron.mjs',
  'tests/window-z-order-electron.mjs'
])
const withoutApplication = new Set([
  'tests/remote-daily-electron.mjs',
  ...focusedNativeTests,
  ...standaloneWindows,
  ...storageTests,
  ...databaseTests,
  ...focusedDatabaseTests,
  'tests/renderer-resource-lifetime-electron.mjs',
  'tests/app-ipc-electron.mjs',
  'tests/note-draft-conflict-electron.mjs',
  'tests/sticky-persistence-electron.mjs',
  'tests/logging-worker-asar-electron.mjs',
  'tests/logging-overhead-electron.mjs',
  'tests/capture-host-electron.mjs',
  'tests/capture-lifecycle-electron.mjs',
  'tests/ui-components-electron.mjs',
  'tests/ui-feedback-electron.mjs',
  'tests/notice-markdown-electron.mjs',
  'tests/notice-admin-electron.mjs',
  'tests/maturity-db.mjs',
  'tests/thumbnail-benchmark-electron.mjs'
])
const allLegacyTests = new Set(registeredMjsFiles.filter((file) => !helperFiles.includes(file)))
const allHelpers = new Set([...helperFiles, ...additionalHelpers])
const allFixtures = new Set(fixtureFiles)
const allAdditionalTests = new Set(additionalTests)
const buildsByFile = new Map(buildDefinitions.map((entry) => [entry.file, entry]))
const unitPattern = /\.test\.(?:js|mjs|ts)$/
const arrayFields = [
  'features',
  'contracts',
  'sourceDependencies',
  'sourceReadDependencies',
  'requires',
  'runtimePrerequisites',
  'limits'
]
const roles = new Set(['test', 'helper', 'fixture', 'build'])
const levels = new Set([
  'unit',
  'database',
  'storage',
  'gui',
  'native',
  'install',
  'performance',
  'support',
  'build'
])
const runtimes = new Set([
  'vitest',
  'electron-node',
  'electron',
  'powershell',
  'node',
  'qt',
  'none'
])
const policies = new Set(['focused', 'explicit', 'support'])

function resolvesInsideRepository(root, target) {
  try {
    const actual = relative(realpathSync(root), realpathSync(target))
    return actual !== '..' && !actual.startsWith('..' + sep) && !isAbsolute(actual)
  } catch {
    return false
  }
}

function listFiles(root, directory) {
  const path = resolve(root, directory)
  if (!existsSync(path)) return []
  // Leave an unclassified marker for integrity validation instead of enumerating
  // a directory junction outside the repository or silently omitting that tree.
  if (!resolvesInsideRepository(root, path)) return [directory]
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const file = directory + '/' + entry.name
      return entry.isDirectory() ? listFiles(root, file) : [file]
    })
    .sort()
}

function discoverTestAssets(root) {
  return [
    ...listFiles(root, 'tests'),
    ...listFiles(root, 'native_capture/tests'),
    ...listFiles(root, 'native_blur/tests'),
    ...buildDefinitions.map((entry) => entry.file)
  ].sort()
}

function expectedRole(file) {
  if (allHelpers.has(file)) return 'helper'
  if (allFixtures.has(file) || file.startsWith('tests/fixtures/')) return 'fixture'
  if (buildsByFile.has(file)) return 'build'
  if (
    allLegacyTests.has(file) ||
    allAdditionalTests.has(file) ||
    (file.startsWith('tests/') && !file.startsWith('tests/helpers/') && unitPattern.test(file))
  )
    return 'test'
  return null
}

function expandPaths(values) {
  return values.flatMap((value) => {
    const match = value.match(/\{([^{}]+)\}/)
    return match
      ? match[1].split(',').flatMap((name) => expandPaths([value.replace(match[0], name)]))
      : [value]
  })
}

function directImports(root, file) {
  if (!/\.(?:js|mjs|ts)$/.test(file) || !existsSync(resolve(root, file))) return []
  const target = resolve(root, file)
  // Metadata discovery precedes validation. Never read a linked source outside
  // the repository; the validator reports that asset's actual filesystem error.
  if (!resolvesInsideRepository(root, target) || !statSync(target).isFile()) return []
  const source = readFileSync(target, 'utf8')
  // The parser is already supplied by the pinned Vue compiler dependency. AST
  // ImportDeclarations exclude comments/template source; dynamic imports are reviewed above.
  const ast = parse(source, {
    sourceType: 'unambiguous',
    plugins: file.endsWith('.ts') ? ['typescript'] : []
  })
  return ast.program.body
    .filter((node) => node.type === 'ImportDeclaration' && node.source.value.startsWith('.'))
    .map((node) =>
      relative(root, resolve(root, dirname(file), node.source.value)).replaceAll('\\', '/')
    )
}

function describeAsset(root, file) {
  const role = expectedRole(file)
  if (!role) return null // The validator reports undisposed, newly discovered assets.
  const build = buildsByFile.get(file)
  const unit = role === 'test' && unitPattern.test(file)
  let level = unit ? 'unit' : role === 'build' ? 'build' : role !== 'test' ? 'support' : 'gui'
  let runtime = unit ? 'vitest' : build?.runtime || (role === 'test' ? 'electron' : 'none')
  let selectionPolicy = role !== 'test' ? 'support' : 'focused'
  const requires = []
  const runtimePrerequisites = []
  const reviewed = reviewedScopes[file]
  const limits = [
    reviewed ? 'reviewed-scope-does-not-certify-current-pass' : 'behavior-contracts-unreviewed',
    'source-map-is-direct-imports-and-reviewed-consumers-and-reads-only'
  ]
  if (focusedDatabaseTests.includes(file)) {
    level = 'database'
    runtime = 'electron'
    runtimePrerequisites.push('electron-runtime', 'electron-abi-compatible-better-sqlite3')
    limits.push(
      file === 'tests/attachment-recovery-reset-electron.mjs'
        ? 'isolated-electron-two-process-disk-and-files'
        : file === 'tests/business-clear-admission-electron.mjs'
          ? 'real-disk-sqlite-and-files-single-process-clear-admission'
          : 'real-disk-sqlite-reopen-no-main-process-restart'
    )
    if (file === 'tests/business-clear-admission-electron.mjs')
      limits.push('production-business-registerer-with-authorized-ipc-fixture-no-renderer')
  } else if (databaseTests.includes(file)) {
    level = 'database'
    runtime = 'electron'
    runtimePrerequisites.push(
      'electron-ready',
      'owned-isolated-profile',
      'electron-abi-compatible-better-sqlite3'
    )
    limits.push('source-database-contracts-not-real-main-app-or-process-restart')
    if (file === 'tests/backend-integration.mjs')
      limits.push('memory-sqlite-plus-real-disk-migration-backup-and-compatibility')
    else if (file === 'tests/note-duration-db.mjs')
      limits.push('real-disk-sqlite-duration-migration-and-query')
    else if (file === 'tests/note-state-db.mjs')
      limits.push('real-disk-sqlite-business-state-and-reminder-transactions-no-renderer')
    else if (file === 'tests/recurrence-lifecycle-db.mjs')
      limits.push('memory-sqlite-template-scheduler-and-reminder-contracts-no-renderer')
    else limits.push('memory-sqlite-contracts')
    if (file === 'tests/reminder-database-integration.mjs')
      limits.push('serialized-reopen-in-same-process-not-application-restart')
  } else if (file === 'tests/maturity-db.mjs') {
    level = 'database'
    runtime = 'electron-node'
    runtimePrerequisites.push('electron-abi-compatible-better-sqlite3')
  } else if (file === 'tests/note-draft-conflict-electron.mjs') {
    level = 'database'
    runtimePrerequisites.push('electron-abi-compatible-better-sqlite3')
    limits.push('real-database-and-attachments-with-simulated-ipc-sender-no-renderer')
  } else if (storageTests.includes(file)) {
    level = 'storage'
    runtimePrerequisites.push('electron-runtime', 'electron-abi-compatible-better-sqlite3')
    limits.push('memory-sqlite-and-real-files-not-main-process-restart')
  } else if (benchmarkTests.includes(file)) level = 'performance'
  if (
    acceptanceTests.includes(file) ||
    benchmarkTests.includes(file) ||
    allAdditionalTests.has(file)
  )
    selectionPolicy = 'explicit'
  if (role === 'test' && file.endsWith('.cjs')) {
    runtime = 'node'
    level = file === 'tests/reminder-native-acceptance.cjs' ? 'native' : 'install'
    runtimePrerequisites.push('windows-desktop')
    if (file !== 'tests/reminder-native-acceptance.cjs')
      runtimePrerequisites.push('verified-unpacked-windows-package-argument')
    else
      runtimePrerequisites.push(
        'windows-toast-protocol-registration',
        'electron-runtime',
        'rcedit-tool'
      )
  }
  if (role === 'test' && file.endsWith('.ps1')) {
    runtime = 'powershell'
    level = file === 'tests/sandbox-electron-win.ps1' ? 'gui' : 'install'
    runtimePrerequisites.push('windows-desktop', 'explicit-workspace-argument')
    if (file === 'tests/sandbox-installer-win.ps1') runtimePrerequisites.push('makensis-argument')
    if (file === 'tests/sandbox-electron-win.ps1') runtimePrerequisites.push('electron-runtime')
  }
  if (role === 'test' && file.endsWith('.cpp')) {
    runtime = 'qt'
    level = 'native'
    requires.push('build-capture')
    runtimePrerequisites.push('windows-qt-6.8.3-msvc2022-x64')
    limits.push(
      file.endsWith('/ux_test.cpp')
        ? 'ctest-declares-offscreen'
        : 'native-host-desktop-requirement-must-be-checked'
    )
  }
  if (focusedNativeTests.includes(file)) {
    level = 'native'
    requires.push('build-native')
    runtimePrerequisites.push('windows-msvc-toolchain')
    limits.push('isolated-native-collector-no-real-hwnd-movement')
  }
  if (allLegacyTests.has(file) && !withoutApplication.has(file)) {
    requires.push('build-app')
    runtimePrerequisites.push(
      'windows-desktop',
      'electron-abi-compatible-better-sqlite3',
      'blur-engine-abi-22',
      'capture-qt-deployment'
    )
    limits.push('application-start-prewarms-capture-even-without-capture-assertions')
  }
  if (standaloneWindows.has(file)) {
    requires.push('build-native')
    runtimePrerequisites.push('windows-desktop', 'blur-engine-abi-22')
  }
  if (file === 'tests/logging-motion-overhead-electron.mjs') {
    requires.push('build-native', 'build-capture')
    runtimePrerequisites.push('windows-msvc-toolchain', 'capture-qt-deployment')
    limits.push('controlled-real-input-comparison-not-dwm-presentation-or-customer-root-cause')
  }
  if (
    [
      'tests/capture-host-electron.mjs',
      'tests/capture-lifecycle-electron.mjs',
      'tests/capture-business-electron.mjs',
      'tests/window-state-matrix-electron.mjs'
    ].includes(file)
  ) {
    requires.push('build-capture')
    runtimePrerequisites.push('windows-desktop', 'capture-qt-deployment')
    limits.push('runs-real-capture-helper')
  }
  if (file === 'tests/capture-host-electron.mjs') {
    level = 'native'
    limits.push('background-helper-lifecycle-no-capture-overlay-or-real-input')
  }
  if (
    [
      'tests/sticky-persistence-electron.mjs',
      'tests/app-ipc-electron.mjs',
      'tests/logging-overhead-electron.mjs',
      'tests/logging-worker-asar-electron.mjs'
    ].includes(file)
  )
    requires.push('build-app')
  if (['tests/notice-markdown-electron.mjs', 'tests/notice-admin-electron.mjs'].includes(file))
    requires.push('build-notice-preview')
  if (file === 'tests/notice-admin-electron.mjs') runtimePrerequisites.push('python-runtime')
  if (file === 'tests/reminder-native-acceptance.cjs')
    limits.push('toast-accepted-and-protocol-callbacks-no-human-toast-click')
  if (role === 'build') {
    limits.push(
      'build-is-not-a-business-test',
      'build-input-list-needs-closure-proof-before-artifact-reuse'
    )
    if (runtime === 'powershell') runtimePrerequisites.push('windows-msvc-toolchain')
    if (build.id === 'build-capture') runtimePrerequisites.push('windows-qt-6.8.3-msvc2022-x64')
  }
  if (role === 'test' && runtime === 'electron') runtimePrerequisites.push('electron-runtime')
  const name = file.replace(/^tests\//, '').replace(/\.test\.(?:js|mjs|ts)$/, '')
  const sourceReadDependencies = expandPaths(sourceReadDefinitions[name] || [])
  const directoryReadDependencies = []
  if (file === 'tests/ui-z-index.test.js') {
    directoryReadDependencies.push({
      directory: 'src/renderer',
      extensions: ['.css', '.js', '.vue']
    })
    sourceReadDependencies.push(
      ...listFiles(root, 'src/renderer').filter((path) =>
        ['.css', '.js', '.vue'].includes(extname(path))
      )
    )
    limits.push('source-text-suite-scans-renderer-tree')
  }
  if (file === 'tests/helpers/ui-fixture.cjs')
    sourceReadDependencies.push('src/renderer/src/assets/tokens.css')
  if (file === 'tests/windows-sandbox-permissions.test.js')
    limits.push(
      'reads-version-sensitive-node_modules/app-builder-lib/templates/nsis/installSection.nsh'
    )
  const infrastructure = [
    'tests/test-manifest.test.js',
    'tests/test-runner.test.js',
    'tests/test-selection.test.js',
    'tests/run-focused-tests.test.js',
    'tests/test-result-adapters.test.js',
    'tests/test-result-recorder.test.js'
  ].includes(file)
  const ipcSecurity = ['tests/ipc-authorization.test.js', 'tests/ipc-arguments.test.js'].includes(
    file
  )
  return {
    id: build?.id || file,
    file,
    role,
    level,
    runtime,
    selectionPolicy,
    features:
      reviewed?.features ||
      (infrastructure ? ['testing-infrastructure'] : ipcSecurity ? ['ipc-security'] : []),
    contracts:
      reviewed?.contracts ||
      (ipcSecurity || file === 'tests/security-hardening.test.js' ? ['C-012'] : []),
    sourceDependencies: [
      ...new Set([...directImports(root, file), ...(extraSourceDependencies[file] || [])])
    ],
    sourceReadDependencies: [...new Set(sourceReadDependencies)],
    directoryReadDependencies,
    requires: [...new Set(requires)],
    runtimePrerequisites: [...new Set(runtimePrerequisites)],
    ...(build ? { buildInputs: [...build.buildInputs] } : {}),
    cost: 'unmeasured',
    disposition: reviewed ? 'reviewed-protection' : 'unreviewed',
    limits
  }
}

function createTestRegistry({ root = repositoryRoot } = {}) {
  const directory = resolve(root)
  const files = new Set([
    ...discoverTestAssets(directory),
    ...registeredMjsFiles,
    ...additionalHelpers,
    ...fixtureFiles,
    ...additionalTests
  ])
  return [...files]
    .sort()
    .map((file) => describeAsset(directory, file))
    .filter(Boolean)
}

function isRepositoryPath(file) {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    file.trim() === file &&
    !/[\\:]/.test(file) &&
    !Array.from(file).some((character) => character.charCodeAt(0) < 32) &&
    !isAbsolute(file) &&
    !win32.isAbsolute(file) &&
    file.split('/').every((part) => part && part !== '.' && part !== '..')
  )
}

function validateTestRegistry(entries, { root = repositoryRoot, discoveredFiles } = {}) {
  const errors = []
  const directory = resolve(root)
  const registeredIds = new Map()
  const registeredFiles = new Map()
  if (!Array.isArray(entries)) return ['Registry entries must be an array']
  function inspectPath(file, label, mustBeFile = false) {
    if (!isRepositoryPath(file)) {
      errors.push('Unsafe ' + label + ': ' + String(file))
      return
    }
    const target = resolve(directory, file)
    try {
      if (!existsSync(target)) {
        errors.push('Missing ' + label + ': ' + file)
        return
      }
      if (mustBeFile && !statSync(target).isFile()) {
        errors.push('Registered asset is not a file: ' + file)
        return
      }
      const actual = relative(realpathSync(directory), realpathSync(target))
      if (actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual))
        errors.push(
          (label === 'registered file'
            ? 'Registered file escapes repository: '
            : 'Dependency path escapes repository: ') + file
        )
    } catch (error) {
      errors.push('Cannot inspect ' + label + ': ' + file + ': ' + (error.code || error.message))
    }
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      errors.push('Invalid registry entry')
      continue
    }
    const label = typeof entry.id === 'string' ? entry.id : '<missing-id>'
    if (typeof entry.id !== 'string' || !entry.id.trim())
      errors.push('Missing or invalid id: ' + label)
    else if (registeredIds.has(entry.id)) errors.push('Duplicate id: ' + entry.id)
    else registeredIds.set(entry.id, entry)
    if (!isRepositoryPath(entry.file)) errors.push('Unsafe repository path: ' + String(entry.file))
    else {
      const key = entry.file.toLowerCase()
      if (registeredFiles.has(key)) errors.push('Duplicate file: ' + entry.file)
      else registeredFiles.set(key, entry)
      inspectPath(entry.file, 'registered file', true)
      const expected = expectedRole(entry.file)
      if (!expected) errors.push('Unclassified registered asset: ' + entry.file)
      else if (entry.role !== expected)
        errors.push('Wrong role for ' + entry.file + ': expected ' + expected)
    }
    if (!roles.has(entry.role)) errors.push('Invalid role: ' + label)
    if (!levels.has(entry.level)) errors.push('Invalid level: ' + label)
    if (!runtimes.has(entry.runtime)) errors.push('Invalid runtime: ' + label)
    if (!policies.has(entry.selectionPolicy)) errors.push('Invalid selectionPolicy: ' + label)
    if (entry.role !== 'test' && entry.selectionPolicy !== 'support')
      errors.push('Support asset cannot be runnable: ' + label)
    if (entry.role === 'test' && entry.selectionPolicy === 'support')
      errors.push('Test cannot use support selectionPolicy: ' + label)
    if (
      entry.role === 'test' &&
      unitPattern.test(entry.file || '') &&
      (entry.level !== 'unit' || entry.runtime !== 'vitest')
    )
      errors.push('Vitest asset requires unit/vitest: ' + label)
    if (entry.role === 'fixture' && unitPattern.test(entry.file || ''))
      errors.push('Fixture matches Vitest include: ' + label)
    if (entry.role === 'build' && (entry.level !== 'build' || !Array.isArray(entry.buildInputs)))
      errors.push('Build asset requires build level and buildInputs: ' + label)
    if (['helper', 'fixture'].includes(entry.role) && entry.level !== 'support')
      errors.push('Support asset requires support level: ' + label)
    for (const field of arrayFields) {
      if (
        !Array.isArray(entry[field]) ||
        entry[field].some((value) => typeof value !== 'string' || !value)
      )
        errors.push('Invalid ' + field + ': ' + label)
    }
    for (const field of ['sourceDependencies', 'sourceReadDependencies']) {
      for (const file of Array.isArray(entry[field]) ? entry[field] : [])
        if (!isRepositoryPath(file))
          errors.push('Unsafe ' + field + ' path: ' + label + ': ' + String(file))
        else inspectPath(file, field + ': ' + label)
    }
    if (entry.cost !== 'unmeasured' && !(Number.isFinite(entry.cost) && entry.cost >= 0))
      errors.push('Invalid cost: ' + label)
    if (typeof entry.disposition !== 'string' || !entry.disposition)
      errors.push('Invalid disposition: ' + label)
  }
  if (registeredFiles.has('tests/security-hardening.test.js')) {
    for (const entry of securityEntryPoints) {
      inspectPath(entry.html, 'security html', true)
      inspectPath(entry.preload, 'security preload', true)
    }
  }
  const discovered = discoveredFiles || discoverTestAssets(directory)
  for (const file of discovered) {
    if (!isRepositoryPath(file)) {
      errors.push('Unsafe discovered path: ' + String(file))
      continue
    }
    if (!registeredFiles.has(file.toLowerCase()))
      errors.push('Unregistered discovered asset: ' + file)
  }
  for (const entry of registeredIds.values()) {
    for (const id of Array.isArray(entry.requires) ? entry.requires : []) {
      const dependency = registeredIds.get(id)
      if (!dependency) errors.push('Unknown dependency: ' + entry.id + ' -> ' + id)
      else if (dependency.role !== 'build')
        errors.push('Dependency is not a build: ' + entry.id + ' -> ' + id)
    }
  }
  const complete = new Set()
  const visiting = new Set()
  function visit(id, path) {
    if (visiting.has(id)) {
      errors.push('Dependency cycle: ' + [...path, id].join(' -> '))
      return
    }
    if (complete.has(id)) return
    const entry = registeredIds.get(id)
    if (!entry) return
    visiting.add(id)
    for (const dependency of Array.isArray(entry.requires) ? entry.requires : [])
      visit(dependency, [...path, id])
    visiting.delete(id)
    complete.add(id)
  }
  for (const id of registeredIds.keys()) visit(id, [])
  return [...new Set(errors)]
}

module.exports = {
  focusedNativeTests,
  createTestRegistry,
  validateTestRegistry,
  securityEntryPoints,
  acceptanceTests,
  benchmarkTests,
  databaseTests,
  focusedDatabaseTests,
  focusedGuiTests,
  electronFeatureTests,
  helperFiles,
  registeredMjsFiles,
  storageTests,
  windowFrameTests
}
