const RETRY_CHANNEL = 'attachments:recovery-retry'

const unavailable = () =>
  Object.assign(new Error('当前无法重试附件恢复，请稍后再试'), {
    code: 'ATTACHMENT_RECOVERY_UNAVAILABLE'
  })

/** Main owns the source and both admissions; callers cannot select paths or recovery policy. */
export function createAttachmentRecoveryRetryController({
  businessAdmission,
  draftAssetsRuntime,
  getSource,
  isSourceCurrent,
  canStart,
  recover,
  getReport,
  onError = () => {}
}) {
  if (
    typeof businessAdmission?.exclusive !== 'function' ||
    typeof draftAssetsRuntime?.sealAndDrain !== 'function' ||
    typeof draftAssetsRuntime?.resume !== 'function' ||
    ![getSource, isSourceCurrent, canStart, recover, getReport, onError].every(
      (value) => typeof value === 'function'
    )
  )
    throw new TypeError('附件恢复重试需要主进程来源、准入及恢复端口')

  function reportError(error) {
    try {
      onError(error)
    } catch {
      // Diagnostics cannot replace the recovery or report-read outcome.
    }
  }

  function retry(...args) {
    if (args.length) throw new TypeError('附件恢复重试不接受参数')
    if (!canStart()) throw unavailable()
    const source = getSource()
    if (!source) throw unavailable()

    const owner = Symbol('attachment-recovery-retry')
    // Observe rejection immediately, even when the second gate refuses admission.
    // There is no await between sealing drafts and closing business admission.
    const draftsDrained = Promise.resolve(draftAssetsRuntime.sealAndDrain(owner)).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    )
    try {
      return businessAdmission.exclusive(async () => {
        try {
          const drafts = await draftsDrained
          if (!drafts.ok) throw drafts.error
          if (!canStart()) throw unavailable()
          if (!isSourceCurrent(source))
            throw Object.assign(new Error('附件恢复来源已变化，请重新读取报告后再试'), {
              code: 'ATTACHMENT_RECOVERY_SOURCE_CHANGED'
            })

          let outcome = 'finished'
          try {
            // Once filesystem recovery starts, its complete promise owns the gates.
            await recover()
          } catch (error) {
            outcome = 'failed'
            reportError(error)
          }
          try {
            // Capture this round while both gates are still held. A finished scan
            // can still contain conflicts, missing references or unknown decisions.
            return { outcome, report: structuredClone(getReport()) }
          } catch (error) {
            reportError(error)
            throw error
          }
        } finally {
          draftAssetsRuntime.resume(owner)
        }
      })
    } catch (error) {
      // exclusive rejects admission synchronously. Keep the draft owner until
      // its already-admitted IO settles, without losing a secondary rejection.
      return draftsDrained
        .then((drafts) => {
          if (!drafts.ok) reportError(drafts.error)
          throw error
        })
        .finally(() => draftAssetsRuntime.resume(owner))
    }
  }

  return Object.freeze({ retry })
}

/** Fixed transport: authorization runs in mainWindowIpc before the retry callback. */
export function registerAttachmentRecoveryRetryIpc({ mainWindowIpc, removeHandler, retry }) {
  if (
    typeof mainWindowIpc?.handle !== 'function' ||
    typeof removeHandler !== 'function' ||
    typeof retry !== 'function'
  )
    throw new TypeError('附件恢复重试需要授权的主窗口 IPC')
  let disposed = false
  mainWindowIpc.handle(RETRY_CHANNEL, (_event, ...args) => {
    if (disposed) throw unavailable()
    if (args.length) throw new TypeError('附件恢复重试不接受参数')
    return retry()
  })
  return () => {
    if (disposed) return
    disposed = true
    removeHandler(RETRY_CHANNEL)
  }
}
