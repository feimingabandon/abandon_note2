import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SETTINGS_PANEL_PATH = new URL(
  '../src/renderer/src/components/system/SettingsPanel.vue',
  import.meta.url
)
const HELP_PAGE_PATH = new URL('../src/renderer/src/components/help/HelpPage.vue', import.meta.url)

describe('dock settings UI', () => {
  it('offers all three reveal modes and all three edges in the shared settings panel', () => {
    const source = readFileSync(SETTINGS_PANEL_PATH, 'utf8')

    expect(source).toContain('<h3 class="section-title">贴边隐藏</h3>')
    expect(source).toContain('>隐藏后的唤出方式<HelpButton')
    expect(source).toContain('aria-label="隐藏后的唤出方式"')
    expect(source).toContain("label: '直接唤出'")
    expect(source).toContain("label: '触边确认'")
    expect(source).toContain("label: '常显确认'")
    expect(source).toContain('外部程序全屏时常显条会暂时收回')
    expect(source).toContain('v-for="edge in dockEdgeOptions"')
    expect(source).toContain(':aria-pressed="dockEnabledEdges.includes(edge.value)"')
    expect(source).toContain('未选择边缘时，当前{{ currentViewLabel }}不会贴边隐藏')
    expect(source).toContain('window.api.setDockConfig({')
    expect(source).toContain('return !dockRuntime.value.supported ||')
    expect(source).toContain(':disabled="isDockRevealModeDisabled(option.value)"')
    expect(source).toContain(':disabled="!dockRuntime.supported"')
  })

  it('documents per-view edge selection and all reveal modes', () => {
    const source = readFileSync(HELP_PAGE_PATH, 'utf8')

    expect(source).toContain('列表、月和周视图分别多选上、左、右边缘')
    expect(source).toContain('“直接唤出”会在鼠标触边后立即展开窗口')
    expect(source).toContain('“触边确认”会先显示小黑条')
    expect(source).toContain('“常显确认”会在窗口收起完成后自动显示小黑条并保持')
    expect(source).toContain('退出全屏后自动恢复')
  })

  it('reflows the three-mode selector against the settings panel width', () => {
    const source = readFileSync(SETTINGS_PANEL_PATH, 'utf8')
    const dockSection = source.slice(source.indexOf('<h3 class="section-title">贴边隐藏</h3>'))

    expect(dockSection).toMatch(
      /<div class="setting-item dock-reveal-setting">[\s\S]*?>隐藏后的唤出方式<HelpButton/
    )
    expect(source).toContain('container-type: inline-size')
    expect(source).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(source).toContain('@container (max-width: 300px)')
    expect(source).toMatch(
      /@container \(max-width: 300px\)[\s\S]*?\.dock-reveal-mode-selector\s*{[\s\S]*?grid-template-columns:\s*1fr/
    )
  })
})
