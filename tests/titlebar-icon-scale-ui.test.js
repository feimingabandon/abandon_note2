import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('titlebar icon scale UI wiring', () => {
  it('shows the requested shared setting name and range', () => {
    const source = read('src/renderer/src/components/system/SettingsPanel.vue')

    expect(source).toContain('导航栏图标大小')
    expect(source).toContain('appearance.titlebarIconScale')
    expect(source).toContain(':min="TITLEBAR_ICON_SCALE_LIMITS.min"')
    expect(source).toContain(':max="TITLEBAR_ICON_SCALE_LIMITS.max"')
    expect(source).toContain('<span class="range-label-start" aria-hidden="true"></span>')
    expect(source).not.toContain('<span class="range-label-start">标准</span>')
    expect(source).toContain('图标颜色')
    expect(source).toContain('appearance.iconColor')
    expect(source).toContain('ICON_COLORS.BLACK')
    expect(source).toContain('ICON_COLORS.WHITE')
  })

  it('scales Apple controls but keeps Microsoft button boxes fixed', () => {
    const titlebar = read('src/renderer/src/components/system/AppTitlebar.vue')
    const actions = read('src/renderer/src/components/system/TitlebarActions.vue')

    expect(titlebar).toContain('var(--titlebar-apple-control-size, 18rem)')
    expect(actions).toContain('var(--titlebar-apple-control-size, 18rem)')
    expect(titlebar).toMatch(
      /\.app-titlebar--microsoft \.light \{[\s\S]*?width: 32rem;[\s\S]*?height: 30rem;/
    )
    expect(actions).toMatch(
      /titlebar-actions-group--microsoft :deep\(\.titlebar-btn\) \{[\s\S]*?width: 32rem;[\s\S]*?height: 30rem;/
    )
    expect(titlebar).toContain('var(--titlebar-microsoft-icon-size, 15rem)')
    expect(actions).toContain('var(--titlebar-microsoft-icon-size, 15rem)')
  })

  it('uses one themed component with black and white SVG files for all 11 icons', () => {
    const appIcon = read('src/renderer/src/components/ui/AppIcon.vue')
    const filterTabs = read('src/renderer/src/components/ui/FilterTabs.vue')
    const names = [
      'compact',
      'daily-report',
      'recurrence',
      'settings',
      'help',
      'pin',
      'lock',
      'close',
      'tag',
      'taiji',
      'clover'
    ]

    expect(appIcon).toContain("html[data-icon-color='white']")
    expect(filterTabs).toContain("'tag'")
    expect(filterTabs).toContain("'taiji'")
    expect(filterTabs).toContain("'clover'")

    for (const name of names) {
      expect(appIcon).toContain(`/icons/${name}.svg`)
      expect(appIcon).toContain(`/icons/${name}-white.svg`)
      for (const suffix of ['', '-white']) {
        const icon = read(`resources/icons/${name}${suffix}.svg`)
        expect(icon).toContain('<svg')
        expect(icon).toContain('viewBox="0 0 24 24"')
        expect(icon).toContain('stroke-width="1.7"')
        expect(icon).toContain('stroke-linecap="round"')
      }
    }
  })
})
