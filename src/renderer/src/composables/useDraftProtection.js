import { nextTick, onBeforeUnmount, onMounted, readonly, ref, watch } from 'vue'
import { useMessage } from './useMessage.js'
import {
  cloneDraftMetadata,
  draftError,
  EDITING_DRAFT_PREFIX,
  EDITING_DRAFT_VERSION,
  isDraftOwner,
  parseDraftJournal,
  removePreviousDraftSessions,
  sameDraftMetadata
} from '../utils/draftAssets.js'
import {
  convertLegacyDraft,
  findLegacyCaptureConflict,
  hashLegacyDraft,
  legacyDraftKey,
  legacyMigrationReceipt,
  parseLegacyDraft
} from '../utils/legacyDraftAssets.js'

const sessionId =
  String(window.api?.runtimeCapabilities?.editingDraftSessionId || '').trim() || crypto.randomUUID()
const PREFIX = `${EDITING_DRAFT_PREFIX}v3:${sessionId}:`
const active = new Set()
const latest = new Map()
const finalFlushes = new Map()
export const editingDataGeneration = ref(0)
removePreviousDraftSessions(localStorage, sessionId)

export function getLegacyCaptureConflict() {
  try {
    return findLegacyCaptureConflict(localStorage, sessionId)
  } catch (error) {
    // Inaccessible storage cannot establish a safe legacy handoff.
    console.error('[editing-draft] 旧截图来源读取失败', error)
    return '旧截图草稿来源暂时无法读取，原始记录已保留，暂不能加载。'
  }
}

window.__clearEditingDrafts = async () => {
  const entries = [...active]
  for (const entry of entries) entry.discard()
  editingDataGeneration.value++
  // main has committed SQL and sealed admission; its cleanup ledger owns all assets.
  await Promise.all(entries.map((entry) => entry.clear(true)))
  for (const key of Object.keys(localStorage)) {
    const legacyPrefix = `${EDITING_DRAFT_PREFIX}v2:${sessionId}:`
    if (key.startsWith(legacyPrefix)) {
      const raw = localStorage.getItem(key)
      try {
        parseLegacyDraft(raw, key.slice(legacyPrefix.length))
      } catch {
        // Only proven current-launch v2 producers belong to the committed clear.
        continue
      }
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
      continue
    }
    if (!key.startsWith(PREFIX)) continue
    try {
      parseDraftJournal(localStorage.getItem(key), sessionId, key.slice(PREFIX.length))
    } catch {
      // Unknown formats remain available for explicit recovery.
      continue
    }
    localStorage.removeItem(key)
  }
  await nextTick()
  return true
}

window.__prepareEditingDrafts = async () => {
  const entries = await Promise.all([...active].map((entry) => entry.flush()))
  return {
    dirty: entries.some((entry) => entry.dirty),
    blocked: entries.some((entry) => entry.blocked)
  }
}

