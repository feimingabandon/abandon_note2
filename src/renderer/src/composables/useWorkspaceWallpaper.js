import { onUnmounted, ref } from 'vue'

/** The list keeps a cache/exit frame; month/week deliberately use immediate release and fresh reads. */
export function useWorkspaceWallpaper({
  defaults,
  cacheLoads = false,
  releaseDelayMs = 0,
  label,
  api = window.api
}) {
  const wallpaperUrl = ref('')
  const wallpaperVisible = ref(false)
  const wallpaperBlurRadius = ref(defaults.wallpaper.blurRadius)
  const wallpaperRenderKey = ref(null)
  let sequence = 0
  let loadedId = null
  let pendingId = null
  let pendingLoad = null
  let releaseTimer = null
  let disposed = false

  function clearData() {
    wallpaperUrl.value = ''
    wallpaperRenderKey.value = null
    loadedId = null
  }

  async function sync(snapshot) {
    if (disposed) return
    const currentSequence = ++sequence
    const wallpaper = snapshot?.values?.wallpaper || defaults.wallpaper
    wallpaperBlurRadius.value = wallpaper.blurRadius
    const visible = Boolean(
      wallpaper.enabled && wallpaper.activeId && !snapshot?.runtime?.blur?.effectiveEnabled
    )
    clearTimeout(releaseTimer)
    releaseTimer = null
    if (!visible) {
      wallpaperVisible.value = false
      if (releaseDelayMs) {
        releaseTimer = setTimeout(() => {
          releaseTimer = null
          if (!disposed && currentSequence === sequence && !wallpaperVisible.value) clearData()
        }, releaseDelayMs)
      } else clearData()
      return
    }
    const requestedId = Number(wallpaper.activeId)
    if (cacheLoads && loadedId === requestedId && wallpaperUrl.value) {
      wallpaperVisible.value = true
      return
    }
    let currentLoad
    try {
      if (!cacheLoads || pendingId !== requestedId || !pendingLoad) {
        pendingId = requestedId
        pendingLoad = api.getWallpaperData(requestedId, false)
      }
      currentLoad = pendingLoad
      const data = await currentLoad
      if (currentLoad === pendingLoad) {
        pendingId = null
        pendingLoad = null
      }
      if (disposed || currentSequence !== sequence) return
      if (!data) {
        wallpaperVisible.value = false
        if (!cacheLoads) clearData()
        return
      }
      wallpaperUrl.value = data
      wallpaperRenderKey.value = requestedId
      loadedId = requestedId
      wallpaperVisible.value = true
    } catch (error) {
      if (currentLoad === pendingLoad) {
        pendingId = null
        pendingLoad = null
      }
      if (!disposed && currentSequence === sequence) wallpaperVisible.value = false
      console.warn(`[${label}] 读取壁纸失败:`, error)
    }
  }

  onUnmounted(() => {
    disposed = true
    sequence += 1
    clearTimeout(releaseTimer)
    releaseTimer = null
    pendingId = null
    pendingLoad = null
  })
  return { wallpaperUrl, wallpaperVisible, wallpaperBlurRadius, wallpaperRenderKey, sync }
}
