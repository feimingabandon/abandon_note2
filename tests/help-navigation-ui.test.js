import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HELP_PAGE_PATH = new URL('../src/renderer/src/components/help/HelpPage.vue', import.meta.url)
const APP_PATH = new URL('../src/renderer/src/App.vue', import.meta.url)
const MONTH_APP_PATH = new URL('../src/renderer/src/MonthApp.vue', import.meta.url)

describe('帮助中心导航与关闭操作', () => {
  it('提供与设置面板一致规格的关闭按钮并由各视图关闭工作区', () => {
    const help = readFileSync(HELP_PAGE_PATH, 'utf8')

    expect(help).toContain("const emit = defineEmits(['close'])")
    expect(help).toContain('class="help-page-close"')
    expect(help).toContain('@click="emit(\'close\')"')
    expect(help).toContain('width: 28rem;')
    expect(help).toContain('height: 28rem;')
    expect(readFileSync(APP_PATH, 'utf8')).toContain('<HelpPage @close="closeHelp" />')
    expect(readFileSync(MONTH_APP_PATH, 'utf8')).toContain(
      '<HelpPage :view-mode="viewMode" @close="closeHelp" />'
    )
  })

  it('按视图持久化滚动位置并在再次打开时恢复', () => {
    const help = readFileSync(HELP_PAGE_PATH, 'utf8')

    expect(help).toContain("const HELP_SCROLL_STORAGE_PREFIX = 'abandon-note:help-scroll:'")
    expect(help).toContain('localStorage.getItem(scrollStorageKey.value)')
    expect(help).toContain('localStorage.setItem(scrollStorageKey.value')
    expect(help).toContain('@scroll.passive="onContentScroll"')
    expect(help).toContain('void restoreScrollTop()')
    expect(help).toContain('saveScrollTop()')
  })

  it('滚动离开顶部后显示平滑回顶按钮', () => {
    const help = readFileSync(HELP_PAGE_PATH, 'utf8')

    expect(help).toContain('showBackToTop.value = (contentRef.value?.scrollTop ?? 0) > 240')
    expect(help).toContain('class="help-back-to-top"')
    expect(help).toContain('aria-label="回到帮助中心顶部"')
    expect(help).toContain("contentRef.value?.scrollTo({ top: 0, behavior: 'smooth' })")
  })
})
