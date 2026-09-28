const secretKey =
  /password|passwd|secret|token|cookie|authorization|credential|base64|binary|buffer/i
const contentKey =
  /^(content|remark|body|text|html|markdown|clipboard|expectedContent|expectedRemark)$/i

export function diagnosticText(value, limit = 2048) {
  return String(value ?? '')
    .slice(0, limit)
    .replace(/data:[^\s"']+/gi, '[data omitted]')
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(
      /((?:token|password|secret|authorization|cookie)\s*[:=]\s*)[^\s,;"']+/gi,
      '$1[redacted]'
    )
    .replace(/(?:https?|wss?|app):\/\/[^\s"'<>]+/gi, (url) =>
      url.split(/[?#]/, 1)[0].replace(/\/\/[^/@]+@/, '//[redacted]@')
    )
    .replace(/(?<![a-z\d])(?:[a-z]:[\\/]|\\\\)[^\s"'<>]*[\\/][^\s"'<>]*/gi, '[local-path]')
}

// 同时限制遍历成本与结果大小。读取 descriptor，不执行业务 getter。
export function sanitizeDiagnosticValue(value, options = {}) {
  const { maxBytes = 8192, maxDepth = 5, maxArray = 32, maxNodes = 256 } = options
  let remaining = Math.max(256, maxBytes)
  let nodes = 0
  const seen = new WeakSet()
  function read(input, key = '', depth = 0) {
    if (++nodes > maxNodes || remaining < 32) return '[budget omitted]'
    remaining -= 24
    if (secretKey.test(key)) return '[redacted]'
    if (input === null || input === undefined || typeof input === 'boolean') return input ?? null
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    if (typeof input === 'string') {
      if (contentKey.test(key)) return { omitted: true, length: input.length }
      const limit = Math.min(key === 'stack' ? 12000 : 2048, Math.floor(remaining / 6))
      const text = diagnosticText(input, Math.max(0, limit))
      remaining -= text.length * 6
      return text.length < input.length ? `${text}…` : text
    }
    if (typeof input === 'bigint') return String(input).slice(0, 64)
    if (typeof input !== 'object') return `[${typeof input}]`
    if (seen.has(input)) return '[Circular]'
    if (depth >= maxDepth) return '[max-depth]'
    seen.add(input)
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer)
      return { omitted: true, byteLength: input.byteLength }
    if (Array.isArray(input)) {
      const result = []
      const length = Math.min(input.length, maxArray)
      for (let i = 0; i < length && remaining >= 32 && nodes < maxNodes; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i))
        result.push(
          descriptor && 'value' in descriptor ? read(descriptor.value, '', depth + 1) : '[accessor]'
        )
      }
      if (result.length < input.length) result.push({ omittedItems: input.length - result.length })
      return result
    }
    const result = {}
    if (input instanceof Error) {
      for (const field of ['name', 'message', 'stack', 'code', 'cause']) {
        const descriptor = Object.getOwnPropertyDescriptor(input, field)
        if (descriptor && 'value' in descriptor)
          result[field] = read(descriptor.value, field, depth + 1)
      }
      if (!result.name) result.name = 'Error'
    }
    let count = 0
    for (const field in input) {
      if (!Object.prototype.hasOwnProperty.call(input, field) || field in result) continue
      if (++count > 32 || remaining < 32 || nodes >= maxNodes) {
        result.__truncated = true
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, field)
      const safeKey = field.slice(0, 96)
      if (['__proto__', 'prototype', 'constructor'].includes(safeKey)) continue
      result[safeKey] =
        descriptor && 'value' in descriptor
          ? read(descriptor.value, field, depth + 1)
          : '[accessor omitted]'
    }
    return result
  }
  try {
    return read(value)
  } catch {
    return { unavailable: true, reason: 'unreadable-value' }
  }
}

// 纯 JS，供 sandbox preload 与 Node 共用；输入必须已经过有界整理。
export function estimateDiagnosticBytes(value) {
  if (value == null) return 4
  if (typeof value === 'string') return value.length * 6 + 2
  if (typeof value !== 'object') return 24
  let bytes = 2
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key))
      bytes += key.length * 6 + 4 + estimateDiagnosticBytes(value[key])
  }
  return bytes
}
