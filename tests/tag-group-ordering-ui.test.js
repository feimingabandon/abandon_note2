import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const NOTE_LIST_PATH = new URL('../src/renderer/src/components/list/NoteList.vue', import.meta.url)
const NOTE_CARD_PATH = new URL('../src/renderer/src/components/list/NoteCard.vue', import.meta.url)
const TAG_EDITOR_PATH = new URL(
  '../src/renderer/src/components/ui/TagEditorForm.vue',
  import.meta.url
)
const HELP_PAGE_PATH = new URL('../src/renderer/src/components/help/HelpPage.vue', import.meta.url)

describe('标签分组排序与右键入口', () => {
  it('通过独立按钮进入整行拖拽模式，并保持未分类不可拖动', () => {
    const list = readFileSync(NOTE_LIST_PATH, 'utf8')

    expect(list).toContain('v-if="sortMode === \'tag-group\'"')
    expect(list).toContain('class="nl-tag-group-sort-toggle"')
    expect(list).toContain('@click="toggleTagGroupSortMode"')
    expect(list).toContain('handle=".nl-tag-group-sort-handle"')
    expect(list).toContain(':disabled="!tagGroupSortMode"')
    expect(list).not.toContain(':delay="320"')
    expect(list).not.toContain('nl-tag-group-drag-handle')
    expect(list).toContain('@start="onTagGroupDragStart"')
    expect(list).toContain('const shouldWaitForCollapse = tagGroups.value.some')
    expect(list).toContain('collapseAllTagGroups()')
    expect(list).toContain('if (event.draggedContext?.element?.untagged) return false')
    expect(list).toContain('event.relatedContext?.element?.untagged && event.willInsertAfter')
    expect(list).toContain('.filter((group) => !group.untagged)')
    expect(readFileSync(HELP_PAGE_PATH, 'utf8')).toContain('再进入整行拖动模式')
  })

  it('只在标签分组卡片开启新建标签分组菜单入口', () => {
    const list = readFileSync(NOTE_LIST_PATH, 'utf8')
    const card = readFileSync(NOTE_CARD_PATH, 'utf8')

    expect(card).toContain('allowCreateTag: { type: Boolean, default: false }')
    expect(card).toContain("emit('create-tag')")
    expect(list).toContain('allow-create-tag')
    expect(list).toContain('@contextmenu="openTagGroupContextMenu"')
    expect(list).toContain('新建标签分组')
  })

  it('标签编辑表单不再暴露置顶设置', () => {
    const editor = readFileSync(TAG_EDITOR_PATH, 'utf8')

    expect(editor).not.toContain('置顶标签')
    expect(editor).not.toContain('update:pinned')
  })
})
