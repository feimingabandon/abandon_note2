const MAX_ARGUMENT_TEXT = 100_000
const MAX_CAPTURED_STRING = 20_000
const MAX_ARRAY_ITEMS = 24
const MAX_OBJECT_KEYS = 48
const MAX_DEPTH = 6
const BINARY_FIELD_PATTERN = /(?:base64|data[-_]?url|binary|byte(?:s|array)?|buffer)/i

function summarizeBinary(value, type) {
  return {
    omitted: true,
    type,
    length: Number(value?.byteLength ?? value?.length ?? 0)
  }
}

function consumeString(value, state) {
  const allowed = Math.max(0, Math.min(MAX_CAPTURED_STRING, state.remaining))
  const preview = value.slice(0, allowed)
  state.remaining -= preview.length
  if (preview.length === value.length) return value
  return {
    truncated: true,
    originalLength: value.length,
    preview
  }
}

function compactArgument(value, state, depth, key = '') {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') {
    if (BINARY_FIELD_PATTERN.test(key)) return summarizeBinary(value, 'string')
    return consumeString(value, state)
  }
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth >= MAX_DEPTH) return { truncated: true, reason: 'max-depth' }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return summarizeBinary(value, 'Buffer')
  }
  if (value instanceof ArrayBuffer) return summarizeBinary(value, 'ArrayBuffer')
  if (ArrayBuffer.isView(value))
    return summarizeBinary(value, value.constructor?.name || 'TypedArray')

  if (state.seen.has(value)) return { truncated: true, reason: 'circular-reference' }
  state.seen.add(value)

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => compactArgument(item, state, depth + 1, String(index)))
    if (value.length > items.length) {
      items.push({ truncated: true, omittedItems: value.length - items.length })
    }
    return items
  }

  const result = {}
  const entries = Object.entries(value)
  for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[entryKey] = compactArgument(entryValue, state, depth + 1, entryKey)
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
  }
  return result
}

export function captureIpcArguments(args) {
  try {
    const compacted = compactArgument(
      args,
      {
        remaining: MAX_ARGUMENT_TEXT - 10_000,
        seen: new WeakSet()
      },
      0
    )
    const serialized = JSON.stringify(compacted)
    if (serialized.length <= MAX_ARGUMENT_TEXT) return compacted
    return {
      truncated: true,
      originalLength: serialized.length,
      preview: serialized.slice(0, MAX_ARGUMENT_TEXT)
    }
  } catch (error) {
    return {
      serializationFailed: true,
      error: error?.message || String(error)
    }
  }
}
