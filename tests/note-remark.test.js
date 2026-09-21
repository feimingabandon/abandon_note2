import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('便签备注', () => {
  it('persists the remark in schema, note updates and list DTOs', () => {
    const schema = read('../src/main/db/db-schema.js')
    const notes = read('../src/main/db/db-notes.js')

    expect(schema).toContain('export const DATABASE_SCHEMA_VERSION = 14')
    expect(schema).toContain("ALTER TABLE notes ADD COLUMN remark TEXT NOT NULL DEFAULT ''")
    expect(schema).toContain("remark              TEXT    NOT NULL DEFAULT ''")
    expect(notes).toContain(
      "fields.remark === undefined ? old.remark : String(fields.remark ?? '')"
    )
    expect(notes).toContain('content = ?, content_color_ranges = ?, remark = ?, is_pinned = ?')
    expect(notes).toContain('remark: note.remark')
  })

  it('protects both quick-edit fields from concurrent overwrites', () => {
    const preload = read('../src/preload/index.js')
    const ipc = read('../src/main/ipc/register-business-ipc.js')

    expect(preload).toContain('updateNote: (id, fields, expectedContent, expectedRemark)')
    expect(ipc).toContain('expectedContent !== undefined && current.content !== expectedContent')
    expect(ipc).toContain('expectedRemark !== undefined && current.remark !== expectedRemark')
  })

  it('shows the remark below the body and opens one shared two-field editor', () => {
    const card = read('../src/renderer/src/components/list/NoteCard.vue')
    const editor = read('../src/renderer/src/components/note/QuickNoteContentEditor.vue')
    const tokens = read('../src/renderer/src/assets/tokens.css')
    const contentIndex = card.indexOf('ref="contentTextRef"')
    const remarkIndex = card.indexOf('class="nl-card-remark-text"')
    const metadataIndex = card.indexOf('class="nl-card-meta"')
    const remarkStyle = card.match(/\.nl-card-remark-text \{([\s\S]*?)\}/)?.[1]

    expect(card).toContain('class="nl-card-remark-toggle"')
    expect(card).toContain('@click.stop="openQuickEditor($event, true)"')
    expect(card).toContain('font-size: var(--note-remark-font-size)')
    expect(remarkStyle).toContain('color: var(--text-color-secondary)')
    expect(tokens).toContain('--note-remark-font-size: calc(var(--font-size-base) - 1rem)')
    expect(card).not.toContain('class="nl-card-remark"')
    expect(contentIndex).toBeGreaterThan(-1)
    expect(remarkIndex).toBeGreaterThan(contentIndex)
    expect(metadataIndex).toBeGreaterThan(remarkIndex)
    expect(remarkStyle).toContain('max-height: none')
    expect(remarkStyle).toContain('overflow: visible')
    expect(remarkStyle).toContain('overflow-wrap: anywhere')
    expect(remarkStyle).toContain('text-overflow: clip')
    expect(remarkStyle).toContain('white-space: pre-wrap')
    expect(remarkStyle).not.toContain('line-clamp')
    expect(editor).toContain('v-model="contentDraft"')
    expect(editor).toContain('v-model="remarkDraft"')
    expect(editor).toContain('{ content, remark }')
  })

  it('uses an independently persisted remark font size while retaining the secondary color', () => {
    const schema = read('../src/shared/settings-schema.js')
    const panel = read('../src/renderer/src/components/system/SettingsPanel.vue')
    const applySnapshot = read('../src/renderer/src/utils/applySettingsSnapshot.js')

    expect(schema).toContain("id: 'css.noteRemarkFontSize'")
    expect(schema).toContain("key: 'note_remark_font_size'")
    expect(panel).toContain('v-model="noteRemarkFontSize"')
    expect(panel).toContain("debouncedSave('css.noteRemarkFontSize', v)")
    expect(applySnapshot).toContain(
      "root.style.setProperty('--note-remark-font-size', `${css.noteRemarkFontSize}rem`)"
    )
  })
})
