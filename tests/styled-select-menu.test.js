import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('统一下拉选择面板', () => {
  it('uses the established checked-menu layout and semantic colors', () => {
    const select = read('../src/renderer/src/components/ui/StyledSelect.vue')
    expect(select).toContain('class="sel-option-check"')
    expect(select).toContain('class="sel-option-label"')
    expect(select).toMatch(/\.sel-panel \{[\s\S]*?gap: 1rem;[\s\S]*?padding: 5rem;/)
    expect(select).toMatch(
      /\.sel-option \{[\s\S]*?grid-template-columns: 18rem minmax\(0, 1fr\);[\s\S]*?align-items: center;[\s\S]*?min-height: 34rem;[\s\S]*?padding: 5rem 8rem;/
    )
    expect(select).toMatch(
      /\.sel-option:hover:not\(\.is-disabled\),[\s\S]*?color: var\(--ui-on-primary\);[\s\S]*?background-color: var\(--ui-accent\);/
    )
    expect(select).toMatch(/\.sel-option\.is-active \.sel-option-check \{\s*opacity: 1;/)
  })

  it('returns focus to normal document tab order when the teleported menu closes', () => {
    const select = read('../src/renderer/src/components/ui/StyledSelect.vue')
    const tabBranch = select.slice(
      select.indexOf("if (event.key === 'Tab')"),
      select.indexOf('\n  }', select.indexOf("if (event.key === 'Tab')"))
    )

    expect(tabBranch).toContain('open.value = false')
    expect(tabBranch).toContain('focus({ preventScroll: true })')
    expect(tabBranch).not.toContain('event.preventDefault()')
  })
})
