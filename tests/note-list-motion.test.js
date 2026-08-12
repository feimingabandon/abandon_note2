import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const NOTE_LIST_PATH = new URL('../src/renderer/src/components/list/NoteList.vue', import.meta.url)

function styleDeclarations(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match[1]
}

describe('便签列表高度动画结构', () => {
  it('标签组折叠外壳没有内边距，间距由内层承担', () => {
    const source = readFileSync(NOTE_LIST_PATH, 'utf8')
    const outer = styleDeclarations(source, '.nl-tag-group-content')
    const inner = styleDeclarations(source, '.nl-tag-group-content-inner')

    expect(source).toMatch(
      /class="nl-tag-group-content"[\s\S]*?<div class="nl-tag-group-content-inner">/
    )
    expect(outer).not.toMatch(/\bpadding\s*:/)
    expect(inner).toContain('padding: 7rem 0 2rem 18rem;')
  })

  it('标签组标题不缩放，箭头只在向左和向下之间旋转', () => {
    const source = readFileSync(NOTE_LIST_PATH, 'utf8')
    const header = styleDeclarations(source, '.nl-tag-group-header')
    const activeHeader = styleDeclarations(source, '.nl-tag-group-header:active')
    const chevron = styleDeclarations(source, '.nl-tag-group-chevron')
    const openChevron = styleDeclarations(source, '.nl-tag-group-chevron--open')

    expect(header).not.toContain('transform var(--motion-control)')
    expect(activeHeader).toContain('transform: none;')
    expect(chevron).toContain('transform: rotate(180deg);')
    expect(openChevron).toContain('transform: rotate(90deg);')
  })

  it('首次展开先加载便签，再挂载面板执行完整高度动画', () => {
    const source = readFileSync(NOTE_LIST_PATH, 'utf8')
    const toggleGroup = source.match(
      /async function toggleTagGroup\(group\) \{([\s\S]*?)\n\}\n\nfunction collapseAllTagGroups/
    )?.[1]

    expect(toggleGroup).toBeTruthy()
    expect(toggleGroup).toMatch(
      /const loadResult = await loadTagGroupPage\(group, \{ reset: true \}\)/
    )
    expect(toggleGroup).toMatch(
      /if \(loadResult\?\.status === 'cancelled' \|\| group\.openingRequest !== openingRequest\) return/
    )
    expect(toggleGroup.indexOf('await nextTick()')).toBeLessThan(
      toggleGroup.indexOf('group.expanded = true')
    )
  })
})
