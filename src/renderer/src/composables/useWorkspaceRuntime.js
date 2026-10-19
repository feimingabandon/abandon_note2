import { onMounted, onUnmounted, ref } from 'vue'
import { applySettingsSnapshot } from '../utils/applySettingsSnapshot.js'
import { retainModalBlur } from '../utils/modalBlur.js'
import { createMessageProvider } from './useMessage.js'
import { createQuickNoteEditSettingProvider } from './useQuickNoteEditSetting.js'
import { createTagColorSettingProvider } from './useTagColorSetting.js'
import { usePresentationMode } from './usePresentationMode.js'

/** One root owns its provider/presentation ticket, subscriptions, ready barrier and modal releases. */
export function useWorkspaceRuntime({
  defaults,
  getViewMode,
  label,
  windowFallback = false,
  hoverPhase = 'mounted',
  waitForContent = false,
  onSnapshot,
  onInitialSnapshot,
  onSettingsChanged,
  onNotesChanged,
  onRemoteNoticesChanged,
  beforeReady,
  afterReady,
  api = window.api,
  documentTarget = document,
  applyCss = applySettingsSnapshot
}) {
  const { showMessage } = createMessageProvider()
  const quickNoteEditSetting = createQuickNoteEditSettingProvider()
  const tagColorSetting = createTagColorSettingProvider()
  const presentationMode = usePresentationMode()
  const locked = ref(defaults.window.lockState)
  const zOrderMode = ref(defaults.window.zOrderMode)
  const titlebarStyle = ref(defaults.appearance.titlebarStyle)
  const subscriptions = []
  const modalReleases = new Map()
  let disposed = false
  let started = false
  let hoverInstalled = false
  let resolveContentReady
  const contentReady = waitForContent
    ? new Promise((resolve) => {
        resolveContentReady = resolve
      })
    : Promise.resolve()

  function applySnapshot(snapshot) {
    if (disposed) return
    applyCss(snapshot)
    quickNoteEditSetting.applySnapshot(snapshot)
    tagColorSetting.applySnapshot(snapshot)
    titlebarStyle.value =
      snapshot?.values?.appearance?.titlebarStyle ?? defaults.appearance.titlebarStyle
    if (windowFallback) {
      locked.value = snapshot?.values?.window?.lockState ?? defaults.window.lockState
      zOrderMode.value = snapshot?.values?.window?.zOrderMode ?? defaults.window.zOrderMode
    } else if (snapshot?.values?.window) {
      locked.value = snapshot.values.window.lockState
      zOrderMode.value = snapshot.values.window.zOrderMode
    }
    onSnapshot?.(snapshot)
  }

  function markContentReady() {
    resolveContentReady?.()
    resolveContentReady = null
  }

  function retainBlur(key) {
    if (!disposed && !modalReleases.has(key)) modalReleases.set(key, retainModalBlur())
  }

  function releaseBlur(key) {
    const release = modalReleases.get(key)
    modalReleases.delete(key)
    release?.()
  }

  const mouseEnter = () => api.windowHover(true)
  const mouseLeave = () => api.windowHover(false)
  function installHover() {
    if (disposed || hoverInstalled) return
    documentTarget.addEventListener('mouseenter', mouseEnter)
    documentTarget.addEventListener('mouseleave', mouseLeave)
    hoverInstalled = true
  }
  if (hoverPhase === 'setup') installHover()

  function subscribe(register, callback) {
    if (typeof register !== 'function') return
    const stop = register((value) => {
      if (!disposed) callback(value)
    })
    if (typeof stop === 'function') subscriptions.push(stop)
  }

  onMounted(async () => {
    started = true
    await presentationMode.start()
    if (disposed) return
    let snapshot
    try {
      snapshot = await api.getSettingsSnapshot()
    } catch (error) {
      snapshot = { values: defaults }
      console.warn(`[${label}] 读取设置快照失败，使用共享默认值:`, error)
    }
    if (disposed) return
    applySnapshot(snapshot)
    onInitialSnapshot?.(snapshot)
    subscribe(api.onSettingsChanged, (next) => {
      applySnapshot(next)
      onSettingsChanged?.(next)
    })
    if (onNotesChanged) subscribe(api.onNotesChanged, onNotesChanged)
    subscribe(api.onAppMessage, (payload) => {
      if (payload?.text)
        showMessage(payload.type || 'warning', payload.text, payload.duration ?? 2500)
    })
    subscribe(api.onRemoteNoticesChanged, () => onRemoteNoticesChanged?.())
    if (hoverPhase !== 'setup') installHover()
    await beforeReady?.()
    if (disposed) return
    await contentReady
    if (disposed) return
    api.rendererReady(getViewMode())
    afterReady?.()
  })

  onUnmounted(() => {
    disposed = true
    markContentReady()
    if (started) presentationMode.stop()
    for (const stop of subscriptions.splice(0)) stop()
    if (hoverInstalled) {
      documentTarget.removeEventListener('mouseenter', mouseEnter)
      documentTarget.removeEventListener('mouseleave', mouseLeave)
      hoverInstalled = false
    }
    for (const key of modalReleases.keys()) releaseBlur(key)
  })

  return {
    showMessage,
    presentationMode,
    locked,
    zOrderMode,
    titlebarStyle,
    applySnapshot,
    markContentReady,
    retainBlur,
    releaseBlur
  }
}
