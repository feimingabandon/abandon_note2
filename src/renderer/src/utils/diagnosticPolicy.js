import { dailyDiagnosticPolicy, isDeepDiagnostics } from '../../../shared/diagnostic-policy.js'

const policies = new WeakMap()
export function rendererDiagnosticPolicy(api = globalThis.window?.api) {
  if (!api || typeof api !== 'object') return dailyDiagnosticPolicy()
  if (!policies.has(api)) {
    let initial
    try {
      initial = api.getDiagnosticPolicy?.()
    } catch {
      /* 日常默认。 */
    }
    policies.set(api, initial || dailyDiagnosticPolicy())
    api.onDiagnosticPolicy?.((policy) => {
      policies.set(api, policy)
    })
  }
  return policies.get(api)
}
export const rendererDeepDiagnostics = (api) => isDeepDiagnostics(rendererDiagnosticPolicy(api))
