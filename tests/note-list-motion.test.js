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

  it('标签组标题不缩放，箭头位于标签文字后并在向右和向下之间旋转', () => {
    const source = readFileSync(NOTE_LIST_PATH, 'utf8')
    const header = styleDeclarations(source, '.nl-tag-group-header')
    const activeHeader = styleDeclarations(source, '.nl-tag-group-header:active')
    const chevron = styleDeclarations(source, '.nl-tag-group-chevron')
    const openChevron = styleDeclarations(source, '.nl-tag-group-chevron--open')

    expect(header).not.toContain('transform var(--motion-control)')
    expect(activeHeader).toContain('transform: none;')
    expect(source).toMatch(
      /class="nl-tag-group-name">\{\{ group\.name \}\}<\/span>\s*<svg\s+v-if="!tagGroupSortMode"\s+class="nl-tag-group-chevron"/
    )
    expect(chevron).toContain('transform: rotate(0deg);')
    expect(openChevron).toContain('transform: rotate(90deg);')
  })

  // First-load height, reversal and slow-query intent are exercised against real
  // Chromium animation frames in note-list-animation-electron.mjs.
})
