import { ref } from 'vue'
import { DOCK_EDGES, DOCK_REVEAL_HANDLE_MODES } from '../../../shared/settings-schema.js'

const edgeLabels = Object.freeze({ top: '上', left: '左', right: '右' })
const edgeOptions = DOCK_EDGES.map((value) => ({ value, label: edgeLabels[value] }))
const revealModeOptions = Object.freeze([
  {
    value: DOCK_REVEAL_HANDLE_MODES.DIRECT,
    label: '直接唤出',
    title: '鼠标触碰隐藏边缘后直接展开窗口'
  },
  {
    value: DOCK_REVEAL_HANDLE_MODES.ON_TOUCH,
    label: '触边确认',
    title: '触边时显示小黑条，鼠标离开后自动收回'
  },
  {
    value: DOCK_REVEAL_HANDLE_MODES.PERSISTENT,
    label: '常显确认',
    title: '窗口隐藏后保持显示；长按拖动可调整沿屏幕边缘的位置'
  }
])

/** The current view's dock form; persistence generations belong to the shared write queue. */
export function useDockSettingsForm({ getDefaults, canWrite, write }) {
  const revealHandleMode = ref(getDefaults().revealHandleMode)
  const enabledEdges = ref([...getDefaults().enabledEdges])
  const runtime = ref({ supported: true, reason: '' })

  function normalizeEdges(edges) {
    const selected = new Set(Array.isArray(edges) ? edges : getDefaults().enabledEdges)
    return DOCK_EDGES.filter((side) => selected.has(side))
  }

  function assignConfig(config = getDefaults()) {
    revealHandleMode.value = Object.values(DOCK_REVEAL_HANDLE_MODES).includes(
      config?.revealHandleMode
    )
      ? config.revealHandleMode
      : DOCK_REVEAL_HANDLE_MODES.DIRECT
    enabledEdges.value = normalizeEdges(config?.enabledEdges)
  }

  function assignRuntime(value) {
    if (!value) return
    runtime.value = {
      supported: value.supported !== false,
      reason: value.reason || value.error || ''
    }
  }

  function isRevealModeDisabled(mode) {
    return !runtime.value.supported || !Object.values(DOCK_REVEAL_HANDLE_MODES).includes(mode)
  }

  function save(config) {
    if (!canWrite()) return
    assignConfig(config)
    return write({
      revealHandleMode: revealHandleMode.value,
      enabledEdges: [...enabledEdges.value]
    })
  }

  function setRevealHandleMode(value) {
    if (isRevealModeDisabled(value)) return
    void save({ revealHandleMode: value, enabledEdges: enabledEdges.value })
  }

  function toggleEdge(side) {
    if (!runtime.value.supported || !DOCK_EDGES.includes(side)) return
    const selected = new Set(enabledEdges.value)
    if (selected.has(side)) selected.delete(side)
    else selected.add(side)
    void save({ revealHandleMode: revealHandleMode.value, enabledEdges: [...selected] })
  }

  return {
    revealHandleMode,
    enabledEdges,
    runtime,
    edgeOptions,
    revealModeOptions,
    assignConfig,
    assignRuntime,
    isRevealModeDisabled,
    setRevealHandleMode,
    toggleEdge
  }
}
