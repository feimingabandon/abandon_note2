import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SETTINGS_PANEL_PATH = new URL(
  '../src/renderer/src/components/system/SettingsPanel.vue',
  import.meta.url
)
const HELP_PAGE_PATH = new URL('../src/renderer/src/components/help/HelpPage.vue', import.meta.url)

describe('dock settings UI', () => {
  it('offers the confirmation control and all three edges in the shared settings panel', () => {
    const source = readFileSync(SETTINGS_PANEL_PATH, 'utf8')

    expect(source).toContain('<h3 class="section-title">贴边隐藏</h3>')
    expect(source).toContain('>贴边隐藏小黑条<HelpButton')
    expect(source).toContain('aria-label="贴边隐藏小黑条"')
    expect(source).toContain('触碰隐藏窗口所在边缘时会先出现小黑条')
    expect(source).toContain('点击小黑条后才展开完整窗口')
    expect(source).toContain('关闭后，鼠标触边会直接展开窗口')
    expect(source).toContain('v-for="edge in dockEdgeOptions"')
    expect(source).toContain(':aria-pressed="dockEnabledEdges.includes(edge.value)"')
    expect(source).toContain('未选择边缘时，当前{{ currentViewLabel }}不会贴边隐藏')
    expect(source).toContain('window.api.setDockConfig({')
    expect(source).toContain('当前原生组件版本不支持小黑条模式')
    expect(source).toContain('(!dockRuntime.revealHandleSupported && !dockRevealHandleEnabled)')
    expect(source).toContain(':disabled="!dockRuntime.supported"')
  })

  it('documents per-view edge selection and click confirmation behavior', () => {
    const source = readFileSync(HELP_PAGE_PATH, 'utf8')

    expect(source).toContain('列表、月和周视图分别多选上、左、右边缘')
    expect(source).toContain('开启“贴边隐藏小黑条”')
    expect(source).toContain('只有点击小黑条后才展开完整窗口')
    expect(source).toContain('关闭该选项时则会触边直接展开')
  })
})
