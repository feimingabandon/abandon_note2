// Explicit reviewed contracts. Extend only after the owning batch validates its consumers.
// Broad entry/shared/native files intentionally require an explicit domain review.
const { releaseMainDomainRules } = require('./test-main-domain-rules.cjs')
const { releaseRendererDomainRules } = require('./test-renderer-domain-rules.cjs')
const domainRules = Object.freeze({
  ...releaseMainDomainRules,
  ...releaseRendererDomainRules,
  'tests/helpers/startup-shortcut-notice.mjs': [
    'tests/main-view-enhancements-electron.mjs',
    'tests/note-duration-electron.mjs',
    'tests/week-view-electron.mjs',
    'tests/month-view-electron.mjs',
    'tests/almanac-weather-electron.mjs',
    'tests/help-center-electron.mjs',
    'tests/note-list-completion-electron.mjs',
    'tests/note-text-color-electron.mjs'
  ],
  'tests/recurring-preview-electron.mjs': ['tests/recurring-preview-electron.mjs'],
  'tests/window-border-electron.mjs': ['tests/window-border-electron.mjs'],
  'resources/icons/move-to-today.svg': ['tests/historical-note-move-ui.test.js'],
  'resources/icons/move-to-today-white.svg': ['tests/historical-note-move-ui.test.js'],
  'tests/fixtures/renderer-resource-lifetime/index.html': [
    'tests/renderer-resource-lifetime-electron.mjs'
  ],
  'tests/fixtures/renderer-resource-lifetime/main.js': [
    'tests/renderer-resource-lifetime-electron.mjs'
  ],
  'tests/fixtures/renderer-resource-lifetime/preload.cjs': [
    'tests/renderer-resource-lifetime-electron.mjs'
  ],
  'tests/renderer-resource-lifetime-electron.mjs': [
    'tests/renderer-resource-lifetime-electron.mjs'
  ],
  'tests/almanac-weather-electron.mjs': ['tests/almanac-weather-electron.mjs'],
  'tests/remote-daily-electron.mjs': ['tests/remote-daily-electron.mjs'],
  'src/main/ipc/register-daily-report-ipc.js': [
    'tests/daily-report-ipc.test.js',
    'tests/daily-report-electron.mjs'
  ],
  'src/main/services/daily-report.js': [
    'tests/daily-report.test.js',
    'tests/daily-report-ipc.test.js',
    'tests/daily-report-electron.mjs'
  ],
  'src/main/services/remote/device-info.js': ['tests/device-info.test.js'],
  'src/shared/platform-support.js': [
    'tests/platform-support.test.js',
    'tests/native-runtime-gate.test.js',
    'tests/native-leaf-runtime-electron.mjs'
  ],
  'src/main/db/db-settings-repository.js': ['tests/settings-repository-db.mjs'],
  'src/main/settings/application-settings.js': [
    'tests/application-settings.test.js',
    'tests/settings-repository-db.mjs'
  ],
  'src/main/settings/settings-runtime.js': [
    'tests/settings-runtime.test.js',
    'tests/settings-runtime-electron.mjs'
  ],
  'src/main/db/db-runtime.js': ['tests/database-runtime.test.js', 'tests/database-runtime-db.mjs'],
  'src/main/db/db-connection.js': [
    'tests/database-runtime.test.js',
    'tests/database-runtime-db.mjs',
    'tests/settings-repository-db.mjs'
  ],
  'src/main/db/attachment-recovery.js': [
    'tests/attachment-reset-recovery.test.js',
    'tests/attachment-recovery-reset-electron.mjs'
  ],
  'src/main/db/business-data-reset.js': [
    'tests/attachment-reset-recovery.test.js',
    'tests/attachment-recovery-reset-electron.mjs'
  ],
  'src/main/db/attachment-reset-journal.js': [
    'tests/attachment-reset-recovery.test.js',
    'tests/database-runtime-db.mjs',
    'tests/attachment-recovery-reset-electron.mjs'
  ],
  'src/main/db/image-addition-compensation.js': [
    'tests/note-commands.test.js',
    'tests/attachment-recovery-reset-electron.mjs'
  ],
  'src/main/notes/note-commands.js': [
    'tests/note-commands.test.js',
    'tests/note-draft-conflict-electron.mjs'
  ],
  'src/main/notes/sticky-note-commands.js': [
    'tests/sticky-note-commands.test.js',
    'tests/sticky-persistence-electron.mjs'
  ],
  'src/main/ipc/register-app-ipc.js': [
    'tests/register-app-ipc.test.js',
    'tests/app-ipc-electron.mjs'
  ],
  'src/main/ipc/register-logging-ipc.js': [
    'tests/register-logging-ipc.test.js',
    'tests/logging-actions-electron.mjs'
  ],
  'src/main/ipc/register-remote-notice-ipc.js': [
    'tests/register-remote-notice-ipc.test.js',
    'tests/app-ipc-electron.mjs'
  ],
  'src/main/ipc/register-wallpaper-ipc.js': [
    'tests/register-wallpaper-ipc.test.js',
    'tests/app-ipc-electron.mjs',
    'tests/background-navigation-electron.mjs',
    'tests/wallpaper-storage-electron.mjs'
  ],
  'src/main/windows/main-window-host.js': [
    'tests/main-window-host.test.js',
    'tests/app-ipc-electron.mjs',
    'tests/settings-runtime-electron.mjs'
  ],
  'src/main/windows/window-geometry-persistence.js': [
    'tests/window-geometry-persistence.test.js',
    'tests/settings-runtime-electron.mjs'
  ],
  'src/main/application/bootstrap.js': [
    'tests/application-lifecycle.test.js',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/application/shutdown-coordinator.js': [
    'tests/application-lifecycle.test.js',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/services/remote/remote-coordinator.js': [
    'tests/remote-shutdown.test.js',
    'tests/remote-health-cache.test.js',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/windows/blur-runtime.js': [
    'tests/native-leaf-runtime.test.js',
    'tests/native-leaf-runtime-electron.mjs'
  ],
  'src/main/windows/z-order-runtime.js': [
    'tests/native-leaf-runtime.test.js',
    'tests/window-z-order-main-wiring.test.js',
    'tests/native-leaf-runtime-electron.mjs'
  ],
  'src/main/window-motion/dock-runtime.js': [
    'tests/dock-runtime.test.js',
    'tests/dock-main-wiring.test.js',
    'tests/dock-runtime-electron.mjs'
  ],
  'src/main/window-motion/index.js': [
    'tests/window-motion-backend.test.js',
    'tests/dock-runtime.test.js',
    'tests/dock-runtime-electron.mjs'
  ],
  'src/main/windows/window-drag-controller.js': [
    'tests/window-drag-controller.test.js',
    'tests/presentation-mode-architecture.test.js',
    'tests/titlebar-native-drag-electron.mjs'
  ],
  'src/main/windows/window-drag-coordinates.js': [
    'tests/window-drag-controller.test.js',
    'tests/titlebar-native-drag-electron.mjs'
  ],
  'src/main/windows/presentation-runtime.js': [
    'tests/presentation-runtime.test.js',
    'tests/presentation-mode-architecture.test.js',
    'tests/presentation-mode-electron.mjs'
  ],
  'src/main/windows/presentation-mode-controller.js': [
    'tests/presentation-mode-controller.test.js',
    'tests/presentation-runtime.test.js',
    'tests/presentation-mode-electron.mjs'
  ],
  'src/main/windows/main-view-navigation.js': [
    'tests/main-view-navigation.test.js',
    'tests/view-switch-geometry-order.test.js',
    'tests/settings-runtime-electron.mjs',
    'tests/background-navigation-electron.mjs'
  ],
  'src/main/settings/settings-write-coordinator.js': [
    'tests/settings-write-coordinator.test.js',
    'tests/blur-settings-main-wiring.test.js',
    'tests/settings-queue-electron.mjs',
    'tests/background-navigation-electron.mjs'
  ],
  'src/main/settings/background-settings-coordinator.js': [
    'tests/background-settings-coordinator.test.js',
    'tests/background-navigation-electron.mjs'
  ],
  'src/main/application/business-mutation-admission.js': [
    'tests/business-mutation-admission.test.js',
    'tests/sticky-service.test.js',
    'tests/reminder-service.test.js',
    'tests/business-clear-admission-electron.mjs',
    'tests/feature-runtime-electron.mjs',
    'tests/sticky-persistence-electron.mjs'
  ],
  'src/main/application/business-data-clear.js': [
    'tests/business-data-clear.test.js',
    'tests/feature-runtime-electron.mjs'
  ],
  'src/main/application/feature-runtime.js': [
    'tests/feature-runtime.test.js',
    'tests/diagnostic-noise-and-location.test.js',
    'tests/feature-runtime-electron.mjs',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/tray/main-tray-controller.js': [
    'tests/main-tray-controller.test.js',
    'tests/feature-runtime-electron.mjs'
  ],
  'src/main/services/notification-activation.js': [
    'tests/notification-activation.test.js',
    'tests/diagnostic-noise-and-location.test.js',
    'tests/feature-runtime-electron.mjs'
  ],
  'src/main/ipc/register-weather-ipc.js': [
    'tests/weather-ipc.test.js',
    'tests/feature-runtime-electron.mjs'
  ],
  'src/main/services/weather-refresh-controller.js': [
    'tests/weather-refresh-controller.test.js',
    'tests/weather-ipc.test.js'
  ],
  'src/main/services/ReminderService.js': [
    'tests/reminder-service.test.js',
    'tests/business-clear-admission-electron.mjs',
    'tests/feature-runtime-electron.mjs',
    'tests/application-lifecycle-electron.mjs'
  ],
  'src/main/services/ReminderWindow.js': [
    'tests/sticky-service.test.js',
    'tests/feature-runtime-electron.mjs'
  ],
  'src/main/sticky/ElectronStickyService.js': [
    'tests/sticky-service.test.js',
    'tests/sticky-persistence-electron.mjs',
    'tests/feature-runtime-electron.mjs'
  ],
  'tests/helpers/electron-gui-result-lifecycle.mjs': [
    'tests/titlebar-native-drag-electron.mjs',
    'tests/presentation-mode-electron.mjs',
    'tests/background-navigation-electron.mjs'
  ],
  'src/main/capture/capture-window-integration.js': [
    'tests/capture-window-integration.test.js',
    'tests/capture-coordinator.test.js',
    'tests/capture-business-electron.mjs'
  ],
  'src/renderer/src/composables/useSettingsWriteQueue.js': [
    'tests/settings-write-queue.test.js',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useDockSettingsForm.js': [
    'tests/settings-form-models.test.js',
    'tests/dock-settings-ui.test.js',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useStickySettingsForm.js': [
    'tests/settings-form-models.test.js',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/components/system/settings/DockSettingsSection.vue': [
    'tests/dock-settings-ui.test.js',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/components/system/settings/StickySettingsSection.vue': [
    'tests/settings-form-models.test.js',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useWorkspaceRuntime.js': [
    'tests/workspace-runtime.test.js',
    'tests/modal-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useWorkspaceWallpaper.js': [
    'tests/workspace-runtime.test.js',
    'tests/modal-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useWorkspaceNotices.js': [
    'tests/workspace-runtime.test.js',
    'tests/modal-queue-electron.mjs'
  ],
  'src/renderer/src/composables/useUpdateCheck.js': [
    'tests/workspace-runtime.test.js',
    'tests/app-update.test.js'
  ],
  'src/renderer/src/composables/useCalendarWorkspaceModel.js': [
    'tests/calendar-workspace-model.test.js',
    'tests/calendar-workspace-electron.mjs'
  ],
  'src/renderer/src/composables/useCalendarWorkspacePreferences.js': [
    'tests/calendar-workspace-preferences.test.js',
    'tests/calendar-recurring-preview-ui.test.js',
    'tests/calendar-workspace-electron.mjs'
  ],
  'src/renderer/src/components/month/MonthWorkspace.vue': [
    'tests/calendar-workspace-lifecycle.test.js',
    'tests/calendar-recurring-preview-ui.test.js',
    'tests/calendar-workspace-electron.mjs'
  ],
  'src/renderer/src/composables/useTimelineListModel.js': [
    'tests/timeline-list-model.test.js',
    'tests/recent-local-day-range.test.js',
    'tests/note-list-refresh-electron.mjs'
  ],
  'src/renderer/src/composables/useCustomListModel.js': [
    'tests/custom-list-model.test.js',
    'tests/note-list-custom-electron.mjs'
  ],
  'src/renderer/src/composables/useTagGroupListModel.js': [
    'tests/tag-group-list-model.test.js',
    'tests/tag-group-ordering-ui.test.js',
    'tests/note-list-tag-refresh-electron.mjs'
  ],
  'src/renderer/src/composables/useNoteListQuerySession.js': [
    'tests/timeline-list-model.test.js',
    'tests/custom-list-model.test.js',
    'tests/tag-group-list-model.test.js',
    'tests/note-list-refresh-electron.mjs',
    'tests/note-list-custom-electron.mjs',
    'tests/note-list-tag-refresh-electron.mjs'
  ],
  'src/renderer/src/utils/noteListItem.js': [
    'tests/tag-group-list-model.test.js',
    'tests/note-list-tag-refresh-electron.mjs'
  ]
})

module.exports = { domainRules }
