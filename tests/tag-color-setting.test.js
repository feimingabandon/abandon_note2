import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('shared tag color setting', () => {
  it('is provided by list, month and week roots and applied to every note surface', () => {
    for (const root of ['src/renderer/src/App.vue', 'src/renderer/src/MonthApp.vue']) {
      const source = read(root)
      expect(source).toContain('createTagColorSettingProvider()')
      expect(source).toContain('tagColorSetting.applySnapshot(snapshot)')
    }

    for (const component of [
      'src/renderer/src/components/list/NoteCard.vue',
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
    const allowlistStart = main.indexOf('const RENDERER_WRITABLE_SETTING_IDS')
    const allowlist = main.slice(allowlistStart, main.indexOf('])', allowlistStart) + 2)
    const handlerStart = main.indexOf("mainWindowIpc.handle('set-setting-value'")
    const handler = main.slice(handlerStart, main.indexOf('\n  })', handlerStart) + 4)

    expect(allowlist).toContain("'notes.tagColorEnabled'")
    expect(handler).toContain('RENDERER_WRITABLE_SETTING_IDS.has(id)')
    expect(handler).toContain('persistSettingValue(id, value)')
  })
})
