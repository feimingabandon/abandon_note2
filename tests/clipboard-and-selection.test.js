import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('系统剪贴板与全局文字选择', () => {
  it('copies through the restricted Electron preload API instead of navigator.clipboard', () => {
    const preload = read('../src/preload/index.js')
    const ipc = read('../src/main/ipc/register-business-ipc.js')
    const card = read('../src/renderer/src/components/list/NoteCard.vue')
    const quickEditor = read('../src/renderer/src/components/note/QuickNoteContentEditor.vue')
    const logViewer = read('../src/renderer/src/components/system/LogViewerDialog.vue')

    expect(preload).toContain("ipcRenderer.invoke('clipboard:write-text'")
    expect(ipc).toContain("ipcMain.handle('clipboard:write-text'")
    expect(ipc).toContain('clipboard.writeText(text)')
    for (const source of [card, quickEditor, logViewer]) {
      expect(source).toContain('window.api.writeClipboardText(')
      expect(source).not.toContain('navigator.clipboard.writeText(')
    }
  })

  it('allows page text selection while keeping interactive controls non-selectable', () => {
    const tokens = read('../src/renderer/src/assets/tokens.css')
    const bodyRule = tokens.match(/body \{([\s\S]*?)\}/)?.[1]

    expect(bodyRule).toContain('user-select: text')
    expect(tokens).toMatch(/button,[\s\S]*?\[draggable='true'\] \{\s*user-select: none;/)
  })

  it('prevents native text selection inside styled select triggers and options', () => {
    const select = read('../src/renderer/src/components/ui/StyledSelect.vue')
    expect(select).toMatch(
      /\.sel-trigger \{[\s\S]*?-webkit-user-select: none;[\s\S]*?user-select: none;/
    )
    expect(select).toMatch(
      /\.sel-option \{[\s\S]*?-webkit-user-select: none;[\s\S]*?user-select: none;/
    )
  })
})
