import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('note duration modes', () => {
  it('offers three shared modes and keeps single-day as the default', () => {
    const field = readSource('src/renderer/src/components/note/NoteDurationField.vue')
    const listCreator = readSource('src/renderer/src/components/list/NewNotePanel.vue')
    const calendarCreator = readSource('src/renderer/src/components/month/MonthNoteCreator.vue')
    const editor = readSource('src/renderer/src/components/note/NoteEditor.vue')

    for (const label of ['仅当天', '指定天数', '持续到完成']) expect(field).toContain(label)
    expect(field).toContain(':min="2"')
    for (const source of [listCreator, calendarCreator]) {
      expect(source).toContain('ref(NOTE_DURATION_KINDS.SINGLE_DAY)')
      expect(source).toContain('v-model:kind="durationKind"')
      expect(source).toContain('durationKind: durationKind.value')
    }
    expect(listCreator).toContain('<NoteDurationField')
    expect(listCreator).toContain('visible')
    expect(editor).toMatch(/durationKind:\s*note\.duration_kind/)
  })

  it('removes the historical move control and APIs', () => {
    const toolbar = readSource('src/renderer/src/components/month/MonthCalendarToolbar.vue')
    const preload = readSource('src/preload/index.js')
    const main = readSource('src/main/index.js')
    const settings = readSource('src/shared/settings-schema.js')

    expect(toolbar).not.toContain('HistoricalNoteMoveControl')
    expect(preload).not.toContain('moveHistoricalNotesToToday')
    expect(main).not.toContain('automaticNoteMoveTask')
    expect(settings).not.toContain('notes.autoMoveYesterday')
  })
})
