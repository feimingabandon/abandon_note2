import { createDiagnosticIpcRenderer } from './diagnostic-ipc.js'
import { diagnosticActionInternals } from '../shared/diagnostic-actions.js'

// 构建时按 preload 入口内联共享模块；运行时不 require 共享 chunk。
export const createStickyDiagnosticIpcRenderer = (rawIpcRenderer, options) =>
  createDiagnosticIpcRenderer(rawIpcRenderer, options)

export const stickyDiagnosticIpcInternals = {
  STICKY_ACTIONS: Object.fromEntries(
    Object.entries(diagnosticActionInternals.ACTION_EVENT_BY_CHANNEL).filter(([key]) =>
      key.startsWith('sticky:')
    )
  ),
  summarizeValue: diagnosticActionInternals.summarizeValue
}
