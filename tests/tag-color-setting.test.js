import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RENDERER_WRITABLE_SETTING_IDS } from '../src/shared/settings-schema.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('shared tag color setting', () => {
  it('is provided by list, month and week roots and applied to every note surface', () => {
    for (const root of ['src/renderer/src/App.vue', 'src/renderer/src/MonthApp.vue']) {
      const source = read(root)
      expect(source).toContain('useWorkspaceRuntime({')
    }
    const runtime = read('src/renderer/src/composables/useWorkspaceRuntime.js')
    expect(runtime).toContain('createTagColorSettingProvider()')
    expect(runtime).toContain('tagColorSetting.applySnapshot(snapshot)')

    for (const component of [
      'src/renderer/src/components/note/NoteCard.vue',
      'src/renderer/src/components/list/SearchResultCard.vue',
      'src/renderer/src/components/month/MonthEventBar.vue',
      'src/renderer/src/components/month/MonthCalendarGrid.vue'
    ]) {
      expect(read(component)).toContain('useTagColorSetting()')
    }
    expect(read('src/renderer/src/components/list/NoteList.vue')).not.toContain(
      ':color-by-tag="false"'
    )
  })

  it('exposes an enabled-by-default switch in settings', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')
    expect(panel).toContain('v-model="tagColorEnabled"')
    expect(panel).toContain("debouncedSave('notes.tagColorEnabled', v)")
  })

  it('allows the renderer IPC to persist the setting through the main process', () => {
    const main = read('src/main/index.js')
    const handlerStart = main.indexOf("mainWindowIpc.handle('set-setting-value'")
    const handlerEnd = main.indexOf('mainWindowIpc.handle(', handlerStart + 1)
    expect(handlerStart).toBeGreaterThanOrEqual(0)
    expect(handlerEnd).toBeGreaterThan(handlerStart)
    const handler = main.slice(handlerStart, handlerEnd)

    expect(RENDERER_WRITABLE_SETTING_IDS).toContain('notes.tagColorEnabled')
    expect(handler).toContain('RENDERER_WRITABLE_SETTING_IDS.has(id)')
    expect(handler).toContain('persistSettingValue(id, value)')
  })
})
