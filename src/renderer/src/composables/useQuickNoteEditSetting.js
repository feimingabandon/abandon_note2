import { inject, provide, readonly, ref } from 'vue'
import { DEFAULT_SETTINGS } from '../../../shared/settings-schema.js'

const QUICK_NOTE_EDIT_SETTING_KEY = Symbol('quick-note-edit-setting')

export function createQuickNoteEditSettingProvider() {
  const enabled = ref(DEFAULT_SETTINGS.interaction.doubleClickQuickEdit)

  function applySnapshot(snapshot) {
    enabled.value = Boolean(
      snapshot?.values?.interaction?.doubleClickQuickEdit ??
      DEFAULT_SETTINGS.interaction.doubleClickQuickEdit
    )
  }

  const context = { enabled: readonly(enabled), applySnapshot }
  provide(QUICK_NOTE_EDIT_SETTING_KEY, context)
  return context
}

export function useQuickNoteEditSetting() {
  return (
    inject(QUICK_NOTE_EDIT_SETTING_KEY, null) || {
      enabled: readonly(ref(DEFAULT_SETTINGS.interaction.doubleClickQuickEdit))
    }
  )
}
