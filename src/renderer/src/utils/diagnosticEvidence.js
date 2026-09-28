import { nextTick } from 'vue'
import { rendererDeepDiagnostics } from './diagnosticPolicy.js'
import {
  beginRendererWork,
  recordRendererWork,
  recordRefreshDataApplied
} from './performanceDiagnostics.js'

const performanceView = (view) => (['list', 'month', 'week'].includes(view) ? view : 'other')

export function reportEvidence(
  eventName,
  metadata = {},
  options = {},
  api = globalThis.window?.api
) {
  try {
    if (typeof metadata === 'function' && !rendererDeepDiagnostics(api)) return
    const result = api?.reportLog?.({
      level: 'info',
      scope: 'diagnostic.renderer',
      eventName,
      phase: 'checkpoint',
      message: eventName,
      metadata: typeof metadata === 'function' ? metadata() : metadata,
      ...options
    })
    result?.catch?.(() => {})
  } catch {
    /* 观察失败不能影响 UI。 */
  }
}

export function newDiagnosticId() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `view-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export function summarizeViewNotes(notes = []) {
  return {
    count: notes.length,
    truncated: notes.length > 32,
    notes: notes.slice(0, 32).map((note) => ({
      id: note.id,
      status: note.status,
      version: note.editVersion,
      updatedAt: note.updated_at,
      contentLength: String(note.content || '').length
    }))
  }
}

export function createRefreshCauses(view) {
  const ids = new Set()
  let omitted = 0
  let deferredReason = null
  let queued = 0
  return {
    add(payload) {
      recordRendererWork(`refresh.queued.${performanceView(view)}`, {
        coalesced: queued > 0 ? 1 : 0
      })
      queued++
      const id = payload?.diagnostic?.actionId
      if (id && !ids.has(id)) {
        if (ids.size < 32) ids.add(id)
        else omitted++
      }
      reportEvidence(
        'view.refresh-queued',
        { view, reason: payload?.reason, pendingCauses: ids.size },
        { actionId: id }
      )
    },
    defer(reason) {
      recordRendererWork(`refresh.deferred.${performanceView(view)}`)
      if (reason === deferredReason) return
      deferredReason = reason
      reportEvidence(
        'view.refresh-deferred',
        { view, reason, causeActionIds: [...ids], omittedCauses: omitted },
        { outcome: 'waiting' }
      )
    },
    take() {
      const result = { causeActionIds: [...ids], omittedCauses: omitted }
      ids.clear()
      omitted = 0
      deferredReason = null
      queued = 0
      return result
    }
  }
}

// 完成仅说明数据提交并经过 Vue nextTick，不是像素正确/无遮挡的证明。
export async function traceViewRefresh(view, metadata, work, readApplied, isCurrent = () => true) {
  const actionId = newDiagnosticId()
  const started = Date.now()
  const viewName = performanceView(view)
  const finishWork = beginRendererWork(`refresh.work.${viewName}`)
  reportEvidence(
    'view.refresh',
    { view, ...metadata },
    { actionId, phase: 'start', outcome: 'pending' }
  )
  const timer = setTimeout(
    () =>
      reportEvidence(
        'view.refresh',
        { view, ...metadata },
        {
          actionId,
          phase: 'pending',
          outcome: 'pending',
          level: 'warn',
          durationMs: Date.now() - started
        }
      ),
    5000
  )
  try {
    const result = await work()
    const outcome =
      result?.status === 'success'
        ? isCurrent()
          ? 'applied'
          : 'stale'
        : result?.status === 'cancelled'
          ? 'stale'
          : result?.status === 'error'
            ? 'failure'
            : 'skipped'
    finishWork({ [outcome]: 1 })
    reportEvidence(
      'view.refresh',
      { view, ...metadata },
      {
        actionId,
        phase: 'returned',
        outcome,
        durationMs: Date.now() - started,
        level: outcome === 'failure' ? 'warn' : 'info'
      }
    )
    if (outcome === 'applied' && rendererDeepDiagnostics()) {
      const finishUpdate = beginRendererWork(`refresh.vue-update.${viewName}`)
      try {
        await nextTick()
      } finally {
        finishUpdate()
      }
      if (!isCurrent()) {
        recordRendererWork(`refresh.superseded.${viewName}`)
        reportEvidence(
          'view.apply-superseded',
          { view, ...metadata },
          { actionId, outcome: 'stale' }
        )
        return result
      }
      try {
        const applied = readApplied()
        recordRendererWork(`refresh.applied.${viewName}`, { resultRows: applied?.count })
        recordRefreshDataApplied(viewName)
        reportEvidence(
          'view.data-applied',
          { view, ...metadata, ...applied },
          { actionId, outcome: 'data-applied' }
        )
      } catch {
        reportEvidence('view.evidence-unavailable', { view }, { actionId, outcome: 'unavailable' })
      }
    }
    return result
  } catch (error) {
    finishWork({ errors: 1 })
    reportEvidence(
      'view.refresh',
      { view, ...metadata },
      { actionId, phase: 'failure', outcome: 'failure', level: 'warn' }
    )
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function installInteractionEvidence(api, target = globalThis.document) {
  if (!target?.addEventListener) return () => {}
  const capture = (event) => {
    try {
      const control = event.target?.closest?.(
        rendererDeepDiagnostics(api)
          ? '[data-diagnostic-action],button,input,select,[role="button"],[role="switch"]'
          : '[data-diagnostic-action]'
      )
      if (!control) return
      // 不读取 textContent、value、placeholder、title 或键盘字符。
      const noteId =
        Number(control.closest?.('[data-note-id]')?.getAttribute('data-note-id')) || undefined
      reportEvidence(
        'ui.interaction',
        {
          event: event.type,
          action:
            control.getAttribute('data-diagnostic-action') ||
            control.closest?.('[data-diagnostic-action]')?.getAttribute('data-diagnostic-action') ||
            undefined,
          tag: control.tagName,
          controlClass: String(control.getAttribute('class') || '').slice(0, 180),
          inputType: control.tagName === 'INPUT' ? control.type : undefined,
          disabled: Boolean(control.disabled),
          checked: ['checkbox', 'radio'].includes(control.type)
            ? Boolean(control.checked)
            : undefined,
          ariaChecked: control.getAttribute('aria-checked') || undefined,
          noteId,
          trusted: event.isTrusted,
          page: globalThis.location?.pathname?.split('/').at(-1)
        },
        { actionId: newDiagnosticId(), phase: 'intent', outcome: 'observed' },
        api
      )
    } catch {
      /* DOM 销毁/诊断失败不拦截输入。 */
    }
  }
  const events = ['click', 'change', 'contextmenu', 'dblclick']
  events.forEach((name) => target.addEventListener(name, capture, true))
  return () => events.forEach((name) => target.removeEventListener(name, capture, true))
}
