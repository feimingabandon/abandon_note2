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
    expect(normalizeViewVisibilityShortcut('meta+F11')).toBe('Super+F11')
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
    expect(validateViewVisibilityShortcut('Win+L')).toMatchObject({
      valid: false,
      code: 'reserved'
    })
  })

  it('captures keyboard events without accepting modifier-only input', () => {
    expect(
      shortcutCaptureFromKeyboardEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true })
    ).toMatchObject({ action: 'incomplete', accelerator: 'Control' })
    expect(
      shortcutCaptureFromKeyboardEvent({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true })
    ).toEqual({
      action: 'candidate',
      accelerator: 'Control+Alt+N',
      display: 'Ctrl + Alt + N',
      code: 'valid'
    })
    expect(shortcutCaptureFromKeyboardEvent({ key: 'Escape' }).action).toBe('cancel')
  })

  it('formats Windows modifiers and directional keys', () => {
    expect(formatViewVisibilityShortcut('Control+Alt+N')).toBe('Ctrl + Alt + N')
    expect(formatViewVisibilityShortcut('Super+Shift+Up')).toBe('Win + Shift + ↑')
  })

  it('rejects Mac modifier names rather than converting them to Windows shortcuts', () => {
    for (const value of ['cmd+F9', 'Command+N', 'Option+F9']) {
      expect(validateViewVisibilityShortcut(value)).toMatchObject({
        valid: false,
        code: 'unsupported'
      })
      expect(formatViewVisibilityShortcut(value)).toBe('')
    }
  })

  it('shows a modifier-only Windows key as an incomplete Win preview', () => {
    for (const code of ['MetaLeft', 'MetaRight']) {
      expect(shortcutCaptureFromKeyboardEvent({ key: 'Meta', code, metaKey: true })).toEqual({
        action: 'incomplete',
        accelerator: 'Super',
        display: 'Win',
        code: 'incomplete'
      })
    }
    expect(
      shortcutCaptureFromKeyboardEvent({
        key: 'Meta',
        code: 'MetaLeft',
        ctrlKey: true,
        metaKey: true
      })
    ).toEqual({
      action: 'incomplete',
      accelerator: 'Control+Super',
      display: 'Ctrl + Win',
      code: 'incomplete'
    })
  })

  it('captures the Windows key with the physical key code and rejects its reserved lock action', () => {
    expect(shortcutCaptureFromKeyboardEvent({ key: 'т', code: 'KeyN', metaKey: true })).toEqual({
      action: 'candidate',
      accelerator: 'Super+N',
      display: 'Win + N',
      code: 'valid'
    })
    expect(
      shortcutCaptureFromKeyboardEvent({ key: 'l', code: 'KeyL', metaKey: true })
    ).toMatchObject({
      action: 'invalid',
      accelerator: 'Super+L',
      code: 'reserved'
    })
    expect(validateViewVisibilityShortcut('meta+win+N')).toMatchObject({
      valid: false,
      code: 'duplicate'
    })
  })
})
