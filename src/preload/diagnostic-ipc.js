import {
  diagnosticErrorCode,
  diagnosticEventForChannel,
  summarizeDiagnosticArguments,
  summarizeDiagnosticResult,
  diagnosticOutcome
} from '../shared/diagnostic-actions.js'
import { createDiagnosticTransport } from './diagnostic-transport.js'

function createDiagnosticActionId() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `action-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function serializeDiagnosticError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 128),
    message: String(error?.message || error || '操作失败').slice(0, 20_000),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 100_000) : undefined,
    code: error?.code === undefined ? undefined : String(error.code).slice(0, 128)
  }
}

export function createDiagnosticIpcRenderer(rawIpcRenderer, { transport } = {}) {
  const diagnostics = transport || createDiagnosticTransport(rawIpcRenderer)
  const sendDiagnostic = (channel, payload) => {
    try {
      return diagnostics.report(payload)
    } catch {
      // 诊断链路只能旁路观察，不能因窗口销毁或日志 IPC 异常改变业务调用结果。
      return false
    }
  }

  const reportAction = (payload) => {
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
  }

  const invoke = async (channel, ...args) => {
    if (['logs:query', 'logs:export'].includes(channel)) await diagnostics.flush(800)
    const eventName = diagnosticEventForChannel(channel)
    if (!eventName) return rawIpcRenderer.invoke(channel, ...args)

    const actionId = createDiagnosticActionId()
    const startedAt = Date.now()
    reportAction({
      eventName,
      phase: 'start',
      actionId,
      outcome: 'pending',
      metadata: {
        channel,
        ...(diagnostics.getPolicy().mode === 'deep'
          ? { arguments: summarizeDiagnosticArguments(args) }
          : {})
      }
    })
    try {
      if (['sticky:close', 'view:switch'].includes(channel)) {
        try {
          await diagnostics.prepareForUnload?.(channel)
        } catch {
          // 限时提交失败仍继续用户的关闭/导航操作；主进程保留缺失状态。
        }
      }
      // 与业务参数一起克隆和传输，失败的调用不会给后一个调用留下 FIFO 上下文。
      const result = await rawIpcRenderer.invoke(channel, ...args, {
        __abandonDiagnostic: 1,
        channel,
        actionId,
        policyEpoch: diagnostics.getPolicy().policyEpoch
      })
      reportAction({
        eventName,
        phase: 'returned',
        actionId,
        outcome: diagnosticOutcome(result),
        durationMs: Date.now() - startedAt,
        metadata: { channel, ...summarizeDiagnosticResult(result) }
      })
      return result
    } catch (error) {
      reportAction({
        eventName,
        phase: 'failure',
        actionId,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        errorCode: diagnosticErrorCode(error),
        error: serializeDiagnosticError(error),
        metadata: { channel }
      })
      throw error
    }
  }

  const listenerWrappers = new Map()
  let listenerSequence = 0
  return {
    diagnostics,
    invoke,
    send: (channel, ...args) =>
      channel === 'logs:write'
        ? diagnostics.report(args[0])
        : rawIpcRenderer.send(channel, ...args),
    on: (channel, listener) => {
      if (!['settings:changed', 'notes:changed'].includes(channel)) {
        return rawIpcRenderer.on(channel, listener)
      }
      const listenerId = ++listenerSequence
      const wrapped = (event, payload, ...rest) => {
        sendDiagnostic('logs:write', {
          level: 'info',
          scope: 'diagnostic.broadcast',
          eventName: 'broadcast.received',
          phase: 'received',
          actionId: payload?.diagnostic?.actionId,
          message: `收到变更通知：${channel}`,
          metadata: { channel, listenerId, revision: payload?.revision, id: payload?.id }
        })
        return listener(event, payload, ...rest)
      }
      let channelMap = listenerWrappers.get(channel)
      if (!channelMap) listenerWrappers.set(channel, (channelMap = new Map()))
      channelMap.set(listener, wrapped)
      return rawIpcRenderer.on(channel, wrapped)
    },
    removeListener: (channel, listener) => {
      const channelMap = listenerWrappers.get(channel)
      const wrapped = channelMap?.get(listener) || listener
      channelMap?.delete(listener)
      if (channelMap?.size === 0) listenerWrappers.delete(channel)
      return rawIpcRenderer.removeListener(channel, wrapped)
    }
  }
}

export const diagnosticIpcInternals = {
  createDiagnosticActionId,
  serializeDiagnosticError,
  summarizeDiagnosticResult
}
