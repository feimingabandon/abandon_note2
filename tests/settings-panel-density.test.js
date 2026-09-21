import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('shared settings panel density', () => {
  it('removes redundant compact-window controls and shared-scope copy', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')

    expect(panel).not.toContain('<h3 class="section-title">灵动岛</h3>')
    expect(panel).not.toContain('COMPACT_WINDOW_LIMITS')
    expect(panel).not.toContain('所有视图</small>')
    expect(panel).not.toContain('列表、月视图和周视图共用')
    expect(panel).toContain('标注“所有”的项目由三个视图共用')
    expect(panel).toContain('灵动岛字号 <small>所有</small')
    expect(panel).toContain('v-model="compactFontSize"')
  })

  it('keeps calendar status and actions in compact shared rows', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')

    expect(panel).toContain('class="setting-item holiday-summary-row"')
    expect(panel).toContain('class="holiday-summary-item"')
    expect(panel).toContain('holiday-action-row')
    expect(panel).toContain('浏览器打开')
  })

  it('removes draft settings and shows human-readable scheduler task labels', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')

    expect(panel).not.toContain('编辑草稿 <small>')
    expect(panel).not.toContain('导出未保存草稿')
    expect(panel).not.toContain('listEditingDrafts')
    expect(panel).toContain("activationTask: '便签生效与提醒'")
    expect(panel).toContain('{{ schedulerTaskLabel(task.name) }}')
  })

  it('removes only the long weather explanation while retaining live feedback', () => {
    const weather = read('src/renderer/src/components/weather/WeatherSettings.vue')

    expect(weather).not.toContain('只在点击后请求系统权限')
    expect(weather).toContain(`v-if="busy === 'save'"`)
    expect(weather).toContain('v-if="error"')
    expect(weather).toContain('flex: 0 0 auto')
    expect(weather).not.toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.weather-settings__picker[\s\S]*?flex-direction: column/
    )
  })

  it('offers the shared screenshot main-view visibility switch', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')

    expect(panel).toContain('截图时隐藏主视图')
    expect(panel).toContain('v-model="hideMainViewDuringScreenshot"')
    expect(panel).toContain("debouncedSave('interaction.hideMainViewDuringScreenshot', v)")
  })

  it('preserves thumbnail aspect ratio and limits the longest edge', () => {
    const picker = read('src/renderer/src/components/note/ImagePicker.vue')

    expect(picker).toContain("'--ip-thumb-width': `${widthFactor * 100}%`")
    expect(picker).toContain('aspect-ratio: var(--ip-thumb-aspect, 1)')
    expect(picker).toContain('justify-self: center')
    expect(picker).toContain('align-self: center')
    expect(picker).toContain('object-fit: contain')
    expect(picker).not.toContain('object-fit: cover')
    expect(picker).not.toMatch(/\.ip-thumb \{[^}]*padding:/)
  })
})
