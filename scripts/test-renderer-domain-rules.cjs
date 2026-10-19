// Reviewed renderer consumers for the 1.4.0 change set. These exact paths do not
// admit future files or turn source-discovery candidates into coverage claims.
const releaseRendererDomainRules = Object.freeze({
  // Renderer roots: shared providers, workspace lifecycle and cross-view entry wiring.
  'src/renderer/src/App.vue': [
    'tests/tag-color-setting.test.js',
    'tests/quick-note-edit.test.js',
    'tests/ui-interaction-standard.test.js',
    'tests/modal-queue-electron.mjs',
    'tests/main-view-enhancements-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/MonthApp.vue': [
    'tests/tag-color-setting.test.js',
    'tests/quick-note-edit.test.js',
    'tests/ui-interaction-standard.test.js',
    'tests/modal-queue-electron.mjs',
    'tests/calendar-workspace-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],

  // Almanac/date context: shared detail navigation, visibility and stale requests.
  'src/renderer/src/components/almanac/AlmanacLauncher.vue': [
    'tests/almanac-weather-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/almanac/AlmanacSummary.vue': [
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/almanac/DateContextBadge.vue': [
    'tests/almanac-weather-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/almanac/DateContextPopover.vue': [
    'tests/almanac-weather-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/almanac/DateContextSummary.vue': [
    'tests/almanac-weather-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/almanac/DateContextDetails.vue': [
    'tests/almanac-weather-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/composables/useDateContextSettings.js': [
    'tests/date-context-settings.test.js',
    'tests/date-context-controls-electron.mjs'
  ],

  // Calendar: grid/toolbar/sidebar consumers and paged historical-move selection.
  'src/renderer/src/components/month/MonthCalendarGrid.vue': [
    'tests/ui-interaction-standard.test.js',
    'tests/image-only-note.test.js',
    'tests/month-view-electron.mjs',
    'tests/week-view-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs',
    'tests/historical-note-move-electron.mjs'
  ],
  'src/renderer/src/components/month/MonthCalendarToolbar.vue': [
    'tests/ui-interaction-standard.test.js',
    'tests/titlebar-icon-scale-ui.test.js',
    'tests/calendar-recurring-preview-ui.test.js',
    'tests/historical-note-move-ui.test.js',
    'tests/month-view-electron.mjs',
    'tests/week-view-electron.mjs',
    'tests/historical-note-move-electron.mjs'
  ],
  'src/renderer/src/components/month/MonthDayPanel.vue': [
    'tests/ui-interaction-standard.test.js',
    'tests/main-view-enhancements-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/month/HistoricalNoteMoveControl.vue': [
    'tests/historical-note-move-ui.test.js',
    'tests/historical-note-move-electron.mjs'
  ],
  'src/renderer/src/components/month/historical-note-move-selection.js': [
    'tests/historical-note-move-ui.test.js',
    'tests/historical-note-move-electron.mjs'
  ],

  // Creation/editor/remark/state: actual forms, draft restoration and save payloads.
  'src/renderer/src/components/capture/CaptureDelivery.vue': [
    'tests/new-note-workflow-electron.mjs',
    'tests/capture-business-electron.mjs'
  ],
  'src/renderer/src/components/list/NewNotePanel.vue': [
    'tests/note-remark.test.js',
    'tests/note-duration-mode.test.js',
    'tests/historical-note-backfill-ui.test.js',
    'tests/image-only-note.test.js',
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/month/MonthNoteCreator.vue': [
    'tests/note-remark.test.js',
    'tests/note-duration-mode.test.js',
    'tests/month-note-creator-intent.test.js',
    'tests/image-only-note.test.js',
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/note/NoteEditor.vue': [
    'tests/note-remark.test.js',
    'tests/historical-note-backfill-ui.test.js',
    'tests/image-only-note.test.js',
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs',
    'tests/note-draft-conflict-ui-electron.mjs'
  ],
  'src/renderer/src/components/note/NoteRemarkField.vue': ['tests/new-note-workflow-electron.mjs'],
  'src/renderer/src/components/note/NoteStateFields.vue': [
    'tests/historical-note-backfill-ui.test.js',
    'tests/note-three-view-rules-ui-electron.mjs',
    'tests/note-draft-conflict-ui-electron.mjs'
  ],
  'src/renderer/src/components/note/NoteDurationField.vue': [
    'tests/note-duration-mode.test.js',
    'tests/note-duration-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/components/note/ReminderChannelPicker.vue': [
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs',
    'tests/template-quarterly-electron.mjs'
  ],
  'src/renderer/src/composables/useNewNotePreferences.js': [
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/composables/useNoteStateDraft.js': [
    'tests/note-state-draft.test.js',
    'tests/historical-note-backfill-ui.test.js',
    'tests/month-note-creator-intent.test.js',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],

  // Report: shared list/calendar dialog and its real export/close workflow.
  'src/renderer/src/components/report/DailyReportDialog.vue': [
    'tests/ui-interaction-standard.test.js',
    'tests/daily-report-electron.mjs'
  ],

  // Settings/controls: save failure, layout, date/time focus and native shortcuts.
  'src/renderer/src/assets/tokens.css': [
    'tests/ui-interaction-standard.test.js',
    'tests/ui-z-index.test.js',
    'tests/note-remark.test.js',
    'tests/date-context-controls-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/system/SettingsPanel.vue': [
    'tests/settings-panel-density.test.js',
    'tests/titlebar-icon-scale-ui.test.js',
    'tests/view-visibility-shortcut-ui.test.js',
    'tests/note-remark.test.js',
    'tests/settings-queue-electron.mjs',
    'tests/date-context-controls-electron.mjs',
    'tests/weather-settings-electron.mjs'
  ],
  'src/renderer/src/components/system/settings/settings-form.css': [
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/components/ui/AppIcon.vue': [
    'tests/titlebar-icon-scale-ui.test.js',
    'tests/titlebar-icon-scale-electron.mjs'
  ],
  'src/renderer/src/components/ui/BaseButton.vue': [
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs',
    'tests/settings-queue-electron.mjs'
  ],
  'src/renderer/src/components/ui/DateTimePicker.vue': [
    'tests/date-time-picker-relative-now.test.js',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/ui/FontSizeInput.vue': [
    'tests/settings-queue-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/components/ui/ResizableTextarea.vue': [
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/ui/ShortcutRecorder.vue': [
    'tests/view-visibility-shortcut-ui.test.js',
    'tests/view-visibility-shortcut-electron.mjs'
  ],
  'src/renderer/src/components/ui/TimePicker.vue': ['tests/note-three-view-rules-ui-electron.mjs'],
  'src/renderer/src/components/weather/WeatherSettings.vue': [
    'tests/settings-panel-density.test.js',
    'tests/weather-notice-request-lifecycle.test.js',
    'tests/weather-settings-electron.mjs',
    'tests/weather-notice-lifecycle-electron.mjs',
    'tests/date-context-controls-electron.mjs'
  ],
  'src/renderer/src/components/system/RemoteNoticeDialog.vue': [
    'tests/weather-notice-request-lifecycle.test.js',
    'tests/weather-notice-lifecycle-electron.mjs'
  ],
  'src/renderer/src/components/system/AppTitlebar.vue': [
    'tests/titlebar-icon-scale-ui.test.js',
    'tests/window-drag-diagnostics.test.js',
    'tests/titlebar-native-drag-electron.mjs',
    'tests/titlebar-icon-scale-electron.mjs'
  ],
  'src/renderer/src/utils/windowDragDiagnostics.js': [
    'tests/window-drag-diagnostics.test.js',
    'tests/titlebar-native-drag-electron.mjs'
  ],

  // Template: recurrence choices, pending-save lock, live preview and real forms.
  'src/renderer/src/components/template/TemplateForm.vue': [
    'tests/template-submit-lock.test.js',
    'tests/template-ui-utils.test.js',
    'tests/new-template-preferences.test.js',
    'tests/template-quarterly-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/template/TemplateFrequencySelector.vue': [
    'tests/template-quarterly-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/components/template/TemplatePage.vue': [
    'tests/renderer-resource-lifecycle.test.js',
    'tests/template-ui-utils.test.js',
    'tests/template-quarterly-electron.mjs'
  ],
  'src/renderer/src/composables/useNewTemplatePreferences.js': [
    'tests/new-template-preferences.test.js',
    'tests/template-quarterly-electron.mjs'
  ],
  'src/renderer/src/composables/useTemplatePreviewClock.js': [
    'tests/template-preview-clock.test.js',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/utils/templateRules.js': [
    'tests/template-ui-utils.test.js',
    'tests/template-quarterly-electron.mjs'
  ],

  // Lists: Ctrl shortcuts, timeline/custom/tag refresh and status/card consumers.
  'src/renderer/src/components/list/ActionBar.vue': [
    'tests/action-bar-accessibility.test.js',
    'tests/view-visibility-shortcut-ui.test.js',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/components/list/NoteCard.vue': [
    'tests/note-remark.test.js',
    'tests/ui-interaction-standard.test.js',
    'tests/tag-color-setting.test.js',
    'tests/date-context-controls-electron.mjs',
    'tests/quick-note-edit-electron.mjs',
    'tests/note-duration-electron.mjs'
  ],
  'src/renderer/src/components/list/NoteList.vue': [
    'tests/tag-group-ordering-ui.test.js',
    'tests/note-list-refresh-electron.mjs',
    'tests/note-list-custom-electron.mjs',
    'tests/note-list-tag-refresh-electron.mjs',
    'tests/note-list-completion-electron.mjs'
  ],
  'src/renderer/src/components/list/SearchBox.vue': [
    'tests/recent-local-day-range.test.js',
    'tests/view-visibility-shortcut-ui.test.js'
  ],
  // Only visible pending-status wording reviewed; query predicates unchanged.
  // Underlying filter contract uses the same buildWhereClause as searchNotes;
  // this mapping does not claim GUI search/filter-step coverage.
  'src/renderer/src/components/list/SearchFilterPanel.vue': ['tests/note-list-completion-db.mjs'],
  'src/renderer/src/components/list/SearchResultCard.vue': [
    'tests/note-text-color.test.js',
    'tests/tag-color-setting.test.js'
  ],
  'src/renderer/src/components/list/StatusRing.vue': [
    'tests/note-duration-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],

  // Image/text resources: actual compiled SFCs and real preview cleanup cycles.
  'src/renderer/src/components/note/ImagePicker.vue': [
    'tests/renderer-resource-lifecycle.test.js',
    'tests/image-only-note.test.js',
    'tests/settings-panel-density.test.js',
    'tests/renderer-resource-lifetime-electron.mjs',
    'tests/new-note-workflow-electron.mjs'
  ],
  'src/renderer/src/components/note/ColoredTextEditor.vue': [
    'tests/note-text-color.test.js',
    'tests/new-note-workflow-electron.mjs',
    'tests/note-three-view-rules-ui-electron.mjs'
  ],
  'src/renderer/src/components/note/NoteTextColorPopover.vue': [
    'tests/renderer-resource-lifecycle.test.js',
    'tests/note-text-color.test.js',
    'tests/note-text-color-electron.mjs'
  ],

  // Help: article/search contracts and the rendered guide/mock surfaces.
  'src/renderer/src/components/help/HelpPage.vue': [
    'tests/help-navigation-ui.test.js',
    'tests/help-support-ui.test.js',
    'tests/help-scroll-motion.test.js',
    'tests/view-visibility-shortcut-ui.test.js',
    'tests/help-center-electron.mjs'
  ],
  'src/renderer/src/components/help/help-content.js': [
    'tests/help-search.test.js',
    'tests/help-quick-links.test.js',
    'tests/view-visibility-shortcut-ui.test.js',
    'tests/help-center-electron.mjs'
  ],
  'src/renderer/src/components/help/mock/MockNewNotePanel.vue': ['tests/help-center-electron.mjs'],
  'src/renderer/src/components/help/mock/MockNoteCard.vue': ['tests/help-center-electron.mjs']
})

module.exports = { releaseRendererDomainRules }
