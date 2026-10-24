// Reviewed consumers for the concrete main/shared/native changes in 1.4.0.
// Keys are literal files. They do not admit another file in the same directory,
// and selecting a consumer is not a claim that its current attempt has passed.
const noteStorage = Object.freeze([
  'tests/backend-integration.mjs',
  'tests/note-state-db.mjs',
  'tests/note-duration-db.mjs',
  'tests/note-remark-db.mjs',
  'tests/note-text-color-db.mjs',
  'tests/note-list-completion-db.mjs',
  'tests/historical-note-move-db.mjs'
])
const recurrenceStorage = Object.freeze([
  'tests/backend-integration.mjs',
  'tests/recurrence-lifecycle-db.mjs',
  'tests/recurring-preview-db.mjs',
  'tests/template-quarterly-electron.mjs',
  'tests/note-startup-recovery-electron.mjs'
])
const historicalMove = Object.freeze([
  'tests/historical-note-move-rules.test.js',
  'tests/automatic-note-move.test.js',
  'tests/historical-note-move-db.mjs',
  'tests/historical-note-move-electron.mjs'
])
const reminderStorage = Object.freeze([
  'tests/note-state-db.mjs',
  'tests/recurrence-lifecycle-db.mjs',
  'tests/reminder-database-integration.mjs',
  'tests/business-clear-admission-electron.mjs',
  'tests/reminders-electron.mjs'
])
const nativeMotion = Object.freeze([
  'tests/native-runtime-gate.test.js',
  'tests/window-frame-electron.mjs',
  'tests/dock-trigger-electron.mjs',
  'tests/window-z-order-electron.mjs',
  'tests/window-motion-diagnostics-native.mjs'
])
const nativeBlur = Object.freeze([
  'tests/native-runtime-gate.test.js',
  'tests/blur-z-order-electron.mjs',
  'tests/window-z-order-electron.mjs',
  'tests/native-leaf-runtime-electron.mjs',
  'tests/background-navigation-electron.mjs'
])
const nativeApi = Object.freeze([
  ...nativeMotion,
  'tests/blur-z-order-electron.mjs',
  'tests/native-leaf-runtime-electron.mjs',
  'tests/background-navigation-electron.mjs'
])
const captureEditor = Object.freeze([
  'native_capture/tests/core_test.cpp',
  'native_capture/tests/ux_test.cpp',
  'native_capture/tests/polish_test.cpp',
  'native_capture/tests/ui_test.cpp'
])
const captureOverlay = Object.freeze([
  'native_capture/tests/selection_test.cpp',
  'native_capture/tests/ui_test.cpp'
])
const captureBuild = Object.freeze([
  'tests/capture-build-selection.test.js',
  'tests/test-build-descriptors.test.js',
  'native_capture/tests/core_test.cpp',
  'native_capture/tests/ui_test.cpp',
  'native_capture/tests/ux_test.cpp',
  'native_capture/tests/selection_test.cpp',
  'native_capture/tests/polish_test.cpp'
])
const mainComposition = Object.freeze([
  'tests/platform-support.test.js',
  'tests/native-runtime-gate.test.js',
  'tests/editing-draft-session.test.js',
  'tests/presentation-mode-architecture.test.js',
  'tests/application-lifecycle-electron.mjs',
  'tests/feature-runtime-electron.mjs',
  'tests/settings-runtime-electron.mjs',
  'tests/dock-runtime-electron.mjs',
  'tests/capture-business-electron.mjs',
  'tests/reminders-electron.mjs',
  'tests/logging-actions-electron.mjs',
  'tests/historical-note-move-electron.mjs',
  'tests/new-note-workflow-electron.mjs',
  'tests/renderer-recovery-electron.mjs'
])

