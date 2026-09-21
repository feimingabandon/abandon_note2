import { inject, provide, readonly, ref } from 'vue'
import { DEFAULT_SETTINGS } from '../../../shared/settings-schema.js'

const TAG_COLOR_SETTING_KEY = Symbol('tag-color-setting')

export function createTagColorSettingProvider() {
  const enabled = ref(DEFAULT_SETTINGS.notes.tagColorEnabled)

  function applySnapshot(snapshot) {
    enabled.value = Boolean(
      snapshot?.values?.notes?.tagColorEnabled ?? DEFAULT_SETTINGS.notes.tagColorEnabled
    )
  }

  const context = { enabled: readonly(enabled), applySnapshot }
  provide(TAG_COLOR_SETTING_KEY, context)
  return context
}

export function useTagColorSetting() {
  return (
    inject(TAG_COLOR_SETTING_KEY, null) || {
      enabled: readonly(ref(DEFAULT_SETTINGS.notes.tagColorEnabled))
    }
  )
}
