const STICKY_ACTIONS = Object.freeze({
  'sticky:close': 'sticky.close',
  'sticky:toggle-pin': 'sticky.pin.toggle',
  'sticky:update-content': 'sticky.content.save',
  'sticky:update-appearance': 'sticky.appearance.update'
})

function createActionId() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `action-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function summarizeValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/(?:content|text|password|token|base64|binary)/i.test(key)) {
      return { omitted: true, reason: 'user-content-or-sensitive', length: value.length }
    }
    return value.length <= 240
      ? value
      : { truncated: true, length: value.length, preview: value.slice(0, 240) }
  }
  if (typeof value !== 'object') return String(value)
  if (depth >= 4) return { truncated: true, reason: 'max-depth' }
  if (seen.has(value)) return { truncated: true, reason: 'circular-reference' }
  seen.add(value)
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item, index) => summarizeValue(item, String(index), depth + 1, seen))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([entryKey, entryValue]) => [
        entryKey,
        summarizeValue(entryValue, entryKey, depth + 1, seen)
      ])
  )
}

function errorCode(error) {
  const explicit = String(error?.code || '').trim()
  if (explicit) return explicit.slice(0, 128)
  return String(error?.name || 'OPERATION_FAILED').slice(0, 128)
}

export function createStickyDiagnosticIpcRenderer(rawIpcRenderer) {
  const sendDiagnostic = (channel, payload) => {
    try {
      rawIpcRenderer.send(channel, payload)
    } catch {
      // 便利贴日志只能旁路观察，不能改变保存或关闭操作的结果。
    }
  }

  const report = (payload) =>
    sendDiagnostic('logs:write', {
      process: 'renderer',
      scope: `action.${payload.eventName}`,
      level: payload.phase === 'failure' ? 'error' : 'info',
      message:
        payload.phase === 'start'
          ? `业务请求开始：${payload.eventName}`
          : payload.phase === 'returned'
            ? `业务请求返回：${payload.eventName}`
            : `业务请求失败：${payload.eventName}`,
      ...payload
    })

  const invoke = async (channel, ...args) => {
    const eventName = STICKY_ACTIONS[channel]
    if (!eventName) return rawIpcRenderer.invoke(channel, ...args)
    const actionId = createActionId()
    const startedAt = Date.now()
    report({
      eventName,
      phase: 'start',
      actionId,
      outcome: 'pending',
      metadata: { channel, arguments: summarizeValue(args, 'arguments') }
    })
    try {
      const result = await rawIpcRenderer.invoke(channel, ...args, {
        __abandonDiagnostic: 1,
        channel,
        actionId
      })
      report({
        eventName,
        phase: 'returned',
        actionId,
        outcome: result?.canceled
          ? 'canceled'
          : result?.success === false
            ? 'rejected'
            : result?.changed === false
              ? 'no-change'
              : 'returned',
        durationMs: Date.now() - startedAt,
        metadata: {
          channel,
          resultType: result === null ? 'null' : typeof result,
          resultValue:
            typeof result === 'boolean' || typeof result === 'number' ? result : undefined
        }
      })
      return result
    } catch (error) {
      report({
        eventName,
        phase: 'failure',
        actionId,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        errorCode: errorCode(error),
        error: {
          name: String(error?.name || 'Error'),
          message: String(error?.message || error || '操作失败'),
          stack: typeof error?.stack === 'string' ? error.stack : undefined
        },
        metadata: { channel }
      })
      throw error
    }
  }

  return {
    invoke,
    send: (...args) => rawIpcRenderer.send(...args),
    on: (...args) => rawIpcRenderer.on(...args),
    removeListener: (...args) => rawIpcRenderer.removeListener(...args)
  }
}

export const stickyDiagnosticIpcInternals = { STICKY_ACTIONS, summarizeValue }
