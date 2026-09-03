import { describe, expect, it } from 'vitest'
import {
  formatViewVisibilityShortcut,
  normalizeViewVisibilityShortcut,
  shortcutCaptureFromKeyboardEvent,
  validateViewVisibilityShortcut
} from '../src/shared/view-visibility-shortcut.js'

describe('view visibility shortcut', () => {
  it('normalizes modifier aliases and uses a stable Electron accelerator order', () => {
    expect(normalizeViewVisibilityShortcut('shift+ctrl+alt+n')).toBe('Control+Alt+Shift+N')
    expect(normalizeViewVisibilityShortcut('win+F11')).toBe('Super+F11')
    expect(normalizeViewVisibilityShortcut('not-a-shortcut')).toBe('')
  })

  it('requires a modifier for ordinary keys but permits function keys alone', () => {
    expect(validateViewVisibilityShortcut('N')).toMatchObject({
      valid: false,
      code: 'modifier-required'
    })
    expect(validateViewVisibilityShortcut('Control+N')).toMatchObject({
      valid: true,
      accelerator: 'Control+N'
    })
    expect(validateViewVisibilityShortcut('F11')).toMatchObject({
      valid: true,
      accelerator: 'F11'
    })
  })

  it('rejects reserved operating-system shortcuts', () => {
    expect(validateViewVisibilityShortcut('Alt+F4')).toMatchObject({
      valid: false,
      code: 'reserved'
    })
    expect(validateViewVisibilityShortcut('Command+Q')).toMatchObject({
      valid: false,
      code: 'reserved'
    })
  })

  it('captures keyboard events without accepting modifier-only input', () => {
    expect(
      shortcutCaptureFromKeyboardEvent(
        { key: 'Control', code: 'ControlLeft', ctrlKey: true },
        'win32'
      )
    ).toMatchObject({ action: 'incomplete', accelerator: 'Control' })
    expect(
      shortcutCaptureFromKeyboardEvent(
        { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true },
        'win32'
      )
    ).toEqual({
      action: 'candidate',
      accelerator: 'Control+Alt+N',
      display: 'Ctrl + Alt + N',
      code: 'valid'
    })
    expect(shortcutCaptureFromKeyboardEvent({ key: 'Escape' }, 'win32').action).toBe('cancel')
  })

  it('formats the same accelerator for Windows and macOS', () => {
    expect(formatViewVisibilityShortcut('Control+Alt+N', 'win32')).toBe('Ctrl + Alt + N')
    expect(formatViewVisibilityShortcut('Command+Shift+Up', 'darwin')).toBe('⌘ + ⇧ + ↑')
  })
})
