const ACTION_EVENT_BY_CHANNEL = Object.freeze({
  'view:switch': 'view.switch',
  'toggle-lock': 'window.lock.toggle',
  'set-window-z-order-mode': 'window.z-order.set',
  'presentation-mode:enter-compact': 'window.presentation.compact',
  'presentation-mode:exit-compact': 'window.presentation.expand',
  'set-setting-value': 'settings.value.set',
  'shortcut:view-visibility-set': 'settings.shortcut.set',
  'set-dock-config': 'settings.dock.set',
  'reset-settings': 'settings.reset',
  'remote-notices:acknowledge': 'notice.acknowledge',
  'remote-notices:open-link': 'notice.link.open',
  'update:check': 'update.check',
  'update:open-link': 'update.link.open',
  'clear-note-data': 'data.clear',
  'set-auto-start': 'settings.auto-start.set',
  'set-blur-config': 'settings.blur.set',
  'wallpapers:save': 'wallpaper.save',
  'wallpapers:activate': 'wallpaper.activate',
  'wallpapers:disable': 'wallpaper.disable',
  'wallpapers:delete': 'wallpaper.delete',
  'notes:create': 'note.create',
  'notes:create-with-assets': 'note.create',
  'notes:restore': 'note.restore',
  'notes:update': 'note.update',
  'notes:set-text-color': 'note.text-color.set',
  'notes:save-draft': 'note.save',
  'notes:delete': 'note.delete',
  'notes:purge': 'note.purge',
  'notes:reorder-custom': 'note.order.normalize',
  'notes:update-custom-order': 'note.order.update',
  'notes:start-progress': 'note.start',
  'notes:complete': 'note.complete',
  'notes:reopen': 'note.reopen',
  'sticky:create': 'sticky.create',
  'sticky:close': 'sticky.close',
  'sticky:toggle-pin': 'sticky.pin.toggle',
  'sticky:update-content': 'sticky.content.save',
  'sticky:update-appearance': 'sticky.appearance.update',
  'daily-report:export': 'report.export',
  'daily-report:open-export-folder': 'report.folder.open',
  'calendar:holiday-data-import': 'calendar.holiday.import',
  'calendar:holiday-data-download': 'calendar.holiday.download',
  'calendar:holiday-data-open-link': 'calendar.holiday.link.open',
  'calendar:holiday-data-dismiss-notice': 'calendar.holiday.notice.dismiss',
  'weather:resolve-location': 'weather.location.resolve',
  'weather:refresh-forecast': 'weather.refresh',
  'weather:open-source': 'weather.source.open',
  'tags:create': 'tag.create',
  'tags:update': 'tag.update',
  'tags:delete': 'tag.delete',
  'tags:update-order': 'tag.order.update',
  'note-tags:bind': 'note.tag.bind',
  'note-tags:unbind': 'note.tag.unbind',
  'note-tags:set': 'note.tags.set',
  'templates:create': 'template.create',
  'templates:update': 'template.update',
  'templates:delete': 'template.delete',
  'templates:pause': 'template.pause',
  'templates:resume': 'template.resume',
  'templates:restore': 'template.restore',
  'templates:purge': 'template.purge',
  'images:save-batch': 'attachment.save',
  'images:delete': 'attachment.delete',
  'screenshot:capture': 'screenshot.capture',
  'scheduler:retry': 'scheduler.retry'
})

const OMITTED_VALUE_PATTERN =
  /(?:password|passwd|secret|token|cookie|authorization|credential|base64|data[-_]?url|binary|buffer)/i
const CONTENT_VALUE_PATTERN = /(?:content|remark|body|text|html|markdown)/i
const MAX_STRING_PREVIEW = 240
const MAX_ARRAY_ITEMS = 12
const MAX_OBJECT_KEYS = 32
const MAX_DEPTH = 4

export function diagnosticEventForChannel(channel) {
  return ACTION_EVENT_BY_CHANNEL[String(channel || '')] || null
}

function summarizeString(value, key) {
  if (OMITTED_VALUE_PATTERN.test(key)) {
    return { omitted: true, reason: 'sensitive-or-binary', length: value.length }
  }
  if (CONTENT_VALUE_PATTERN.test(key)) {
    return { omitted: true, reason: 'user-content', length: value.length }
  }
  return value.length <= MAX_STRING_PREVIEW
    ? value
    : { truncated: true, length: value.length, preview: value.slice(0, MAX_STRING_PREVIEW) }
}

function summarizeValue(value, key, depth, seen) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return summarizeString(value, key)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth >= MAX_DEPTH) return { truncated: true, reason: 'max-depth' }
  if (seen.has(value)) return { truncated: true, reason: 'circular-reference' }
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => summarizeValue(item, String(index), depth + 1, seen))
    return value.length > items.length
      ? { count: value.length, items, omittedItems: value.length - items.length }
      : items
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return {
      omitted: true,
      reason: 'binary',
      length: Number(value.byteLength ?? value.length ?? 0)
    }
  }

  const result = {}
  const entries = Object.entries(value)
  for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[entryKey] = summarizeValue(entryValue, entryKey, depth + 1, seen)
  }
  if (entries.length > MAX_OBJECT_KEYS) result.__omittedKeys = entries.length - MAX_OBJECT_KEYS
  return result
}

export function summarizeDiagnosticArguments(args = []) {
  try {
    return summarizeValue(args, 'arguments', 0, new WeakSet())
  } catch (error) {
    return { unavailable: true, reason: error?.message || String(error) }
  }
}

export function diagnosticErrorCode(error) {
  const explicit = String(error?.code || '').trim()
  if (explicit) return explicit.slice(0, 128)
  const message = String(error?.message || error || '')
  if (/could not be cloned|couldn't be cloned|DataCloneError/i.test(message)) {
    return 'IPC_CLONE_FAILED'
  }
  const name = String(error?.name || '').trim()
  return (name && name !== 'Error' ? name : 'OPERATION_FAILED').slice(0, 128)
}

// 返回只代表 IPC 完成；false 可能是“已解锁”，不能统一当作失败。
export function diagnosticOutcome(result) {
  if (result?.canceled === true || result?.cancelled === true) return 'canceled'
  if (result?.success === false || result?.ok === false) return 'rejected'
  if (result?.changed === false) return 'no-change'
  return 'returned'
}

export function summarizeDiagnosticResult(result) {
  if (result == null) return { resultType: result === null ? 'null' : 'undefined' }
  if (typeof result !== 'object') {
    return {
      resultType: typeof result,
      ...(['boolean', 'number'].includes(typeof result) ? { resultValue: result } : {})
    }
  }
  return {
    resultType: Array.isArray(result) ? 'array' : 'object',
    resultCount: Array.isArray(result) ? result.length : undefined,
    resultId: Number.isInteger(Number(result.id)) ? Number(result.id) : undefined,
    resultStatus: typeof result.status === 'string' ? result.status.slice(0, 128) : undefined,
    changed: typeof result.changed === 'boolean' ? result.changed : undefined,
    canceled: typeof result.canceled === 'boolean' ? result.canceled : undefined,
    success: typeof result.success === 'boolean' ? result.success : undefined
  }
}

export const diagnosticActionInternals = { ACTION_EVENT_BY_CHANNEL, summarizeValue }
