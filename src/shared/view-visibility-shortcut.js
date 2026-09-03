export const VIEW_VISIBILITY_SHORTCUT_DEFAULT = ''

const MODIFIER_ORDER = Object.freeze(['Control', 'Command', 'Super', 'Alt', 'Shift'])
const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['cmd', 'Command'],
  ['command', 'Command'],
  ['meta', 'Command'],
  ['super', 'Super'],
  ['win', 'Super'],
  ['windows', 'Super'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift']
])
const NAMED_KEYS = new Map([
  ['space', 'Space'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['arrowup', 'Up'],
  ['up', 'Up'],
  ['arrowdown', 'Down'],
  ['down', 'Down'],
  ['arrowleft', 'Left'],
  ['left', 'Left'],
  ['arrowright', 'Right'],
  ['right', 'Right'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['insert', 'Insert'],
  ['delete', 'Delete'],
  ['backspace', 'Backspace']
])
const RESERVED_SHORTCUTS = new Set(['Alt+F4', 'Command+Q', 'Command+W', 'Super+L'])

function normalizePrimaryKey(value) {
  const raw = String(value || '').trim()
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase()
  if (/^[0-9]$/.test(raw)) return raw
  if (/^f(?:[1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase()
  return NAMED_KEYS.get(raw.toLowerCase()) || null
}

export function validateViewVisibilityShortcut(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { valid: true, accelerator: '', code: 'empty' }
  }

  const parts = String(value)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const modifiers = []
  let primaryKey = null

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase())
    if (modifier) {
      if (modifiers.includes(modifier)) return { valid: false, accelerator: '', code: 'duplicate' }
      modifiers.push(modifier)
      continue
    }
    const key = normalizePrimaryKey(part)
    if (!key || primaryKey) return { valid: false, accelerator: '', code: 'unsupported' }
    primaryKey = key
  }

  if (!primaryKey) return { valid: false, accelerator: '', code: 'incomplete' }
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(primaryKey)) {
    return { valid: false, accelerator: '', code: 'modifier-required' }
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier))
  const accelerator = [...orderedModifiers, primaryKey].join('+')
  if (RESERVED_SHORTCUTS.has(accelerator)) {
    return { valid: false, accelerator, code: 'reserved' }
  }
  return { valid: true, accelerator, code: 'valid' }
}

export function normalizeViewVisibilityShortcut(
  value,
  fallback = VIEW_VISIBILITY_SHORTCUT_DEFAULT
) {
  const result = validateViewVisibilityShortcut(value)
  return result.valid ? result.accelerator : fallback
}

export function formatViewVisibilityShortcut(value, platform = 'win32') {
  const result = validateViewVisibilityShortcut(value)
  if (!result.valid || !result.accelerator) return ''
  const displayModifiers = {
    Control: platform === 'darwin' ? '⌃' : 'Ctrl',
    Command: platform === 'darwin' ? '⌘' : 'Command',
    Super: platform === 'darwin' ? '⌘' : 'Win',
    Alt: platform === 'darwin' ? 'Option' : 'Alt',
    Shift: platform === 'darwin' ? '⇧' : 'Shift'
  }
  const displayKeys = { Up: '↑', Down: '↓', Left: '←', Right: '→' }
  return result.accelerator
    .split('+')
    .map((part) => displayModifiers[part] || displayKeys[part] || part)
    .join(' + ')
}

function primaryKeyFromKeyboardEvent(event) {
  const code = String(event?.code || '')
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code
  return normalizePrimaryKey(event?.key)
}

export function shortcutCaptureFromKeyboardEvent(event, platform = 'win32') {
  const key = String(event?.key || '')
  const modifiers = []
  if (event?.ctrlKey) modifiers.push('Control')
  if (event?.metaKey) modifiers.push(platform === 'darwin' ? 'Command' : 'Super')
  if (event?.altKey) modifiers.push('Alt')
  if (event?.shiftKey) modifiers.push('Shift')

  if (key === 'Escape' && modifiers.length === 0) {
    return { action: 'cancel', accelerator: '', display: '', code: 'cancel' }
  }

  const primaryKey = primaryKeyFromKeyboardEvent(event)
  if (!primaryKey) {
    const preview = modifiers.join('+')
    return {
      action: MODIFIER_ALIASES.has(key.toLowerCase()) ? 'incomplete' : 'invalid',
      accelerator: preview,
      display: preview ? formatModifierPreview(preview, platform) : '',
      code: preview ? 'incomplete' : 'unsupported'
    }
  }

  const result = validateViewVisibilityShortcut([...modifiers, primaryKey].join('+'))
  return {
    action: result.valid ? 'candidate' : 'invalid',
    accelerator: result.accelerator,
    display: result.accelerator
      ? formatViewVisibilityShortcut(result.accelerator, platform)
      : [...modifiers, primaryKey].join(' + '),
    code: result.code
  }
}

function formatModifierPreview(value, platform) {
  const modifierDisplay = {
    Control: platform === 'darwin' ? '⌃' : 'Ctrl',
    Command: platform === 'darwin' ? '⌘' : 'Command',
    Super: platform === 'darwin' ? '⌘' : 'Win',
    Alt: platform === 'darwin' ? 'Option' : 'Alt',
    Shift: platform === 'darwin' ? '⇧' : 'Shift'
  }
  return value
    .split('+')
    .map((part) => modifierDisplay[part] || part)
    .join(' + ')
}
