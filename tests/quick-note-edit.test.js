import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('双击快速编辑正文', () => {
  it('uses one shared editor with blur-save, escape-cancel and semantic Apple-style tokens', () => {
    const editor = read('../src/renderer/src/components/note/QuickNoteContentEditor.vue')

    expect(editor).toContain(
      '.updateNote(props.note.id, { content, remark }, originalContent.value, originalRemark.value)'
    )
    expect(editor).toContain('@focusout="onFocusOut"')
    expect(editor).toContain("window.addEventListener('blur', commit)")
    expect(editor).toContain('@keydown.esc="cancel"')
    expect(editor).toContain("showMessage('success', '便签已保存')")
    expect(editor).toContain('z-index: var(--z-global-editor)')
    expect(editor).toContain('background: var(--surface-float)')
    expect(editor).toContain('border: 1px solid var(--ui-border-control)')
    expect(editor).toContain('v-model="contentDraft"')
    expect(editor).toContain('v-model="remarkDraft"')
    expect(editor).toContain('class="quick-note-editor__divider"')
  })

  it('wires list cards and calendar bars without hijacking their explicit controls', () => {
    const card = read('../src/renderer/src/components/list/NoteCard.vue')
    const eventBar = read('../src/renderer/src/components/month/MonthEventBar.vue')

    expect(card).toContain('@dblclick="openQuickEditor"')
    expect(card).toContain('@click.stop="openQuickEditor($event, true)"')
    expect(card).toContain('class="nl-card-remark-text"')
    expect(card).toContain('.nl-drag-handle, .nl-image-panel-shell')
    expect(card).toContain('<QuickNoteContentEditor')
    expect(eventBar).toContain('@dblclick="openQuickEditor"')
    expect(eventBar).toContain('SINGLE_CLICK_DELAY_MS')
    expect(eventBar).toContain('pointerAnchorRect(event')
    expect(eventBar).toContain('void toggleTooltip(anchor)')
    expect(eventBar).toContain('<QuickNoteContentEditor')
  })

  it('provides one application-level setting to both renderer roots', () => {
    const listApp = read('../src/renderer/src/App.vue')
    const monthApp = read('../src/renderer/src/MonthApp.vue')
    const panel = read('../src/renderer/src/components/system/SettingsPanel.vue')

    expect(listApp).toContain('createQuickNoteEditSettingProvider()')
    expect(monthApp).toContain('createQuickNoteEditSettingProvider()')
    expect(panel).toContain('v-model="doubleClickQuickEdit"')
    expect(panel).toContain('双击快速编辑正文')
    expect(panel).toContain("debouncedSave('interaction.doubleClickQuickEdit', v)")
    expect(panel).toContain('便签交互 <small>所有</small>')
  })
})
