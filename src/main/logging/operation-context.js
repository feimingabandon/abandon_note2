import { AsyncLocalStorage } from 'node:async_hooks'
import { diagnosticEventForChannel } from '../../shared/diagnostic-actions.js'
import { writeLog } from './logger.js'

const operations = new AsyncLocalStorage()
export const currentOperation = () => operations.getStore() || null
export const withOperation = (context, callback) => operations.run(context, callback)

export function takeInvocationContext(channel, args) {
  const candidate = args.at(-1)
  const eventName = diagnosticEventForChannel(channel)
  if (
    !eventName ||
    candidate?.__abandonDiagnostic !== 1 ||
    candidate.channel !== channel ||
    typeof candidate.actionId !== 'string' ||
    !/^[\w-]{1,128}$/.test(candidate.actionId)
  )
    return null
  args.pop()
  // eventName 由主进程的通道表决定；此上下文不是授权凭据。
  return { actionId: candidate.actionId, eventName, channel }
}

export function checkpoint(eventName, metadata = {}, options = {}) {
  try {
    const context = currentOperation()
    writeLog({
      process: 'main',
      scope: 'diagnostic.evidence',
      eventName,
      actionId: context?.actionId,
      phase: 'checkpoint',
      message: eventName,
      metadata,
      ...options
    })
  } catch {
    /* 日志不能改变业务结果。 */
  }
}

export function observeDiagnostic(read) {
  try {
    return read()
  } catch {
    checkpoint('diagnostic.unavailable', {}, { level: 'warn', outcome: 'unavailable' })
    return undefined
  }
}

export function diagnosticBroadcast(payload) {
  const context = currentOperation()
  return context ? { ...payload, diagnostic: { actionId: context.actionId } } : payload
}