const releaseMainDomainRules = Object.freeze({
  // Real SQLite schema/migrations, note state transitions and recurrence stores.
  'src/main/db/db-notes.js': noteStorage,
  'src/main/db/db-reminders.js': reminderStorage,
  'src/main/db/db-schema.js': [
    ...noteStorage,
    'tests/database-runtime-db.mjs',
    'tests/recurrence-lifecycle-db.mjs',
    'tests/settings-repository-db.mjs',
    'tests/remote-daily-electron.mjs'
  ],
  'src/main/db/db-templates.js': recurrenceStorage,
  'src/main/db/db.js': [
    'tests/database-runtime-db.mjs',
    'tests/settings-repository-db.mjs',
    'tests/business-clear-admission-electron.mjs',
    'tests/attachment-recovery-reset-electron.mjs',
    'tests/note-draft-conflict-electron.mjs'
  ],
  'src/main/db/db-historical-note-move.js': historicalMove,
  'src/main/services/automatic-note-move.js': historicalMove,
  'src/shared/historical-note-move-rules.js': historicalMove,
  'src/main/services/recurrence.js': recurrenceStorage,
  'src/main/services/scheduler.js': [
    'tests/scheduler.test.js',
    'tests/performance-attribution.test.js',
    'tests/note-startup-recovery-electron.mjs',
    'tests/reminders-electron.mjs'
  ],
  'src/shared/note-scheduling-rules.js': [
    'tests/note-scheduling-rules.test.js',
    'tests/note-state-db.mjs',
    'tests/recurrence-lifecycle-db.mjs',
    'tests/note-draft-conflict-ui-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/main/ipc/register-business-ipc.js': [
    'tests/ipc-authorization.test.js',
    'tests/ipc-arguments.test.js',
    'tests/business-note-reminders.test.js',
    'tests/tag-commands-electron.mjs',
    'tests/note-draft-conflict-electron.mjs',
    'tests/business-clear-admission-electron.mjs',
    'tests/historical-note-move-db.mjs',
    'tests/new-note-workflow-electron.mjs',
    'tests/reminders-electron.mjs'
  ],
  'src/main/tags/tag-commands.js': [
    'tests/tag-commands.test.js',
    'tests/tag-commands-electron.mjs'
  ],

  // Schema declarations, renderer write admission and real persisted snapshots.
  'src/shared/settings-schema.js': [
    'tests/settings-schema.test.js',
    'tests/application-settings.test.js',
    'tests/settings-repository-db.mjs',
    'tests/settings-runtime-electron.mjs',
    'tests/settings-queue-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],

  // Forecast/cache behavior uses controlled providers; GUI verifies actual IPC
  // and setting consumers, without claiming a live upstream weather API check.
  'src/main/services/weather-service.js': [
    'tests/weather-service.test.js',
    'tests/weather-ipc.test.js',
    'tests/weather-refresh-controller.test.js',
    'tests/weather-settings-electron.mjs',
    'tests/weather-notice-lifecycle-electron.mjs'
  ],

  // Delivery policy, production service calls and popup/tray reconciliation.
  'src/main/services/NotificationService.js': [
    'tests/reminder-notification.test.js',
    'tests/reminder-service.test.js',
    'tests/reminders-electron.mjs'
  ],
  'src/shared/notification-policy.js': [
    'tests/notification-policy.test.js',
    'tests/reminder-notification.test.js',
    'tests/reminders-electron.mjs'
  ],
  'src/shared/reminder-rules.js': [
    'tests/notification-policy.test.js',
    'tests/reminder-service.test.js',
    'tests/reminder-notification.test.js',
    'tests/note-state-db.mjs',
    'tests/reminder-database-integration.mjs',
    'tests/reminders-electron.mjs'
  ],

  // Coordinator tests exercise session/transport ownership; native capture
  // drawing and Windows input remain assigned to the concrete Qt targets below.
  'src/main/capture/CaptureCoordinator.js': [
    'tests/capture-coordinator.test.js',
    'tests/capture-window-integration.test.js',
    'tests/capture-business-electron.mjs'
  ],
  'src/shared/capture-shortcuts.js': [
    'tests/capture-shortcut.test.js',
    'tests/shortcut-status.test.js',
    'tests/capture-business-electron.mjs'
  ],
  'native_capture/CMakeLists.txt': captureBuild,
  'native_capture/build.ps1': captureBuild,
  'native_capture/run-qt-test.cmake': captureBuild,
  // The documented build/selection and editor contracts are reviewed here;
  // these consumers do not claim to verify every prose statement in the README.
  'native_capture/README.md': ['tests/capture-build-selection.test.js'],
  'native_capture/engine/AnnotationEditor.cpp': captureEditor,
  'native_capture/engine/AnnotationEditor.h': captureEditor,
  'native_capture/engine/CaptureAppearance.cpp': [
    'native_capture/tests/ux_test.cpp',
    'native_capture/tests/polish_test.cpp'
  ],
  'native_capture/engine/CaptureAppearance.h': [
    'native_capture/tests/ux_test.cpp',
    'native_capture/tests/polish_test.cpp'
  ],
  'native_capture/engine/CaptureEngine.cpp': [
    'native_capture/tests/ui_test.cpp',
    'native_capture/tests/polish_test.cpp',
    'tests/capture-business-electron.mjs'
  ],
  'native_capture/engine/CaptureOverlay.cpp': captureOverlay,
  'native_capture/engine/CaptureOverlay.h': captureOverlay,
  'native_capture/engine/ImageDocument.cpp': [
    'native_capture/tests/core_test.cpp',
    'native_capture/tests/ux_test.cpp',
    'native_capture/tests/ui_test.cpp'
  ],
  'native_capture/engine/ImageDocument.h': [
    'native_capture/tests/core_test.cpp',
    'native_capture/tests/ux_test.cpp',
    'native_capture/tests/ui_test.cpp'
  ],

  // Actual Windows DLL consumers verify ABI, geometry, edge monitoring and
  // z-order. They do not certify optical material appearance on every GPU.
  'native_blur/CMakeLists.txt': [
    'tests/package-native-config.test.js',
    ...nativeMotion,
    'tests/blur-z-order-electron.mjs'
  ],
  'native_blur/blur_api.cpp': nativeApi,
  'native_blur/blur_api.h': nativeApi,
  'native_blur/blur_engine.cpp': nativeBlur,
  'native_blur/blur_engine.h': nativeBlur,
  'src/shared/native-abi-version.js': [
    ...nativeMotion,
    'tests/native-leaf-runtime-electron.mjs',
    'tests/test-manifest.test.js',
    'tests/run-focused-tests.test.js',
    'tests/ci-test-selection.test.js'
  ],
  'src/main/bridge/blur_bridge.js': [
    'tests/native-runtime-gate.test.js',
    'tests/window-motion-backend.test.js',
    'tests/native-leaf-runtime-electron.mjs',
    'tests/dock-runtime-electron.mjs',
    'tests/background-navigation-electron.mjs'
  ],
  'src/main/bridge/window-layer-diagnostics.js': [
    'tests/window-layer-diagnostics.test.js',
    'tests/native-leaf-runtime-electron.mjs'
  ],
  // The removed dock-edge module is protected by its explicit replacement
  // owner's contracts; this mapping does not admit a different deleted module.
  'src/main/window-motion/dock-edge.js': [
    'tests/dock-runtime.test.js',
    'tests/dock-main-wiring.test.js',
    'tests/native-edge-monitor.test.js',
    'tests/native-edge-monitor-source.test.js',
    'tests/dock-runtime-electron.mjs',
    'tests/dock-trigger-electron.mjs'
  ],
  // The C++ collector is selected through its registered result-producing
  // Electron wrapper, never by pretending a helper .cpp is a runnable test ID.
  'native_blur/window_motion_diagnostics.cpp': [
    'tests/window-motion-diagnostics.test.js',
    'tests/window-motion-diagnostics-native.mjs'
  ],
  'native_blur/window_motion_diagnostics.h': [
    'tests/window-motion-diagnostics.test.js',
    'tests/window-motion-diagnostics-native.mjs'
  ],
  'native_blur/tests/window_motion_diagnostics_test.cpp': [
    'tests/window-motion-diagnostics-native.mjs'
  ],

  // Controlled HTTP response/permission/session behavior, without production
  // service traffic. The adapted Electron suite uses a real local HTTP server
  // and reopens the actual daily-state SQLite repository in the same process.
  'src/main/services/remote/remote-client.js': [
    'tests/remote-health-cache.test.js',
    'tests/remote-daily.test.js',
    'tests/remote-shutdown.test.js',
    'tests/remote-daily-electron.mjs'
  ],
  'src/main/db/db-remote-daily.js': [
    'tests/remote-daily.test.js',
    'tests/remote-daily-electron.mjs'
  ],
  'src/main/services/remote/daily-clock.js': [
    'tests/remote-daily.test.js',
    'tests/remote-daily-electron.mjs'
  ],
  'src/main/services/app-update.js': [
    'tests/app-update.test.js',
    'tests/app-update-wiring.test.js',
    'tests/app-ipc-electron.mjs'
  ],

  // Queue/backpressure and diagnostic evidence retain their source-specific
  // unit contracts plus the adapted real-app export/collection consumers.
  'src/main/logging/log-writer-client.js': [
    'tests/log-writer-client.test.js',
    'tests/main-logging.test.js',
    'tests/logging-actions-electron.mjs'
  ],
  'src/main/logging/performance-diagnostics.js': [
    'tests/performance-diagnostics.test.js',
    'tests/performance-attribution.test.js',
    'tests/logging-actions-electron.mjs'
  ],
  'src/main/logging/system-diagnostics.js': [
    'tests/system-diagnostics.test.js',
    'tests/logging-actions-electron.mjs'
  ],
  'src/main/logging/window-motion-diagnostics.js': [
    'tests/window-motion-diagnostics.test.js',
    'tests/titlebar-native-drag-electron.mjs',
    'tests/logging-actions-electron.mjs'
  ],
  'src/shared/window-motion-metrics.js': [
    'tests/window-motion-diagnostics.test.js',
    'tests/titlebar-native-drag-electron.mjs'
  ],
  'src/shared/diagnostic-actions.js': [
    'tests/diagnostic-actions.test.js',
    'tests/logging-actions-electron.mjs'
  ],

  // Concrete startup/composition/preload entry capabilities require several
  // named integration consumers rather than automatically selecting all tests.
  'src/main/bootstrap.js': [
    'tests/platform-support.test.js',
    'tests/main-logging.test.js',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/index.js': mainComposition,
  'src/main/windows/editing-draft-guard.js': [
    'tests/editing-draft-guard.test.js',
    'tests/new-note-workflow-electron.mjs',
    'tests/note-draft-conflict-ui-electron.mjs'
  ],
  'src/main/windows/renderer-recovery.js': ['tests/renderer-recovery-electron.mjs'],
  'src/preload/index.js': [
    'tests/security-hardening.test.js',
    'tests/ipc-arguments.test.js',
    'tests/editing-draft-session.test.js',
    'tests/app-ipc-electron.mjs',
    'tests/settings-runtime-electron.mjs',
    'tests/historical-note-move-electron.mjs',
    'tests/new-note-workflow-electron.mjs',
    'tests/daily-report-electron.mjs',
    'tests/logging-actions-electron.mjs'
  ],
  'src/shared/view-visibility-shortcut.js': [
    'tests/view-visibility-shortcut.test.js',
    'tests/view-visibility-shortcut-service.test.js',
    'tests/view-visibility-shortcut-electron.mjs'
  ]
})

module.exports = { releaseMainDomainRules }
