import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('便签正文局部文字颜色', () => {
  it('persists ranges through schema, database, IPC and preload', () => {
    const schema = read('../src/main/db/db-schema.js')
    const notes = read('../src/main/db/db-notes.js')
    const ipc = read('../src/main/ipc/register-business-ipc.js')
    const preload = read('../src/preload/index.js')

    expect(schema).toContain('export const DATABASE_SCHEMA_VERSION = 15')
    expect(schema).toContain("content_color_ranges TEXT  NOT NULL DEFAULT '[]'")
    expect(notes).toContain('reconcileNoteTextColorRanges(')
    expect(notes).toContain('export function updateNoteTextColor(')
    expect(ipc).toContain("ipcMain.handle('notes:set-text-color'")
    expect(preload).toContain("ipcRenderer.invoke('notes:set-text-color', payload)")
  })

  it('offers one popover for setting, selected clearing and whole-note clearing', () => {
    const card = read('../src/renderer/src/components/list/NoteCard.vue')
    const popover = read('../src/renderer/src/components/note/NoteTextColorPopover.vue')

    expect(card).toContain('@pointerup="onContentPointerUp"')
    expect(card).toContain('<NoteTextColorPopover')
    expect(popover).toContain('NOTE_TEXT_COLOR_PRESETS')
    expect(popover).toContain('清除所选颜色')
    expect(popover).toContain('清除本便签全部颜色')
    expect(card).toContain("'nl-card-text__colored': segment.color")
    expect(card).toContain('color: color-mix(in srgb, var(--note-range-color)')
    expect(popover).toContain('z-index: var(--z-global-popover)')
    expect(popover).toContain('background: var(--surface-float)')
  })

  it('uses the shared colored editor in full create and edit forms', () => {
    const editor = read('../src/renderer/src/components/note/ColoredTextEditor.vue')
    const noteEditor = read('../src/renderer/src/components/note/NoteEditor.vue')
    const listCreator = read('../src/renderer/src/components/list/NewNotePanel.vue')
    const monthCreator = read('../src/renderer/src/components/month/MonthNoteCreator.vue')

    expect(editor).toContain('class="rt-textarea colored-text-editor__textarea"')
    expect(editor).toContain('reconcileNoteTextColorRanges(')
    expect(editor).toContain('<NoteTextColorPopover')
    for (const source of [noteEditor, listCreator, monthCreator]) {
      expect(source).toContain('<ColoredTextEditor')
      expect(source).toContain('v-model:color-ranges="contentColorRanges"')
    }
  })

  it('allows persisted note text selection coloring from month and week detail popovers', () => {
    const eventBar = read('../src/renderer/src/components/month/MonthEventBar.vue')

    expect(eventBar).toContain('ref="tooltipContentRef"')
    expect(eventBar).toContain('@pointerup="onTooltipPointerUp"')
    expect(eventBar).toContain('<NoteTextColorPopover')
    expect(eventBar).toContain('window.api.setNoteTextColor({')
    expect(eventBar).toContain('previewSegments')
    expect(eventBar).toContain('colorSegment.color ? { color: colorSegment.color } : undefined')
  })

  it('renders persisted colors in search results without replacing plain-text search highlights', () => {
    const searchCard = read('../src/renderer/src/components/list/SearchResultCard.vue')

    expect(searchCard).toContain('buildNoteTextColorSegments(')
    expect(searchCard).toContain("'src-content__colored': part.color")
    expect(searchCard).toContain('class="src-highlight"')
  })
})
