import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TAG_SELECTOR_PATH = new URL(
  '../src/renderer/src/components/ui/TagSelector.vue',
  import.meta.url
)

describe('标签选择器交互', () => {
  it('单选场景选择新标签时替换旧标签，多选场景仍保留上限提示', () => {
    const selector = readFileSync(TAG_SELECTOR_PATH, 'utf8')
    const toggleBlock = selector.match(/function toggleTag\(tagId\) \{([\s\S]*?)\n\}/)?.[1] || ''

    expect(toggleBlock).toContain('if (props.maxSelected === 1)')
    expect(toggleBlock).toContain('next.clear()')
    expect(toggleBlock).toContain('next.add(id)')
    expect(toggleBlock.indexOf('next.clear()')).toBeLessThan(toggleBlock.indexOf('next.add(id)'))
    expect(toggleBlock).toContain("emit('selectionLimitExceeded', props.maxSelected)")
  })
})