/** One form owns its metadata journal and launch-scoped asset owner. */
export function useDraftProtection({
  key,
  fields,
  dirty,
  busy = () => false,
  extra = () => ({}),
  restoreExtra = () => {},
  onCommitted = () => {},
  resumeAfterCommit = false
}) {
  const { showMessage } = useMessage()
  const storageKey = PREFIX + key
  const assetOwners = new Map()
  const imageGeneration = ref(0)
  const commitLocked = ref(false)
  const dataGeneration = editingDataGeneration.value
  const predecessor = finalFlushes.get(storageKey)
  let ready = false,
    discarded = false,
    disposed = false,
    warned = false,
    epoch = 0,
    finalizing = false
  let owner = null,
    ownerTask = null,
    saved = null,
    handoff = null,
    handoffFailed = false
  let committing = null,
    clearTask = null,
    initializeTask = null,
    loaded = false
  let recoveryError = null,
    preserveRaw = false
  let legacy = null,
    migration = null,
    migrationRaw = null
  const instance = {}
  latest.set(storageKey, instance)
  const current = (generation = epoch) =>
    !discarded &&
    generation === epoch &&
    dataGeneration === editingDataGeneration.value &&
    latest.get(storageKey) === instance
  const writable = (generation = epoch) =>
    current(generation) ||
    (finalizing &&
      !discarded &&
      generation === epoch &&
      dataGeneration === editingDataGeneration.value)
  const api = () => {
    if (!window.api?.draftAssets) throw draftError('草稿接口尚未就绪', 'DRAFT_API_UNAVAILABLE')
    return window.api.draftAssets
  }
  const snapshot = () => ({
    ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value.value])),
    ...extra()
  })
  const fieldSnapshot = () =>
    cloneDraftMetadata(
      Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value.value]))
    )
  function warn(error, message = '草稿暂存失败，请先保存便签再切换视图或退出。') {
    console.error('[editing-draft]', error)
    if (!warned) showMessage('error', message)
    warned = true
  }
  function loadJournal() {
    if (loaded) return
    loaded = true
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw !== null) {
        saved = parseDraftJournal(raw, sessionId, key)
        migration = saved.migration || null
        migrationRaw = migration ? raw : null
        handoff = saved.handoff || null
        commitLocked.value = Boolean(handoff)
      }
      const sourceKey = legacyDraftKey(sessionId, key)
      const sourceRaw = localStorage.getItem(sourceKey)
      if (sourceRaw !== null) {
        if (saved && !migration) throw draftError('新旧草稿并存，原始记录仍保留，暂不能自动覆盖')
        legacy = { sourceKey, raw: sourceRaw, data: parseLegacyDraft(sourceRaw, key) }
      } else if (migration?.phase === 'staging') {
        throw draftError('旧草稿迁移尚未完成且来源无法确认，原始凭据仍保留')
      }
      if (['new:capture', 'capture:pending-delivery'].includes(key)) {
        const conflict = getLegacyCaptureConflict()
        if (conflict) throw draftError(conflict, 'DRAFT_LEGACY_CAPTURE_CONFLICT')
      }
    } catch (error) {
      preserveRaw = true
      recoveryError = error
      throw error
    }
  }
  function rememberAssets(value, original) {
    if (!value || typeof value !== 'object') return
    if (typeof value.assetId === 'string') assetOwners.set(value.assetId, original)
    for (const child of Object.values(value)) rememberAssets(child, original)
  }
  async function ensureOwner() {
    if (!current()) throw draftError('草稿已关闭', 'DRAFT_DOCUMENT_EXPIRED')
    if (owner) return owner
    if (!ownerTask) {
      const generation = epoch
      ownerTask = (async () => {
        if (predecessor) await predecessor
        loadJournal()
        if (preserveRaw) throw recoveryError
        if (legacy && !migration)
          throw draftError('旧草稿正在恢复，请稍后重试', 'DRAFT_RECOVERY_PENDING')
        const opened = await api().openOwner(key, saved?.owner || null)
        if (!isDraftOwner(opened, sessionId, key)) throw draftError('草稿归属响应无效')
        // clear awaits this opening and owns cancellation, including its receipt.
        if (!writable(generation)) return opened
        owner = {
          sessionId: opened.sessionId,
          key: opened.key,
          ownerId: opened.ownerId,
          generation: opened.generation
        }
        if (saved) rememberAssets(saved.data, owner)
        // Even an empty owner needs a durable public binding for a replacement document.
        if (!saved) {
          try {
            if (legacy) assertLegacyCurrent(generation)
            write(legacy ? {} : snapshot())
          } catch (error) {
            owner = null
            await api()
              .discardOwner(opened)
              .catch((cleanup) => console.error('[editing-draft] 归属暂存失败后的清理', cleanup))
            throw error
          }
        }
        return opened
      })()
      void ownerTask.catch(() => {
        ownerTask = null
      })
    }
    return ownerTask
  }
  function write(data = snapshot()) {
    if (!owner) throw draftError('草稿归属尚未就绪')
    const raw = JSON.stringify({
      version: EDITING_DRAFT_VERSION,
      sessionId,
      key,
      owner,
      updatedAt: Date.now(),
      data: cloneDraftMetadata(data),
      handoff,
      ...(migration ? { migration } : {})
    })
    localStorage.setItem(storageKey, raw)
    if (migration) migrationRaw = raw
    return raw
  }
  function assertLegacyCurrent(generation) {
    if (disposed || !current(generation))
      throw draftError('旧草稿恢复已取消', 'DRAFT_DOCUMENT_EXPIRED')
    if (localStorage.getItem(legacy.sourceKey) !== legacy.raw)
      throw draftError('旧草稿来源已变化，两份记录仍保留，暂不能自动覆盖')
    if (localStorage.getItem(storageKey) !== migrationRaw)
      throw draftError('迁移凭据已变化，原始记录仍保留，暂不能自动覆盖')
    if (legacy.fields && !sameDraftMetadata(fieldSnapshot(), legacy.fields))
      throw draftError('恢复期间检测到新的编辑，新输入和旧草稿均已保留，请核对后处理')
  }
  async function prepareLegacy(generation) {
    legacy.fields = fieldSnapshot()
    const hash = await hashLegacyDraft(legacy.raw)
    assertLegacyCurrent(generation)
    if (migration && migration.sourceHash !== hash)
      throw draftError('迁移凭据与旧草稿不匹配，两份记录仍保留')
    if (!migration) migration = legacyMigrationReceipt(sessionId, key, hash, legacy.data)
    legacy.hash = hash
  }
  function removeMigrationReceipt() {
    if (localStorage.getItem(storageKey) !== migrationRaw)
      throw draftError('迁移凭据已变化，恢复未确认，原始记录仍保留')
    localStorage.removeItem(storageKey)
    if (localStorage.getItem(storageKey) !== null)
      throw draftError('迁移凭据未能删除，恢复未确认，原始记录仍保留')
    migrationRaw = null
    saved = null
    migration = null
  }
  async function revokeMigrationCandidate(original) {
    const receipt = await api().discardOwner(original)
    if (receipt?.cancelled !== true)
      throw draftError('旧草稿候选归属撤销未确认，原始记录与凭据仍保留')
    owner = null
    ownerTask = null
    assetOwners.clear()
    if (receipt.cleanupErrors?.length)
      showMessage('warning', '旧草稿候选已撤销，部分临时图片待清理。')
    // Only a confirmed revocation and exact receipt removal permit a fresh owner.
    removeMigrationReceipt()
  }
  async function migrateLegacy(generation) {
    let candidate = null
    try {
      candidate = await ensureOwner()
      assertLegacyCurrent(generation)
      const data = await convertLegacyDraft(legacy.data, async (image) => {
        assertLegacyCurrent(generation)
        const asset = await api().stage(candidate, image)
        assertLegacyCurrent(generation)
        const metadata = cloneDraftMetadata(asset)
        assetOwners.set(metadata.assetId, candidate)
        return metadata
      })
      assertLegacyCurrent(generation)
      for (const [name, value] of Object.entries(fields)) {
        if (Object.hasOwn(data, name)) value.value = data[name]
      }
      // Consumers can synchronously apply compatibility defaults, including
      // MonthCreator's missing immediateIntent=false. Guard subsequent edits
      // throughout the consumer's asynchronous restoration.
      const restoration = restoreExtra(data)
      legacy.fields = fieldSnapshot()
      if ((await restoration) === false) throw draftError('旧草稿附件尚未恢复，原始记录仍保留')
      assertLegacyCurrent(generation)
      const completed = { ...migration, phase: 'complete' }
      const pending = migration
      migration = completed
      try {
        write(data)
      } catch (error) {
        migration = pending
        throw error
      }
      saved = parseDraftJournal(migrationRaw, sessionId, key)
      assertLegacyCurrent(generation)
      removeLegacySource()
      showMessage('info', '已恢复本次启动期间未保存的草稿，请核对后保存。')
    } catch (error) {
      if (
        candidate &&
        migration?.phase === 'staging' &&
        dataGeneration === editingDataGeneration.value
      ) {
        try {
          await revokeMigrationCandidate(candidate)
        } catch (cleanup) {
          console.error('[editing-draft] 旧草稿恢复未确认，原始记录与凭据仍保留', cleanup)
          throw draftError('旧草稿恢复未确认，原始记录与归属凭据仍保留，请核对后处理')
        }
      }
      throw error
    }
  }
  function removeLegacySource() {
    if (!legacy) return
    if (localStorage.getItem(legacy.sourceKey) !== legacy.raw)
      throw draftError('旧草稿来源已变化，两份记录仍保留，暂不能自动覆盖')
    try {
      localStorage.removeItem(legacy.sourceKey)
      if (localStorage.getItem(legacy.sourceKey) !== null) throw draftError('旧草稿删除未完成')
      legacy = null
    } catch (error) {
      console.error('[editing-draft] 已完成迁移的旧原文未能删除', error)
      showMessage('warning', '草稿已恢复，旧原文未能删除，迁移凭据已保留。')
    }
  }
  async function flush() {
    const changed = dirty() || Boolean(handoff)
    const generation = epoch
    if (!writable()) return { dirty: false, blocked: busy(), persisted: false }
    if (!ready || recoveryError) return { dirty: changed, blocked: true, persisted: false }
    try {
      if (changed && !owner) await ensureOwner()
      if (!writable(generation)) return { dirty: false, blocked: true, persisted: false }
      if (changed || owner) write()
      return {
        dirty: changed,
        blocked: busy() || Boolean(committing) || commitLocked.value,
        persisted: true
      }
    } catch (error) {
      warn(error)
      return { dirty: changed, blocked: true, persisted: false }
    }
  }
  function invalidateImages(finalFlush = false) {
    // Unmount must preserve the accepted final journal/migration epoch. Its
    // disposed check still rejects reads; only display consumers need a signal.
    if (!finalFlush) epoch++
    imageGeneration.value++
  }
  function discard() {
    discarded = true
    ready = false
    invalidateImages()
  }
  function clear(alreadyRevoked = false) {
    if (!alreadyRevoked && (disposed || latest.get(storageKey) !== instance))
      return Promise.resolve(false)
    // An explicit clear before mounted restoration still must preserve unknown raw formats.
    if (!predecessor) {
      try {
        loadJournal()
      } catch {
        /* preserveRaw is recorded by loadJournal. */
      }
    }
    discard()
    if (clearTask) return clearTask
    const previousOwner = owner
    const opening = ownerTask
    clearTask = (async () => {
      // A replacement can be discarded before the previous form's first owner
      // response arrives. Remove its final journal after that flush has settled.
      if (predecessor) {
        await predecessor
        loaded = false
        try {
          loadJournal()
        } catch {
          /* Unknown formats remain preserved. */
        }
      }
      if (!alreadyRevoked) {
        const target =
          previousOwner ||
          (opening ? await opening : saved?.owner ? await api().openOwner(key, saved.owner) : null)
        if (target) {
          const receipt = await api().discardOwner(target)
          if (receipt?.cancelled !== true) throw draftError('草稿取消结果尚未确认')
          if (receipt.cleanupErrors?.length)
            showMessage('warning', '草稿已取消，部分临时图片待清理。')
        }
      }
      owner = null
      ownerTask = null
      assetOwners.clear()
      handoff = null
      saved = null
      // A completed receipt remains the only proof against restaging if removing
      // its duplicate v2 source failed. Never delete that proof on cancellation.
      if (legacy && migration?.phase === 'complete') {
        removeLegacySource()
        if (legacy) {
          preserveRaw = true
          recoveryError = draftError('旧草稿删除未确认，完成凭据仍保留，请核对后处理')
        }
      }
      if (!preserveRaw) {
        try {
          localStorage.removeItem(storageKey)
          migration = null
          migrationRaw = null
        } catch (error) {
          console.error('[editing-draft] 清除草稿日志失败', error)
          if (alreadyRevoked) throw error
          showMessage('warning', '操作已完成，但旧草稿日志未能清除，请重新打开时核对。')
        }
      }
      return true
    })()
    return clearTask
  }
  async function resume() {
    const generation = epoch
    if (clearTask) await clearTask
    if (disposed || generation !== epoch || latest.get(storageKey) !== instance) return false
    if (!discarded) return ready && !recoveryError
    if (preserveRaw) throw recoveryError
    clearTask = null
    discarded = false
    loaded = true
    recoveryError = null
    saved = null
    if (dirty()) await ensureOwner()
    if (disposed || !current(generation)) return false
    ready = true
    commitLocked.value = false
    return true
  }
  async function finishCommitted(receipt, recovered) {
    const result = receipt.result
    // A remounted form owns recovery now; never revoke its rebound owner or journal.
    if (latest.get(storageKey) !== instance) return result
    const data = recovered || recoveryError ? saved?.data : snapshot()
    if (!sameDraftMetadata(data, handoff.submittedData)) {
      // A non-UI writer bypassed the lock. Keep both the accepted request and the
      // later draft; clearing this owner would destroy its newly added assets.
      commitLocked.value = true
      try {
        write(data)
      } catch (error) {
        warn(error)
      }
      showMessage('warning', '原便签已保存，但检测到后续草稿变化，内容已保留，请核对后处理。')
      return result
    }
    // SQL has committed. Neither cleanup nor UI failure can become a save rejection.
    try {
      await clear()
    } catch (error) {
      console.error('[editing-draft] 提交后清理失败', error)
      showMessage('warning', '便签已保存，但草稿清理未完成，请勿重复保存。')
    }
    if (receipt.cleanupErrors?.length) showMessage('warning', '便签已保存，部分临时图片待清理。')
    if (!disposed && latest.get(storageKey) === instance) {
      try {
        await onCommitted(result, { recovered })
      } catch (error) {
        console.error('[editing-draft] 保存后的界面更新失败', error)
        showMessage('warning', '便签已保存，界面更新未完成，请重新打开核对。')
      }
      if (resumeAfterCommit) {
        try {
          await resume()
        } catch (error) {
          warn(error)
        }
      }
    }
    return result
  }
  async function settled(receipt) {
    if (!receipt || receipt.requestId !== handoff?.requestId)
      throw draftError('草稿提交响应无法确认，请保留草稿')
    if (receipt.status === 'pending') receipt = await api().waitNote(owner, handoff.requestId)
    if (
      !receipt ||
      receipt.requestId !== handoff?.requestId ||
      !['committed', 'failed', 'rejected', 'unknown'].includes(receipt.status)
    )
      throw draftError('草稿提交状态无法确认，请保留草稿')
    return receipt
  }
  function commitNote(kind, payload) {
    if (committing) return committing
    commitLocked.value = true
    committing = (async () => {
      if (initializeTask) await initializeTask
      if (preserveRaw || (recoveryError && !handoff)) throw recoveryError
      await ensureOwner()
      if (disposed || !current()) throw draftError('草稿已关闭', 'DRAFT_DOCUMENT_EXPIRED')
      if (!['create', 'save'].includes(kind)) throw draftError('草稿提交类型无效')
      let receipt
      if (handoff && !handoffFailed) {
        receipt = await settled(await api().noteState(owner, handoff.requestId))
        if (receipt.status === 'committed') return finishCommitted(receipt, false)
        if (['failed', 'rejected'].includes(receipt.status)) {
          handoffFailed = true
          commitLocked.value = false
          throw draftError(
            receipt.error?.message || '便签保存失败，草稿已保留',
            receipt.error?.code
          )
        }
      }
      if (!handoff || handoffFailed) {
        handoff = {
          requestId: crypto.randomUUID(),
          kind,
          payload: cloneDraftMetadata(payload),
          submittedData: cloneDraftMetadata(snapshot())
        }
        handoffFailed = false
        commitLocked.value = true
      }
      // A lost IPC response retains this identity. It never starts a fresh SQL attempt.
      write(recoveryError && saved ? saved.data : snapshot())
      receipt = await settled(
        await api().submitNote(owner, handoff.requestId, handoff.kind, handoff.payload)
      )
      if (receipt.status === 'committed') return finishCommitted(receipt, false)
      if (['failed', 'rejected'].includes(receipt.status)) {
        handoffFailed = true
        commitLocked.value = false
        throw draftError(receipt.error?.message || '便签保存失败，草稿已保留', receipt.error?.code)
      }
      throw draftError('保存结果尚未确认，请再次点击保存查询原请求')
    })()
      .catch((error) => {
        if (!handoff || handoffFailed) commitLocked.value = false
        throw error
      })
      .finally(() => {
        committing = null
      })
    return committing
  }
  const stopWatching = watch(
    () => [snapshot(), dirty()],
    () => {
      if (ready && current()) void flush()
    },
    { deep: true, flush: 'post' }
  )
  const entry = { discard, clear, flush }
  active.add(entry)
  onMounted(() => {
    initializeTask = (async () => {
      await nextTick()
      if (disposed || !current()) return
      const generation = epoch
      try {
        if (predecessor) await predecessor
        loadJournal()
        if (legacy) {
          await prepareLegacy(generation)
          if (saved?.migration?.phase === 'staging') {
            const interrupted = await ensureOwner()
            assertLegacyCurrent(generation)
            await revokeMigrationCandidate(interrupted)
            assertLegacyCurrent(generation)
            migration = legacyMigrationReceipt(sessionId, key, legacy.hash, legacy.data)
          }
          if (!saved) {
            await migrateLegacy(generation)
            if (disposed || !current(generation)) return
            ready = true
            return
          }
        }
        if (saved || dirty()) await ensureOwner()
        if (disposed || !current()) return
        if (handoff) {
          const receipt = await settled(await api().noteState(owner, handoff.requestId))
          if (receipt.status === 'committed') {
            await finishCommitted(receipt, true)
            return
          }
          handoffFailed = ['failed', 'rejected'].includes(receipt.status)
          commitLocked.value = !handoffFailed
        }
        if (saved) {
          if (legacy) assertLegacyCurrent(generation)
          for (const [name, value] of Object.entries(fields)) {
            if (Object.hasOwn(saved.data, name)) value.value = saved.data[name]
          }
          const restoration = restoreExtra(saved.data)
          if (legacy) legacy.fields = fieldSnapshot()
          const restored = await restoration
          if (legacy && restored === false) throw draftError('旧草稿附件尚未恢复，原始记录仍保留')
          if (disposed || !current()) return
          if (legacy) {
            assertLegacyCurrent(generation)
            removeLegacySource()
          }
          if (dirty() || handoff)
            showMessage('info', '已恢复本次启动期间未保存的草稿，请核对后保存。')
        }
        ready = true
      } catch (error) {
        if (disposed || !current()) return
        recoveryError = error
        warn(error, legacy ? error.message : '草稿恢复失败，原始草稿仍保留，请重新打开编辑器核对。')
      }
    })()
    return initializeTask
  })
  onBeforeUnmount(() => {
    invalidateImages(true)
    finalizing = true
    const flushing = flush()
    // A migration may own an in-flight stage. The replacement must wait for its
    // cleanup before it resumes the same receipt or allocates another owner.
    const final = initializeTask ? Promise.allSettled([initializeTask, flushing]) : flushing
    finalFlushes.set(storageKey, final)
    void final.finally(() => {
      finalizing = false
      if (finalFlushes.get(storageKey) === final) finalFlushes.delete(storageKey)
      if (latest.get(storageKey) === instance) latest.delete(storageKey)
    })
    disposed = true
    stopWatching()
    active.delete(entry)
  })
  return {
    imageGeneration: readonly(imageGeneration),
    flush,
    clear: () =>
      commitLocked.value
        ? Promise.reject(draftError('保存结果尚未确认，请先查询原请求', 'DRAFT_NOTE_PENDING'))
        : clear(),
    resume,
    commitNote,
    commitLocked,
    async stageImage(image) {
      const generation = epoch
      if (commitLocked.value)
        throw draftError('保存结果尚未确认，请先查询原请求', 'DRAFT_NOTE_PENDING')
      const original = await ensureOwner()
      if (legacy && !ready) throw draftError('旧草稿正在恢复，请稍后重试', 'DRAFT_RECOVERY_PENDING')
      if (disposed || !current(generation))
        throw draftError('图片所属草稿已关闭', 'DRAFT_DOCUMENT_EXPIRED')
      const asset = await api().stage(original, image)
      if (disposed || !current(generation) || commitLocked.value) {
        await api()
          .release(original, [asset.assetId])
          .catch((error) => console.error('[editing-draft] 迟到图片清理失败', error))
        throw draftError('图片所属草稿已关闭', 'DRAFT_DOCUMENT_EXPIRED')
      }
      const metadata = cloneDraftMetadata(asset)
      assetOwners.set(metadata.assetId, original)
      return metadata
    },
    async previewAsset(assetId) {
      const generation = epoch
      const original = await ensureOwner()
      if (disposed || !current(generation))
        throw draftError('图片预览已失效', 'DRAFT_DOCUMENT_EXPIRED')
      const result = await api().preview(original, assetId)
      if (disposed || !current(generation))
        throw draftError('图片预览已失效', 'DRAFT_DOCUMENT_EXPIRED')
      assetOwners.set(assetId, original)
      return result
    },
    async thumbnailAsset(assetId, size = 512) {
      const generation = epoch
      const original = await ensureOwner()
      if (disposed || !current(generation))
        throw draftError('图片缩略图已失效', 'DRAFT_DOCUMENT_EXPIRED')
      const result = await api().thumbnail(original, assetId, size)
      if (disposed || !current(generation))
        throw draftError('图片缩略图已失效', 'DRAFT_DOCUMENT_EXPIRED')
      assetOwners.set(assetId, original)
      return result
    },
    async releaseAssets(ids) {
      // A picker may finish after unmount. Known IDs retain their original owner,
      // so compensation cannot accidentally borrow a newly resumed form's lease.
      const groups = new Map()
      for (const id of ids) {
        const original = assetOwners.get(id)
        if (!original) throw draftError('图片归属已失效', 'DRAFT_DOCUMENT_EXPIRED')
        const group = groups.get(original) || []
        group.push(id)
        groups.set(original, group)
      }
      for (const [original, selected] of groups) {
        await api().release(original, selected)
        for (const id of selected) assetOwners.delete(id)
      }
      return true
    }
  }
}
