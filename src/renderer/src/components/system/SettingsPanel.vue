<script setup>
/**
 * SettingsPanel.vue — 底部弹出式设置面板
 *
 * 职责：
 *   1. 从主窗口底部向上滑入，占主窗口 70% 高度
 *   2. 使用全局玻璃基准值渲染设置面板，并让其他浮层按比例派生
 *   3. 展示并实时控制各类设置（基础样式、窗口、关于）
 *   4. 所有设置修改立即生效（CSS变量 / IPC / 系统API）
 *
 * Props:
 *   - visible {Boolean} 控制面板显隐，配合 v-model 使用
 *
 * Events:
 *   - update:visible  关闭面板时触发
 */

import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import AppToggle from '../ui/AppToggle.vue'
import BaseButton from '../ui/BaseButton.vue'
import FontSizeInput from '../ui/FontSizeInput.vue'
import AppSlider from '../ui/AppSlider.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import HelpButton from '../ui/HelpButton.vue'
import WallpaperSettings from '../wallpaper/WallpaperSettings.vue'
import LogViewerDialog from './LogViewerDialog.vue'
import RemoteNoticeHistoryDialog from './RemoteNoticeHistoryDialog.vue'
import { useMessage } from '../../composables/useMessage.js' // 消息弹窗
import { applyGlassBaseSettings, applySettingsSnapshot } from '../../utils/applySettingsSnapshot.js'
import { DEFAULT_SETTINGS } from '../../../../shared/settings-schema.js'

// ---- 调度器健康数据 ----
const schedulerHealth = ref(null)
let _schedulerTimer = null

async function loadSchedulerHealth() {
  try {
    schedulerHealth.value = await window.api.getSchedulerHealth()
  } catch (e) {
    console.warn('[SettingsPanel] 获取调度器健康数据失败:', e)
    schedulerHealth.value = null
  }
}

function formatTickTime(ts) {
  if (!ts) return '——'
  return new Date(ts).toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function tickTimeAgo(ts) {
  if (!ts) return '——'
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  return `${Math.floor(diff / 3600000)} 小时前`
}

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:visible', 'blur-release', 'check-update'])

const el = document.documentElement

// ---- 面板动画控制 ----
const rendered = ref(props.visible)
const panelActive = ref(false)
const panelRef = ref(null)
const closeButtonRef = ref(null)
const panelHeight = ref(70) // 面板高度百分比，默认 70%
const isResetting = ref(false)
const showLogViewer = ref(false)
const showNoticeHistory = ref(false)
const appVersion = ref('未知')

/** 关闭动画定时器 ID，用于取消竞态关闭 */
let closeTimer = null
let blurReleaseTimer = null
let openRaf = null
let componentUnmounted = false

// ---- 拖拽调整面板高度 ----
let isDragging = false
let dragPointerId = null
let dragHandle = null
let dragStartY = 0
let dragStartHeight = 0
let dragLatestY = 0
let dragRaf = null

function onDragStart(e) {
  if (isResetting.value || e.button !== 0 || isDragging) return

  isDragging = true
  dragPointerId = e.pointerId
  dragHandle = e.currentTarget
  dragStartY = e.clientY
  dragLatestY = e.clientY
  dragStartHeight = panelHeight.value
  dragHandle.setPointerCapture(e.pointerId)
  if (panelRef.value) {
    panelRef.value.style.transition = 'none'
  }
  e.preventDefault()
}

function onDragMove(e) {
  if (!isDragging || e.pointerId !== dragPointerId || !panelRef.value) return
  dragLatestY = e.clientY
  // RAF 节流：每帧只更新一次
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const panel = panelRef.value
    if (!panel) return
    const wrapper = panel.parentElement
    const wrapperHeight = wrapper ? wrapper.getBoundingClientRect().height : window.innerHeight
    const deltaY = dragStartY - dragLatestY
    const deltaPct = (deltaY / wrapperHeight) * 100
    let newHeight = dragStartHeight + deltaPct
    newHeight = Math.max(25, Math.min(95, newHeight))
    newHeight = Math.round(newHeight)
    // 直接操作 DOM 绕过 Vue 响应式
    panel.style.height = newHeight + '%'
    panelHeight.value = newHeight
  })
}

function onDragEnd(e) {
  if (!isDragging || (e && e.pointerId !== dragPointerId)) return

  const pointerId = dragPointerId
  const handle = dragHandle
  isDragging = false
  dragPointerId = null
  dragHandle = null
  if (dragRaf) {
    cancelAnimationFrame(dragRaf)
    dragRaf = null
  }
  if (panelRef.value) {
    panelRef.value.style.transition = ''
    panelRef.value.style.height = panelHeight.value + '%'
  }
  if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
}

/** 点击面板外区域关闭（排除自身弹窗内的点击） */
const onDocClick = (e) => {
  if (!rendered.value || !panelActive.value) return
  // 点击在设置面板内部 → 不关闭
  if (panelRef.value && panelRef.value.contains(e.target)) return
  // 设置页拥有的 Teleport 弹层不在 panelRef 内，但仍属于设置交互的一部分。
  if (e.target.closest('[data-keep-settings-open], .confirm-overlay')) return
  close()
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true))

const close = () => {
  if (isResetting.value || closeTimer) return
  onDragEnd()
  // 保持背景模糊到退场动画结束，避免半透明面板在最后一段动画中直接透出清晰内容。
  blurReleaseTimer = setTimeout(() => {
    blurReleaseTimer = null
    emit('blur-release')
  }, 350)
  panelActive.value = false
  Promise.all([flushPendingSettingSaves(), flushPendingBlurConfig()]).catch((e) =>
    console.warn('[SettingsPanel] 关闭前保存设置失败:', e)
  )
  closeTimer = setTimeout(() => {
    closeTimer = null
    rendered.value = false
    emit('update:visible', false)
  }, 350)
}

watch(
  () => props.visible,
  async (val) => {
    if (val) {
      // 取消待执行的关闭动画，避免「关闭中重开」导致的闪现消失
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      if (blurReleaseTimer) {
        clearTimeout(blurReleaseTimer)
        blurReleaseTimer = null
      }
      rendered.value = true
      await nextTick()
      requestAnimationFrame(() => {
        panelActive.value = true
      })
    } else if (rendered.value) {
      close()
    }
  }
)

// ---- 基础样式设置 ----
const titlebarStyle = ref(DEFAULT_SETTINGS.appearance.titlebarStyle)
const bgColor = ref(DEFAULT_SETTINGS.css.bgColor)
const fontSizeBase = ref(DEFAULT_SETTINGS.css.fontSizeBase)
const textColor = ref(DEFAULT_SETTINGS.css.textColor)
const stickyFontSize = ref(DEFAULT_SETTINGS.sticky.fontSize)
const stickyBackgroundColor = ref(DEFAULT_SETTINGS.sticky.backgroundColor)
const stickyCornerRadius = ref(DEFAULT_SETTINGS.sticky.cornerRadius)
const stickyAlwaysOnTop = ref(DEFAULT_SETTINGS.sticky.alwaysOnTop)
const receiveRemoteNotices = ref(DEFAULT_SETTINGS.remote.receiveNotices)
const uploadDeviceInfo = ref(DEFAULT_SETTINGS.remote.uploadDeviceInfo)
const remoteHealthStatus = ref('checking')
const remoteHealthError = ref('')

function applyRemoteHealth(result) {
  remoteHealthStatus.value = result?.checking
    ? 'checking'
    : result?.available
      ? 'available'
      : result?.skipped
        ? 'skipped'
        : 'unavailable'
  remoteHealthError.value = result?.available ? '' : result?.error || '连接失败'
}

const remoteHealthLabel = computed(() => {
  if (remoteHealthStatus.value === 'checking') return '检测中'
  if (remoteHealthStatus.value === 'available') return '● 连接正常'
  if (remoteHealthStatus.value === 'skipped') return '○ 本次未检测'
  return '○ 连接异常'
})

async function loadRemoteHealth() {
  remoteHealthStatus.value = 'checking'
  remoteHealthError.value = ''
  try {
    // 只读取主进程在启动阶段保存的结果；这里绝不访问服务器。
    const result = await window.api.getRemoteHealth()
    applyRemoteHealth(result)
  } catch (error) {
    console.error('[SettingsPanel] 检查远程服务健康状态失败:', error)
    remoteHealthStatus.value = 'unavailable'
    remoteHealthError.value = error?.message || '连接失败'
  }
}

/** 字体大小预设（datalist 选项） */
const fontSizePresets = [14, 15, 16, 17, 18, 19, 20, 21, 22]
const stickyFontSizePresets = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
const stickyColorPresets = [
  { label: '便签黄', value: '#fff2a8' },
  { label: '柔粉', value: '#ffd4e1' },
  { label: '浅蓝', value: '#d4eaff' },
  { label: '浅绿', value: '#ddf3d5' }
]

/** 十六进制颜色预设（文字颜色 / 背景颜色共用） */
const hexPresets = [
  { label: '纯黑', value: '#000000' },
  { label: '纯白', value: '#ffffff' }
]

// ---- 文字颜色输入校验 ----
const textColorInput = ref(textColor.value)
const textColorInputError = ref(false)

// ---- 背景颜色 hex 显示与校验 ----
const bgColorHex = computed(() => {
  const parts = bgColor.value.split(' ').map(Number)
  if (parts.length !== 3) return '#ffffff'
  return (
    '#' + parts.map((p) => Math.min(255, Math.max(0, p)).toString(16).padStart(2, '0')).join('')
  )
})
const bgColorInput = ref(bgColorHex.value)
const bgColorInputError = ref(false)
const stickyColorInput = ref(stickyBackgroundColor.value)
const stickyColorInputError = ref(false)

/** 验证十六进制颜色格式 */
function isValidHex(val) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(val.trim())
}

/** 标准化 hex（3 位 → 6 位，统一小写） */
function normalizeHex(val) {
  const trimmed = val.trim().toLowerCase()
  if (trimmed.length === 4) {
    return '#' + [...trimmed.slice(1)].map((c) => c + c).join('')
  }
  return trimmed
}

/** hex → RGB 对象 */
function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  }
}

// ---- 文字颜色：输入变更（实时清除错误） ----
function onTextColorInput(e) {
  textColorInput.value = e.target.value
  if (textColorInputError.value) textColorInputError.value = false
}

// ---- 文字颜色：提交校验（blur / Enter） ----
function commitTextColor() {
  const val = textColorInput.value.trim()
  if (val === '') {
    textColorInput.value = textColor.value
    return
  }
  if (isValidHex(val)) {
    const normalized = normalizeHex(val)
    textColor.value = normalized
    textColorInput.value = normalized
    textColorInputError.value = false
  } else {
    textColorInput.value = textColor.value
    showMessage('warning', '请输入有效的十六进制颜色值，如 #000000')
    textColorInputError.value = true
  }
}

// ---- 背景颜色：输入变更 ----
function onBgColorInput(e) {
  bgColorInput.value = e.target.value
  if (bgColorInputError.value) bgColorInputError.value = false
}

// ---- 背景颜色：提交校验 ----
function commitBgColor() {
  const val = bgColorInput.value.trim()
  if (val === '') {
    bgColorInput.value = bgColorHex.value
    return
  }
  if (isValidHex(val)) {
    const normalized = normalizeHex(val)
    const { r, g, b } = hexToRgb(normalized)
    bgColor.value = `${r} ${g} ${b}`
    bgColorInput.value = normalized
    bgColorInputError.value = false
  } else {
    bgColorInput.value = bgColorHex.value
    showMessage('warning', '请输入有效的十六进制颜色值，如 #FFFFFF')
    bgColorInputError.value = true
  }
}

// ---- 背景颜色预设点击 ----
function setBgColorPreset(hex) {
  const { r, g, b } = hexToRgb(hex)
  bgColor.value = `${r} ${g} ${b}`
}

function onStickyColorInput(e) {
  stickyColorInput.value = e.target.value
  if (stickyColorInputError.value) stickyColorInputError.value = false
}

function commitStickyColor() {
  const value = stickyColorInput.value.trim()
  if (value === '') {
    stickyColorInput.value = stickyBackgroundColor.value
    return
  }
  if (!isValidHex(value)) {
    stickyColorInput.value = stickyBackgroundColor.value
    stickyColorInputError.value = true
    showMessage('warning', '请输入有效的便利贴十六进制颜色，如 #FFF2A8')
    return
  }
  const normalized = normalizeHex(value)
  stickyBackgroundColor.value = normalized
  stickyColorInput.value = normalized
  stickyColorInputError.value = false
}

// ---- 窗口设置 ----
const autoStart = ref(false)
const autoStartError = ref(null) // 持久错误（null = 无错误），恒显示不自动消失

/** 开机自启状态是否已从 OS 同步完成（防止首次读取触发重复设置） */
let _autoStartSynced = false
let _autoStartRequestRevision = 0
const inFlightAutoStartWrites = new Set()
let _settingsSynced = false

// ---- 系统模糊设置 ----
const blurCaps = ref({ supported: false, platform: '', strategy: 'none' })
const blurEnabled = ref(DEFAULT_SETTINGS.blur.enabled)
const blurError = ref(null) // 持久错误（如 DLL 未加载），恒显示不自动消失
const blurRadius = ref(DEFAULT_SETTINGS.blur.radius)
const blurSaturation = ref(DEFAULT_SETTINGS.blur.saturation)
const blurCornerRadius = ref(DEFAULT_SETTINGS.blur.cornerRadius)
const blurDiagnostic = ref({
  status: 'pending',
  lastCheckedAt: null,
  message: '等待调度器执行首次诊断'
})
let _blurSynced = false
let _blurEnableFeedbackPending = false
let stopBlurRuntimeListener = null
let stopBlurDiagnosticListener = null
let stopRemoteHealthListener = null

const blurDiagnosticMeta = computed(() => {
  const states = {
    healthy: { label: '● 正常', className: 'sched-badge--ok' },
    error: { label: '⚠ 异常', className: 'sched-badge--danger' },
    disabled: { label: '○ 未启用', className: 'sched-badge--warn' },
    unsupported: { label: '— 不支持', className: 'sched-badge--warn' },
    pending: { label: '… 待诊断', className: 'sched-badge--warn' }
  }
  return states[blurDiagnostic.value.status] || states.pending
})

// ---- 窗口透明度（仅系统模糊关闭时显示） ----
const windowOpacity = ref(DEFAULT_SETTINGS.css.windowOpacity)

// ---- CSS 组件模糊设置 ----
const cssBlur = ref(DEFAULT_SETTINGS.css.bgBlur)
const cssOpacity = ref(DEFAULT_SETTINGS.css.popupOpacity)

const { showMessage } = useMessage()

/**
 * 使用元素的真实高度驱动原生模糊参数区动画。
 * 相比 0fr/1fr CSS 插值，这在 Electron 当前布局中更稳定。
 */
function animateNativeBlurOptions(el, opening, done) {
  const fullHeight = `${el.scrollHeight}px`
  const collapsed = { height: '0px', opacity: 0, transform: 'translateY(-6rem)' }
  const expanded = { height: fullHeight, opacity: 1, transform: 'translateY(0)' }
  const animation = el.animate(opening ? [collapsed, expanded] : [expanded, collapsed], {
    duration: 280,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  })

  animation.finished.then(done, done)
}

function onNativeBlurOptionsEnter(el, done) {
  animateNativeBlurOptions(el, true, done)
}

function onNativeBlurOptionsLeave(el, done) {
  animateNativeBlurOptions(el, false, done)
}

// ---- 确认弹窗状态 ----
const showClearNoteDataDialog = ref(false)
const showResetSettingsDialog = ref(false)

async function assignAutoStartWithoutWrite(value) {
  _autoStartSynced = false
  autoStart.value = Boolean(value)
  await nextTick()
  _autoStartSynced = true
}

watch(autoStart, async (v) => {
  if (!_autoStartSynced || isResetting.value) return
  const requestRevision = ++_autoStartRequestRevision
  let request = null

  try {
    // 写入 OS，并获取 OS 回读确认的真实状态（不进入 app_settings）。
    request = window.api.setAutoStart(v)
    inFlightAutoStartWrites.add(request)
    const verified = await request
    if (requestRevision !== _autoStartRequestRevision) return

    if (verified === v) {
      // OS 确认成功 → 清除持久错误 + 成功 Toast
      autoStartError.value = null
      showMessage('success', v ? '开机自启已开启' : '开机自启已关闭')
    } else {
      // OS 状态与请求不符 → 回滚 UI + 持久错误
      await assignAutoStartWithoutWrite(verified)
      autoStartError.value = v
        ? '开启失败，请检查系统安全软件是否拦截了开机启动权限'
        : '关闭失败，请检查系统权限设置'
    }
  } catch (e) {
    if (requestRevision !== _autoStartRequestRevision) return
    console.warn('[SettingsPanel] 设置开机自启失败:', e)
    try {
      const actual = await window.api.verifyAutoStart()
      if (requestRevision !== _autoStartRequestRevision) return
      await assignAutoStartWithoutWrite(actual.value)
    } catch (verifyError) {
      // OS 回读也失败时保留当前控件值，并在下次打开设置时重新查询。
      console.error('[SettingsPanel] 开机自启写入失败后的系统状态回读也失败:', verifyError)
    }
    autoStartError.value = '设置失败，请重试'
  } finally {
    if (request) inFlightAutoStartWrites.delete(request)
  }
})

// ---- 防抖保存工具 ----
const debounceTimers = {}
const pendingSaves = {}
const inFlightSettingSaves = new Set()

function persistSetting(pending) {
  const request = window.api.setSettingValue(pending.id, pending.value)
  inFlightSettingSaves.add(request)
  request.then(
    () => inFlightSettingSaves.delete(request),
    () => inFlightSettingSaves.delete(request)
  )
  return request
}

function debouncedSave(id, value) {
  if (!_settingsSynced || isResetting.value) return
  if (debounceTimers[id]) clearTimeout(debounceTimers[id])
  pendingSaves[id] = { id, value }
  debounceTimers[id] = setTimeout(() => {
    delete debounceTimers[id]
    const pending = pendingSaves[id]
    delete pendingSaves[id]
    if (!pending || isResetting.value) return
    persistSetting(pending).catch((e) =>
      console.warn(`[SettingsPanel] 保存设置 ${pending.id} 失败:`, e)
    )
  }, 300)
}

function clearPendingSettingSaves() {
  Object.values(debounceTimers).forEach((timer) => clearTimeout(timer))
  Object.keys(debounceTimers).forEach((key) => delete debounceTimers[key])
  Object.keys(pendingSaves).forEach((key) => delete pendingSaves[key])
}

async function flushPendingSettingSaves() {
  const saves = Object.values(pendingSaves)
  clearPendingSettingSaves()
  await Promise.all(saves.map(persistSetting))
}
// ---- 实时生效 watchers ----

// 导航栏是离散选项：点击后立即持久化并广播，不使用滑块/文本输入的防抖。
watch(titlebarStyle, (v) => {
  if (!_settingsSynced || isResetting.value) return
  persistSetting({ id: 'appearance.titlebarStyle', value: v }).catch((e) =>
    console.warn('[SettingsPanel] 保存导航栏风格失败:', e)
  )
})

watch(receiveRemoteNotices, (value) => {
  if (!_settingsSynced || isResetting.value) return
  persistSetting({ id: 'remote.receiveNotices', value }).catch((error) =>
    console.warn('[SettingsPanel] 保存远程通知开关失败:', error)
  )
})

watch(uploadDeviceInfo, (value) => {
  if (!_settingsSynced || isResetting.value) return
  persistSetting({ id: 'remote.uploadDeviceInfo', value }).catch((error) =>
    console.warn('[SettingsPanel] 保存设备信息上传开关失败:', error)
  )
})

// 背景颜色 → CSS --bg-color (基础样式，主窗口+组件共用)
watch(bgColor, (v) => {
  el.style.setProperty('--bg-color', v)
  debouncedSave('css.bgColor', v)
})

// ---- CSS 玻璃基准：所有组件按预设比例派生 ----
watch(cssBlur, (v) => {
  applyGlassBaseSettings({ blur: v, opacity: cssOpacity.value }, el)
  debouncedSave('css.bgBlur', v)
})

watch(cssOpacity, (v) => {
  applyGlassBaseSettings({ blur: cssBlur.value, opacity: v }, el)
  debouncedSave('css.popupOpacity', v)
})

// ---- 窗口透明度 ----
watch(windowOpacity, (v) => {
  el.style.setProperty('--window-opacity', v)
  debouncedSave('css.windowOpacity', v)
})

// 字体大小 → CSS --font-size-base
watch(fontSizeBase, (v) => {
  el.style.setProperty('--font-size-base', v + 'rem')
  debouncedSave('css.fontSizeBase', v)
})

// 文字颜色 → CSS --text-color
watch(textColor, (v) => {
  el.style.setProperty('--text-color', v)
  debouncedSave('css.textColor', v)
})

watch(stickyFontSize, (v) => {
  debouncedSave('sticky.fontSize', v)
})

watch(stickyBackgroundColor, (v) => {
  debouncedSave('sticky.backgroundColor', v)
})

watch(stickyCornerRadius, (v) => {
  debouncedSave('sticky.cornerRadius', v)
})

watch(stickyAlwaysOnTop, (v) => {
  debouncedSave('sticky.alwaysOnTop', v)
})

// 同步文字颜色输入显示值
watch(textColor, (v) => {
  textColorInput.value = v
  textColorInputError.value = false
})

// 同步背景颜色输入显示值
watch(bgColorHex, (v) => {
  bgColorInput.value = v
  bgColorInputError.value = false
})

watch(stickyBackgroundColor, (v) => {
  stickyColorInput.value = v
  stickyColorInputError.value = false
})

// ---- 系统模糊 watch（防抖发送到主进程） ----
const inFlightBlurSyncs = new Set()

function syncBlurConfig() {
  if (!_blurSynced || isResetting.value) return Promise.resolve()
  const shouldReportEnableResult = _blurEnableFeedbackPending
  _blurEnableFeedbackPending = false
  const request = window.api.setBlurConfig({
    enabled: blurEnabled.value,
    radius: blurRadius.value,
    saturation: blurSaturation.value,
    cornerRadius: blurCornerRadius.value
  })
  inFlightBlurSyncs.add(request)
  request.then(
    () => inFlightBlurSyncs.delete(request),
    () => inFlightBlurSyncs.delete(request)
  )
  return request
    .then((result) => {
      if (result?.config && result.config.enabled !== blurEnabled.value) {
        _blurSynced = false
        blurEnabled.value = Boolean(result.config.enabled)
        nextTick(() => {
          _blurSynced = true
        })
      }
      if (result?.runtime) blurError.value = result.error ?? result.runtime.error ?? null
      if (shouldReportEnableResult && !result?.success) {
        const nativeError = result?.nativeError
        const codeSuffix = nativeError?.code ? `（错误码 ${nativeError.code}）` : ''
        showMessage(
          'error',
          `毛玻璃启用失败：${result?.error || result?.runtime?.error || '原生模糊引擎不可用'}${codeSuffix}`,
          5000
        )
      }
      return result
    })
    .catch((e) => {
      console.warn('[SettingsPanel] 同步模糊配置失败:', e)
      if (shouldReportEnableResult && blurEnabled.value) {
        showMessage('error', `毛玻璃启用失败：${e.message || '主进程通信失败'}`, 5000)
      }
    })
}

let _blurSyncTimer = null
function debouncedSyncBlur() {
  if (!_blurSynced || isResetting.value) return
  if (_blurSyncTimer) clearTimeout(_blurSyncTimer)
  _blurSyncTimer = setTimeout(() => {
    _blurSyncTimer = null
    if (isResetting.value) return
    syncBlurConfig()
  }, 150)
}

function flushPendingBlurConfig() {
  if (!_blurSyncTimer) return Promise.resolve()
  clearTimeout(_blurSyncTimer)
  _blurSyncTimer = null
  return syncBlurConfig()
}

function cancelPendingBlurConfig() {
  if (!_blurSyncTimer) return
  clearTimeout(_blurSyncTimer)
  _blurSyncTimer = null
}

async function waitForInFlightWrites() {
  const requests = [...inFlightSettingSaves, ...inFlightBlurSyncs, ...inFlightAutoStartWrites]
  await Promise.allSettled(requests)
}

watch(blurEnabled, () => {
  if (_blurSynced && !isResetting.value) _blurEnableFeedbackPending = true
  debouncedSyncBlur()
})
watch(blurRadius, debouncedSyncBlur)
watch(blurSaturation, debouncedSyncBlur)
watch(blurCornerRadius, debouncedSyncBlur)
// 圆角 CSS 变量即时同步（不等防抖，视觉必须立即跟上）
watch(blurCornerRadius, (v) => {
  document.documentElement.style.setProperty('--window-radius', v + 'px')
})

function assignSettingsSnapshot(snapshot) {
  const appearance = snapshot.values.appearance || DEFAULT_SETTINGS.appearance
  const css = snapshot.values.css
  const blur = snapshot.values.blur
  const sticky = snapshot.values.sticky
  const remote = snapshot.values.remote || DEFAULT_SETTINGS.remote
  const runtimeBlur = snapshot.runtime?.blur
  const runtimeAutoStart = snapshot.runtime?.autoStart

  titlebarStyle.value = appearance.titlebarStyle
  bgColor.value = css.bgColor
  cssOpacity.value = css.popupOpacity
  cssBlur.value = css.bgBlur
  windowOpacity.value = css.windowOpacity
  fontSizeBase.value = css.fontSizeBase
  textColor.value = css.textColor
  stickyFontSize.value = sticky.fontSize
  stickyBackgroundColor.value = sticky.backgroundColor
  stickyCornerRadius.value = sticky.cornerRadius
  stickyAlwaysOnTop.value = sticky.alwaysOnTop
  receiveRemoteNotices.value = remote.receiveNotices
  uploadDeviceInfo.value = remote.uploadDeviceInfo

  // “用户希望开启”与“当前确实生效”分开：支持平台初始化失败时，开关必须
  // 显示为关闭，同时保留错误信息，让用户可以再次主动开启并触发重试。
  blurEnabled.value = runtimeBlur?.supported
    ? Boolean(blur.enabled && runtimeBlur.effectiveEnabled)
    : false
  blurRadius.value = blur.radius
  blurSaturation.value = blur.saturation
  blurCornerRadius.value = blur.cornerRadius

  if (runtimeBlur) {
    blurCaps.value = {
      supported: runtimeBlur.supported,
      platform: runtimeBlur.platform,
      strategy: runtimeBlur.strategy
    }
    blurError.value = runtimeBlur.error ?? null
    if (runtimeBlur.diagnostic) blurDiagnostic.value = runtimeBlur.diagnostic
  }

  if (runtimeAutoStart) {
    autoStart.value = runtimeAutoStart.value
    autoStartError.value = runtimeAutoStart.error ?? null
  }

  applySettingsSnapshot(snapshot)
}

async function loadSettingsSnapshot() {
  _autoStartRequestRevision += 1
  _settingsSynced = false
  _blurSynced = false
  _autoStartSynced = false
  clearPendingSettingSaves()
  cancelPendingBlurConfig()

  try {
    const snapshot = await window.api.getSettingsSnapshot()
    assignSettingsSnapshot(snapshot)
  } catch (e) {
    const message = '读取设置失败，当前显示共享默认值'
    assignSettingsSnapshot({
      values: DEFAULT_SETTINGS,
      runtime: {
        autoStart: { value: autoStart.value, error: message },
        blur: {
          supported: false,
          platform: '',
          strategy: 'none',
          error: message
        }
      }
    })
    console.warn('[SettingsPanel] 加载设置快照失败，使用共享默认值:', e)
  }

  await nextTick()
  _settingsSynced = true
  _blurSynced = true
  _autoStartSynced = true
}

// 每次父组件打开设置时都会重新挂载本组件，因此这里必定重新查询完整快照。
onMounted(async () => {
  // 先订阅再读取快照，避免健康请求恰好在两步之间完成而丢失最终状态。
  stopRemoteHealthListener = window.api.onRemoteHealthChanged?.(applyRemoteHealth)
  window.api
    .getAppInfo()
    .then((info) => {
      if (info?.version) appVersion.value = info.version
    })
    .catch((error) => console.warn('[SettingsPanel] 获取应用版本失败:', error))
  // 两项都是本地 IPC；设置面板不再等待任何网络请求。
  await Promise.all([loadSettingsSnapshot(), loadRemoteHealth()])
  if (componentUnmounted) return

  stopBlurRuntimeListener = window.api.onSettingsChanged?.((snapshot) => {
    const runtimeBlur = snapshot?.runtime?.blur
    const configuredEnabled = Boolean(snapshot?.values?.blur?.enabled)
    if (!runtimeBlur) return

    blurCaps.value = {
      supported: runtimeBlur.supported,
      platform: runtimeBlur.platform,
      strategy: runtimeBlur.strategy
    }
    blurError.value = runtimeBlur.error ?? null
    if (runtimeBlur.diagnostic) blurDiagnostic.value = runtimeBlur.diagnostic

    const effectiveEnabled = Boolean(
      runtimeBlur.supported && configuredEnabled && runtimeBlur.effectiveEnabled
    )
    // 毛玻璃启用请求执行期间，主进程会先广播“壁纸已关闭”的过渡快照。
    // 这时不能用数据库中的旧 blur.enabled 把用户刚打开的开关拨回去；最终
    // 成功或失败状态由本次 IPC 返回值统一收敛。
    if (inFlightBlurSyncs.size === 0 && effectiveEnabled !== blurEnabled.value) {
      const wasEnabled = blurEnabled.value
      _blurSynced = false
      blurEnabled.value = effectiveEnabled
      nextTick(() => {
        _blurSynced = true
      })

      if (wasEnabled && !effectiveEnabled && runtimeBlur.error && inFlightBlurSyncs.size === 0) {
        showMessage('error', `毛玻璃已停止：${runtimeBlur.error}`, 5000)
      }
    }
  })
  stopBlurDiagnosticListener = window.api.onBlurDiagnosticChanged?.((diagnostic) => {
    if (diagnostic) blurDiagnostic.value = diagnostic
  })

  loadSchedulerHealth()
  _schedulerTimer = setInterval(loadSchedulerHealth, 10000)

  await nextTick()
  if (componentUnmounted) return
  openRaf = requestAnimationFrame(() => {
    openRaf = null
    if (!props.visible || componentUnmounted) return
    panelActive.value = true
    closeButtonRef.value?.focus({ preventScroll: true })
  })
})

onBeforeUnmount(() => {
  componentUnmounted = true
  stopBlurRuntimeListener?.()
  stopBlurRuntimeListener = null
  stopBlurDiagnosticListener?.()
  stopBlurDiagnosticListener = null
  stopRemoteHealthListener?.()
  stopRemoteHealthListener = null
  onDragEnd()
  // 正常关闭时这里已完成 flush；强制卸载时也不能丢失最后一次修改。
  flushPendingSettingSaves().catch((e) => console.warn('[SettingsPanel] 卸载前保存设置失败:', e))
  flushPendingBlurConfig()
  // 清理关闭动画定时器
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (blurReleaseTimer) {
    clearTimeout(blurReleaseTimer)
    blurReleaseTimer = null
  }
  if (openRaf) {
    cancelAnimationFrame(openRaf)
    openRaf = null
  }
  // 清理模糊同步定时器
  if (_blurSyncTimer) {
    clearTimeout(_blurSyncTimer)
    _blurSyncTimer = null
  }
  // 清理调度器健康检查定时器
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer)
    _schedulerTimer = null
  }
})

/** 清空除设置外的业务数据（便签/模板/标签/附件），保留 app_settings。 */
const onConfirmClearNoteData = async () => {
  try {
    await window.api.clearNoteData()
    showMessage('success', '便签数据已清空，设置已保留')
  } catch (e) {
    console.warn('[SettingsPanel] 清空便签数据失败:', e)
    showMessage('error', '清空便签数据失败，请重试', 4000)
  }
}

/** 清空设置表，并使用主进程返回的共享默认快照同步运行时和控件。 */
const onConfirmResetSettings = async () => {
  if (isResetting.value) return

  // 立即进入临界区：新的交互和 watcher 写入均被阻断；尚未触发的修改直接丢弃，
  // 已经发往主进程的写入则先等待完成，确保随后清表一定是最后一次持久化操作。
  isResetting.value = true
  _settingsSynced = false
  _blurSynced = false
  _autoStartSynced = false
  _autoStartRequestRevision += 1
  onDragEnd()
  clearPendingSettingSaves()
  cancelPendingBlurConfig()

  try {
    await waitForInFlightWrites()

    const snapshot = await window.api.resetSettings()
    assignSettingsSnapshot(snapshot)
    await nextTick()

    showMessage('success', '已恢复默认设置')
  } catch (e) {
    console.warn('[SettingsPanel] 恢复默认设置失败:', e)
    showMessage('error', '恢复默认设置失败，请重试', 4000)
    await loadSettingsSnapshot()
  } finally {
    _settingsSynced = true
    _blurSynced = true
    _autoStartSynced = true
    isResetting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rendered"
      class="settings-wrapper"
      :class="{ active: panelActive }"
      data-modal-layer="settings"
    >
      <!-- 遮罩层（已移除） -->

      <!-- 面板主体：直接使用全局霜层基准，不参与底层场景失焦。 -->
      <div
        ref="panelRef"
        class="settings-panel"
        :class="{ active: panelActive, 'is-resetting': isResetting }"
        :style="{ height: panelHeight + '%' }"
        :aria-busy="isResetting"
      >
        <!-- 顶部拖拽指示条（拖拽调整面板高度） -->
        <div
          class="drag-indicator"
          :class="{ 'is-disabled': isResetting }"
          @pointerdown="onDragStart"
          @pointermove="onDragMove"
          @pointerup="onDragEnd"
          @pointercancel="onDragEnd"
          @lostpointercapture="onDragEnd"
        >
          <div class="drag-bar" />
        </div>

        <!-- 面板头部 -->
        <div class="panel-header">
          <h2 class="panel-title">设置</h2>
          <span v-if="isResetting" class="panel-reset-status" role="status" aria-live="polite">
            正在恢复默认设置…
          </span>
          <button
            ref="closeButtonRef"
            class="panel-close-btn"
            title="关闭"
            :disabled="isResetting"
            @click="close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M1 1L13 13M1 13L13 1"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <!-- 面板内容（可滚动） -->
        <fieldset
          class="panel-body scroll-y settings-controls"
          :class="{ 'is-resetting': isResetting }"
          :disabled="isResetting"
          :inert="isResetting"
        >
          <!-- ========== 基础样式 ========== -->
          <section class="settings-section">
            <h3 class="section-title">基础样式</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >导航栏风格<HelpButton
                    text="只切换主窗口导航栏的布局和按钮外观，不改变关闭、置顶、锁定、循环模板、设置和帮助功能。"
                /></span>
              </div>
              <div class="titlebar-style-selector" role="radiogroup" aria-label="导航栏风格">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="titlebarStyle === 'apple'"
                  :class="{ active: titlebarStyle === 'apple' }"
                  @click="titlebarStyle = 'apple'"
                >
                  Apple
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-checked="titlebarStyle === 'microsoft'"
                  :class="{ active: titlebarStyle === 'microsoft' }"
                  @click="titlebarStyle = 'microsoft'"
                >
                  Microsoft
                </button>
              </div>
            </div>

            <!-- 背景颜色 -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >背景颜色<HelpButton
                    text="设置应用的基础背景色。它会参与主窗口玻璃着色、设置面板和浮动组件的背景计算；可选择预设色或输入十六进制颜色。"
                /></span>
              </div>
              <div class="setting-right">
                <button
                  v-for="c in hexPresets"
                  :key="c.value"
                  class="color-dot"
                  :class="{ active: bgColorHex === c.value }"
                  :style="{ backgroundColor: c.value }"
                  :title="c.label"
                  @click="setBgColorPreset(c.value)"
                />
                <input
                  type="color"
                  class="color-input"
                  :value="bgColorHex"
                  @input="
                    (e) => {
                      const h = e.target.value
                      const r = parseInt(h.slice(1, 3), 16)
                      const g = parseInt(h.slice(3, 5), 16)
                      const b = parseInt(h.slice(5, 7), 16)
                      bgColor = `${r} ${g} ${b}`
                    }
                  "
                />
                <div class="color-hex-input-wrap">
                  <input
                    type="text"
                    class="color-hex-input"
                    spellcheck="false"
                    :class="{ 'has-error': bgColorInputError }"
                    :value="bgColorInput"
                    placeholder="#FFFFFF"
                    maxlength="7"
                    @input="onBgColorInput"
                    @blur="commitBgColor"
                    @keydown.enter="commitBgColor"
                  />
                </div>
              </div>
            </div>

            <!-- 字体大小（输入 + 下拉预设） -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >字体大小<HelpButton
                    text="调整应用的全局基础字号，列表、设置和编辑区域会按同一比例联动。"
                /></span>
              </div>
              <div class="setting-right">
                <FontSizeInput
                  v-model="fontSizeBase"
                  :presets="fontSizePresets"
                  :min="14"
                  :max="22"
                  width="90rem"
                />
              </div>
            </div>

            <!-- 文字颜色 -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >文字颜色<HelpButton
                    text="设置应用的主要文字颜色，次要文字和边界颜色会基于它自动派生。"
                /></span>
              </div>
              <div class="setting-right">
                <button
                  v-for="c in hexPresets"
                  :key="c.value"
                  class="color-dot"
                  :class="{ active: textColor === c.value }"
                  :style="{ backgroundColor: c.value }"
                  :title="c.label"
                  @click="textColor = c.value"
                />
                <input v-model="textColor" type="color" class="color-input" />
                <div class="color-hex-input-wrap">
                  <input
                    type="text"
                    class="color-hex-input"
                    spellcheck="false"
                    :class="{ 'has-error': textColorInputError }"
                    :value="textColorInput"
                    placeholder="#000000"
                    maxlength="7"
                    @input="onTextColorInput"
                    @blur="commitTextColor"
                    @keydown.enter="commitTextColor"
                  />
                </div>
              </div>
            </div>
          </section>

          <!-- ========== 便利贴基础设置 ========== -->
          <section class="settings-section">
            <h3 class="section-title">便利贴</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >默认字体大小<HelpButton
                    text="只决定之后新建便利贴的初始字号，不会修改当前已经展示的便利贴。"
                /></span>
              </div>
              <div class="setting-right">
                <FontSizeInput
                  v-model="stickyFontSize"
                  :presets="stickyFontSizePresets"
                  :min="12"
                  :max="32"
                  width="90rem"
                />
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >默认背景颜色<HelpButton
                    text="新建便利贴会使用该背景色，并自动选择具有足够对比度的文字颜色。"
                /></span>
              </div>
              <div class="setting-right">
                <button
                  v-for="color in stickyColorPresets"
                  :key="color.value"
                  class="color-dot"
                  :class="{ active: stickyBackgroundColor === color.value }"
                  :style="{ backgroundColor: color.value }"
                  :title="color.label"
                  @click="stickyBackgroundColor = color.value"
                />
                <input v-model="stickyBackgroundColor" type="color" class="color-input" />
                <div class="color-hex-input-wrap">
                  <input
                    type="text"
                    class="color-hex-input"
                    spellcheck="false"
                    :class="{ 'has-error': stickyColorInputError }"
                    :value="stickyColorInput"
                    placeholder="#FFF2A8"
                    maxlength="7"
                    @input="onStickyColorInput"
                    @blur="commitStickyColor"
                    @keydown.enter="commitStickyColor"
                  />
                </div>
              </div>
            </div>

            <div class="setting-item setting-item-slider">
              <span class="setting-label"
                >默认圆角<HelpButton
                  text="设置新建便利贴的窗口圆角。0 为直角；圆角便利贴会使用透明窗口裁切。"
              /></span>
              <span class="range-label-start">直角</span>
              <AppSlider v-model="stickyCornerRadius" :min="0" :max="32" :step="1" />
              <span class="range-label-end">圆润</span>
              <span class="setting-value">{{ stickyCornerRadius }}px</span>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >默认置顶<HelpButton
                    text="开启后，之后新建的便利贴默认保持在其他窗口上方；仍可在单张便利贴上临时取消。"
                /></span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="stickyAlwaysOnTop" />
              </div>
            </div>
          </section>

          <!-- ========== 系统窗口模糊玻璃效果 ========== -->
          <section class="settings-section">
            <h3 class="section-title">窗口模糊玻璃与外观</h3>

            <!-- 启用开关（所有支持平台通用） -->
            <div v-if="blurCaps.supported" class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >启用毛玻璃<HelpButton
                    text="平台限制：Windows 需要 Windows 10 1903（Build 18362）或更高版本，支持调节模糊半径和饱和度；macOS 使用系统原生 Vibrancy，只支持开启或关闭，模糊半径和饱和度由系统决定，不能单独设置。玻璃浓度、背景颜色和窗口圆角在两个平台上都可以调节。关闭后不再渲染原生模糊层。"
                /></span>
                <span v-if="blurError" class="setting-error">
                  <svg
                    class="warn-icon"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" />
                    <path
                      d="M6 3.5v3"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                    />
                    <circle cx="6" cy="9" r="0.7" fill="currentColor" />
                  </svg>
                  {{ blurError }}
                </span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="blurEnabled" />
              </div>
            </div>

            <div v-else class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >系统毛玻璃不可用<HelpButton
                    text="当前系统版本或运行环境无法创建原生模糊层，应用会自动回退到背景颜色、玻璃浓度和圆角效果。"
                /></span>
                <span class="setting-error">当前系统将使用透明背景颜色和圆角回退</span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >运行诊断<HelpButton
                    text="毛玻璃诊断已注册到应用统一调度器：启动时执行一次，之后每分钟检查原生效果链、Overlay 和窗口同步状态。"
                /></span>
                <span class="setting-hint-caption">
                  {{ blurDiagnostic.message }}
                  <template v-if="blurDiagnostic.lastCheckedAt">
                    · {{ formatTickTime(blurDiagnostic.lastCheckedAt) }}
                  </template>
                </span>
              </div>
              <div class="setting-right">
                <span class="sched-badge" :class="blurDiagnosticMeta.className">
                  {{ blurDiagnosticMeta.label }}
                </span>
              </div>
            </div>

            <!-- 玻璃浓度始终显示；原生模糊不可用时也是主要回退控制。 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label"
                >玻璃浓度<HelpButton
                  text="控制主窗口背景颜色的覆盖强度。0=完全通透，1=不透明纯色底；不改变原生模糊强度。推荐60%"
              /></span>
              <span class="range-label-start">通透</span>
              <AppSlider v-model="windowOpacity" :min="0" :max="1" :step="0.01" />
              <span class="range-label-end">浓厚</span>
              <span class="setting-value">{{ Math.round(windowOpacity * 100) }}%</span>
            </div>

            <!-- 开启时：显示系统模糊设置（仅 Windows） -->
            <Transition
              :css="false"
              @enter="onNativeBlurOptionsEnter"
              @leave="onNativeBlurOptionsLeave"
            >
              <div
                v-if="blurCaps.supported && blurEnabled && blurCaps.platform === 'Windows'"
                class="native-blur-options"
              >
                <div class="native-blur-options-inner">
                  <!-- 模糊半径 -->
                  <div class="setting-item setting-item-slider">
                    <span class="setting-label"
                      >模糊半径<HelpButton text="控制背景被打散的程度。推荐值10–20"
                    /></span>
                    <span class="range-label-start">清晰</span>
                    <AppSlider v-model="blurRadius" :min="0" :max="40" :step="1" />
                    <span class="range-label-end">模糊</span>
                    <span class="setting-value">{{ blurRadius }} DIP</span>
                  </div>

                  <!-- 饱和度 -->
                  <div class="setting-item setting-item-slider">
                    <span class="setting-label"
                      >饱和度<HelpButton
                        text="模糊会让颜色变灰，提高饱和度能把鲜艳度补回来。推荐1.6–2.0（苹果用1.8）"
                    /></span>
                    <span class="range-label-start">黑白</span>
                    <AppSlider v-model="blurSaturation" :min="0" :max="2" :step="0.1" />
                    <span class="range-label-end">鲜艳</span>
                    <span class="setting-value">{{ blurSaturation.toFixed(1) }}x</span>
                  </div>
                </div>
              </div>
            </Transition>

            <!-- 窗口圆角（所有平台通用，纯 CSS 控制） -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label"
                >窗口圆角<HelpButton
                  text="四个角的圆润程度。0=直角，数值越大越圆。推荐8–16（苹果原生风格）"
              /></span>
              <span class="range-label-start">直角</span>
              <AppSlider v-model="blurCornerRadius" :min="0" :max="30" :step="1" />
              <span class="range-label-end">圆润</span>
              <span class="setting-value">{{ blurCornerRadius }}px</span>
            </div>

            <Transition name="wallpaper-panel">
              <WallpaperSettings v-if="!blurEnabled" />
            </Transition>
          </section>

          <!-- ========== CSS 玻璃全局基准 ========== -->
          <section class="settings-section">
            <h3 class="section-title">CSS 玻璃全局基准</h3>

            <!-- 模糊半径 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label"
                >模糊基准<HelpButton
                  text="所有界面内毛玻璃和弹窗背景按此值失焦，最低5px；C++原生窗口毛玻璃不受影响。推荐10px"
              /></span>
              <span class="range-label-start">清晰</span>
              <AppSlider v-model="cssBlur" :min="5" :max="30" :step="1" />
              <span class="range-label-end">模糊</span>
              <span class="setting-value">{{ cssBlur }}px</span>
            </div>

            <!-- 组件透明度 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label"
                >霜层基准<HelpButton
                  text="设置面板按此浓度显示；使用玻璃材质的浮层会按组件类型成比例调整并限制最大值。推荐20%"
              /></span>
              <span class="range-label-start">通透</span>
              <AppSlider v-model="cssOpacity" :min="0" :max="1" :step="0.01" />
              <span class="range-label-end">不透</span>
              <span class="setting-value">{{ Math.round(cssOpacity * 100) }}%</span>
            </div>
          </section>

          <!-- ========== 系统设置 ========== -->
          <section class="settings-section">
            <h3 class="section-title">系统设置</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >开机自启<HelpButton
                    text="控制应用是否随系统登录自动启动。此状态直接读取并写入操作系统，不保存在应用数据库中。"
                /></span>
                <span v-if="autoStartError" class="setting-error">
                  <svg
                    class="warn-icon"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" />
                    <path
                      d="M6 3.5v3"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linecap="round"
                    />
                    <circle cx="6" cy="9" r="0.7" fill="currentColor" />
                  </svg>
                  {{ autoStartError }}
                </span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="autoStart" />
              </div>
            </div>
          </section>

          <!-- ========== 远程服务与隐私 ========== -->
          <section class="settings-section">
            <h3 class="section-title">
              <span>远程服务与隐私</span>
              <span
                class="remote-health-badge sched-badge"
                :class="
                  remoteHealthStatus === 'available'
                    ? 'sched-badge--ok'
                    : remoteHealthStatus === 'checking'
                      ? ''
                      : 'sched-badge--warn'
                "
                :title="remoteHealthError || '本次启动时检测到远程服务正常'"
              >
                {{ remoteHealthLabel }}
              </span>
            </h3>
            <p v-if="remoteHealthStatus === 'skipped'" class="remote-health-message">
              本次启动未连接远程服务器；这里的修改将在下次启动时按新设置执行。
            </p>
            <p v-else-if="remoteHealthStatus === 'unavailable'" class="remote-health-message">
              本次启动连接远程服务器失败；这里的修改将在下次启动时按新设置执行。
            </p>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >接收软件通知<HelpButton
                    text="启动时联系远程服务并获取适用于当前系统的软件通知。关闭后不会请求新通知，已经保存的历史通知仍可查看。"
                /></span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="receiveRemoteNotices" />
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >检测设备基础信息<HelpButton
                    text="只记录基本的设备信息，不上传便签等敏感核心信息。用于判断用户数量与用户基本属性。"
                /></span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="uploadDeviceInfo" />
              </div>
            </div>

            <div class="setting-item setting-item-full">
              <BaseButton variant="default" style="width: 100%" @click="showNoticeHistory = true">
                查看全部通知
              </BaseButton>
            </div>
          </section>

          <!-- ========== 关于 ========== -->
          <section class="settings-section">
            <h3 class="section-title">关于</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >应用版本<HelpButton
                    text="当前安装或运行的应用版本，用于确认功能版本和排查兼容性问题。"
                /></span>
              </div>
              <div class="setting-right">
                <span class="setting-value">v{{ appVersion }}</span>
              </div>
            </div>

            <div class="setting-item setting-item-full setting-button-row">
              <BaseButton variant="default" @click="emit('check-update')">检查更新</BaseButton>
              <BaseButton variant="default" @click="showLogViewer = true">查看日志</BaseButton>
            </div>

            <div class="setting-item setting-item-full setting-button-row">
              <BaseButton variant="default" @click="showResetSettingsDialog = true">
                恢复默认设置
              </BaseButton>
              <BaseButton variant="default" @click="showClearNoteDataDialog = true">
                清空便签数据
              </BaseButton>
            </div>
          </section>

          <!-- ========== 调度器诊断 ========== -->
          <section v-if="schedulerHealth" class="settings-section">
            <h3 class="section-title">
              调度器诊断
              <button class="sched-refresh-btn" title="刷新" @click="loadSchedulerHealth">↻</button>
            </h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >调度器状态<HelpButton
                    text="显示后台定时任务调度器是否正在运行。调度器负责便签生效、提醒和循环模板等定时工作。"
                /></span>
              </div>
              <div class="setting-right">
                <span
                  class="sched-badge"
                  :class="
                    schedulerHealth.status === 'running' ? 'sched-badge--ok' : 'sched-badge--warn'
                  "
                >
                  {{ schedulerHealth.status === 'running' ? '● 运行中' : '○ 已停止' }}
                </span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >最近执行<HelpButton
                    text="后台调度器最近一次完成任务检查的时间；长时间不更新可能表示调度线程被阻塞。"
                /></span>
                <span class="setting-hint-caption">上次检查任务的时间</span>
              </div>
              <div class="setting-right">
                <span class="setting-value">
                  {{ formatTickTime(schedulerHealth.lastTickAt) }}
                  <span class="setting-hint-inline"
                    >（{{ tickTimeAgo(schedulerHealth.lastTickAt) }}）</span
                  >
                </span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >故障监控<HelpButton
                    text="独立看门狗会定期检查主调度器是否正常推进，并在检测到停滞时尝试恢复。"
                /></span>
                <span class="setting-hint-caption">独立计时器，检测调度器是否卡死</span>
              </div>
              <div class="setting-right">
                <span
                  class="sched-badge"
                  :class="schedulerHealth.watchdogRunning ? 'sched-badge--ok' : 'sched-badge--warn'"
                >
                  {{ schedulerHealth.watchdogRunning ? '● 活跃' : '○ 休眠' }}
                </span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >执行保护<HelpButton
                    text="防止上一轮任务尚未结束时再次进入调度流程，避免同一便签被重复处理或重复提醒。"
                /></span>
                <span class="setting-hint-caption">防止同一时刻重复执行</span>
              </div>
              <div class="setting-right">
                <span
                  class="sched-badge"
                  :class="!schedulerHealth.tickStuck ? 'sched-badge--ok' : 'sched-badge--danger'"
                >
                  {{ schedulerHealth.tickStuck ? '⚠ 阻塞中' : '● 空闲' }}
                </span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >调度计数<HelpButton
                    text="记录当前主调度器的运行代次；发生故障并重建调度循环后会进入下一轮。"
                /></span>
                <span class="setting-hint-caption">每发生一次故障恢复 +1</span>
              </div>
              <div class="setting-right">
                <span class="setting-value">第 {{ schedulerHealth.mainGeneration }} 轮</span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label"
                  >自动恢复<HelpButton
                    text="显示看门狗连续恢复失败的次数。数值持续增加时通常需要重启应用并检查错误日志。"
                /></span>
                <span class="setting-hint-caption">故障监控触发的恢复次数</span>
              </div>
              <div class="setting-right">
                <span
                  class="setting-value"
                  :class="{ 'sched-warn': schedulerHealth.recoveryFailures > 0 }"
                >
                  {{ schedulerHealth.recoveryFailures }} 次
                </span>
              </div>
            </div>

            <!-- 任务列表 -->
            <div v-if="schedulerHealth.tasks?.length" class="sched-tasks">
              <div class="sched-tasks-title">注册任务（{{ schedulerHealth.tasks.length }} 个）</div>
              <div
                v-for="task in schedulerHealth.tasks"
                :key="task.name"
                class="sched-task-card"
                :class="{ 'sched-task-card--disabled': task.disabled }"
              >
                <div class="sched-task-header">
                  <span class="sched-task-name">{{ task.name }}</span>
                  <span
                    v-if="task.disabled"
                    class="sched-badge sched-badge--danger"
                    title="连续失败 10 次已自动禁用"
                  >
                    ⚠ 已熔断
                  </span>
                  <span v-else class="sched-badge sched-badge--ok">正常</span>
                </div>
                <div class="sched-task-meta">失败次数：{{ task.failures }}</div>
                <div v-if="task.lastError" class="sched-task-error">{{ task.lastError }}</div>
              </div>
            </div>
          </section>
        </fieldset>
      </div>
    </div>

    <!-- 清空便签数据确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showClearNoteDataDialog"
      title="清空便签数据"
      message="此操作将清空所有便签、模板、标签和附件数据，设置不受影响。此操作不可撤销。"
      confirm-text="清空"
      cancel-text="取消"
      variant="danger"
      @confirm="onConfirmClearNoteData"
    />

    <!-- 恢复默认设置确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showResetSettingsDialog"
      title="恢复默认设置"
      message="此操作将清空设置表，并立即应用全局默认设置。当前窗口宽高会立即恢复默认，已保存的位置和大小也会被清除，但窗口位置不会立即移动；开机自启状态不受影响。"
      confirm-text="恢复"
      cancel-text="取消"
      variant="default"
      @confirm="onConfirmResetSettings"
    />
    <LogViewerDialog v-model:visible="showLogViewer" />
    <RemoteNoticeHistoryDialog v-model:visible="showNoticeHistory" />
  </Teleport>
</template>

<style scoped>
/* ---- 外层容器 ---- */
.settings-wrapper {
  position: fixed;
  inset: 0;
  z-index: 1000;
  /* 透明模态层接住面板外点击；底层 .app-scene 同时由 inert 阻断交互。 */
  pointer-events: auto;
  border-radius: var(--window-radius); /* 同步窗口圆角，裁剪面板直角 */
  overflow: hidden; /* 裁剪超出圆角的内容 */
}

/* 轻微压低底层对比度，避免便签文字透过玻璃抢占焦点。 */
.settings-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(18, 20, 24, 0.04);
  opacity: 0;
  transition: opacity 250ms ease;
  pointer-events: none;
}

.settings-wrapper.active::before {
  opacity: 1;
}

/* ---- 面板主体：设置页使用 1× 全局霜层基准 ---- */
.settings-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 70%;
  border-radius: 16rem 16rem 0 0;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
  transform: translateY(100%);
  transition:
    transform 350ms var(--ease-standard),
    filter 100ms ease-out;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: rgb(var(--bg-color) / var(--glass-opacity-base));
  border: 0;
}

.settings-panel.active {
  transform: translateY(0);
}

/* ---- 拖拽指示条（可拖拽调整面板高度） ---- */
.drag-indicator {
  display: flex;
  justify-content: center;
  padding: 10rem 0 4rem;
  flex-shrink: 0;
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}

.drag-indicator.is-disabled {
  cursor: wait;
  opacity: 0.45;
}
.drag-bar {
  width: 36rem;
  height: 4rem;
  border-radius: 2rem;
  background-color: rgba(255, 255, 255, 0.2);
  transition:
    transform var(--motion-control) var(--ease-standard),
    background-color var(--motion-fast) ease;
}
.drag-indicator:hover .drag-bar {
  transform: scaleX(1.18);
  background-color: rgba(255, 255, 255, 0.32);
}

/* ---- 面板头部 ---- */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4rem 20rem 14rem;
  flex-shrink: 0;
}
.panel-title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--text-color);
  letter-spacing: -0.2rem;
}
.panel-reset-status {
  margin-left: auto;
  margin-right: 10rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.panel-close-btn {
  width: 28rem;
  height: 28rem;
  border: none;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--text-color);
  opacity: 0.6;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.panel-close-btn:hover {
  background-color: rgba(255, 255, 255, 0.15);
  opacity: 1;
}
.panel-close-btn:active:not(:disabled) {
  transform: scale(0.9);
  transition-duration: 70ms;
}
.panel-close-btn:disabled {
  cursor: wait;
  opacity: 0.35;
}

/* ---- 面板内容区 ---- */
.panel-body {
  flex: 1;
  padding: 0 20rem 0;
  padding-bottom: 20rem;
  margin-bottom: 32rem; /* 底部留安全区，内容不贴边 */

  /* 阻止滚动链接：子元素滚到头不会导致父级抖动 */
  overscroll-behavior: contain;

  /* 底部内容渐隐，溢出时含蓄提示"下面还有" */
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.panel-body.is-resetting {
  cursor: wait;
  opacity: 0.55;
}
.panel-body {
  transition: opacity var(--motion-control) ease;
}
.settings-controls {
  min-inline-size: 0;
  border: 0;
}

/* ---- 设置分区 ---- */
.settings-section {
  margin-bottom: 16rem;
}
.settings-section:last-child {
  margin-bottom: 0;
}
.section-title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-color);
  text-transform: uppercase;
  letter-spacing: 0.5rem;
  margin-bottom: 8rem;
  padding-left: 2rem;
}

/* ---- 单条设置项（Flex 两列：左标签 + 右控件，space-between 平分多余空间）---- */
.setting-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  row-gap: 8rem;
  padding: 10rem 14rem;
  border-radius: 10rem;
  background-color: rgba(255, 255, 255, 0.04);
  margin-bottom: 4rem;
  transition: background-color 120ms ease;
}
.setting-item:hover {
  background-color: rgba(255, 255, 255, 0.07);
}

/* 原生模糊参数随启用状态平滑展开/收起；grid 可适应内容高度。 */
.native-blur-options {
  overflow: hidden;
}
.native-blur-options-inner {
  min-height: 0;
}
.wallpaper-panel-enter-active,
.wallpaper-panel-leave-active {
  overflow: hidden;
  transition:
    max-height 320ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 220ms ease,
    transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-top 280ms ease;
}
.wallpaper-panel-enter-active {
  max-height: 1200rem;
}
.wallpaper-panel-enter-from,
.wallpaper-panel-leave-to {
  max-height: 0;
  margin-top: 0;
  opacity: 0;
  transform: translateY(-6rem);
}
.wallpaper-panel-leave-from {
  max-height: 1200rem;
}

/* 有辅助文字时，左列顶部对齐 */
.setting-item.has-hint {
  align-items: start;
}

/* 按钮项占满宽度（单列） */
.setting-item.setting-item-full {
  display: flex;
}

/* 一行两个按钮：等宽平分 */
.setting-button-row {
  gap: 10rem;
}
.setting-button-row .base-btn {
  min-width: 0;
  flex: 1;
}

/* ---- 左侧区域（标签 + 提示）---- */
.setting-left {
  display: flex;
  flex-direction: column;
  gap: 3rem;
  min-width: 0;
  flex-shrink: 0;
}

/* ---- 右侧区域（控件容器）---- */
.setting-right {
  display: flex;
  align-items: center;
  gap: 10rem;
  flex-shrink: 0;
}

.titlebar-style-selector {
  display: grid;
  grid-template-columns: repeat(2, minmax(78rem, 1fr));
  gap: 2rem;
  padding: 2rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 10%, transparent);
  border-radius: 8rem;
  background-color: color-mix(in srgb, var(--text-color) 4%, transparent);
}
.titlebar-style-selector button {
  min-height: 28rem;
  padding: 0 10rem;
  border: 0;
  border-radius: 6rem;
  color: var(--text-color-secondary);
  background-color: transparent;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-control) var(--ease-standard),
    box-shadow var(--motion-control) var(--ease-standard),
    transform var(--motion-fast) ease;
}
.titlebar-style-selector button:hover:not(.active) {
  color: var(--text-color);
  background-color: color-mix(in srgb, var(--text-color) 6%, transparent);
}
.titlebar-style-selector button.active {
  color: var(--text-color);
  background-color: var(--surface-float);
  box-shadow: 0 1rem 4rem rgba(0, 0, 0, 0.16);
}
.titlebar-style-selector button:active {
  transform: scale(0.97);
}
.titlebar-style-selector button:focus-visible {
  outline: 2rem solid #0078d4;
  outline-offset: 1rem;
}

/* 滑块类设置项——单行水平布局：标签 ? 进度条 值 全在一行 */
.setting-item.setting-item-slider {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6rem;
}

/* 进度条自适应撑满剩余空间 */
.setting-item.setting-item-slider .slider-root {
  flex: 1;
  min-width: 50rem;
}

/* ---- 文字样式 ---- */
.setting-label {
  font-size: var(--fs-body);
  color: var(--text-color);
  display: inline-flex;
  align-items: center;
  gap: 6rem;
}

.setting-hint-caption {
  display: block;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.75);
  font-weight: 400;
  margin-top: 2rem;
  line-height: 1.3;
  opacity: 0.7;
}

.setting-value {
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  min-width: 40rem;
  text-align: right;
  flex-shrink: 0;
}

.setting-hint {
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  line-height: 1.5;
}

.remote-health-badge {
  padding: 0;
  margin-left: auto;
  border: 0;
  font: inherit;
  white-space: nowrap;
}

.remote-health-badge.sched-badge {
  padding: 2rem 8rem;
  font-size: calc(var(--fs-secondary) * 0.88);
}

.remote-health-message {
  margin: -2rem 2rem 6rem;
  color: rgb(255, 149, 0);
  font-size: calc(var(--fs-secondary) * 0.88);
  line-height: 1.4;
}

/* 持久错误提示（恒显示，不自动消失）—— Apple 风格：图标 + 文字 */
.setting-error {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  font-size: var(--fs-secondary);
  color: #ff3b30;
  line-height: 1.4;
}

/* 错误/警告图标（ⓘ 风格，复用于所有错误提示） */
.warn-icon {
  flex-shrink: 0;
}

/* ---- 滑块行各列按百分比 flex-basis 统一，保证所有进度条对齐 ---- */
/* 标题+问号：加宽并始终保留完整帮助按钮。 */
.setting-item.setting-item-slider .setting-label {
  flex: 0 0 27%;
  min-width: 0;
  overflow: visible;
  white-space: nowrap;
}
.setting-item.setting-item-slider .setting-label :deep(.help-btn-wrap) {
  flex: 0 0 auto;
}
/* 左/右范围标签：各固定 6%，空 span 也占位 */
.range-label-start,
.range-label-end {
  flex: 0 0 6%;
  text-align: center;
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  opacity: 0.55;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
/* 数值列：固定 12% */
.setting-item.setting-item-slider .setting-value {
  flex: 0 0 12%;
  min-width: 0;
}

/* ---- 预设色块 ---- */
.color-dot {
  width: 20rem;
  height: 20rem;
  border-radius: 50%;
  border: 2rem solid transparent;
  cursor: pointer;
  transition: transform 150ms ease;
  padding: 0;
  flex-shrink: 0;
}
.color-dot:hover:not(:disabled) {
  transform: scale(1.15);
}
.color-dot:disabled {
  opacity: 0.35;
  cursor: default;
}

/* ---- hex 颜色输入框 ---- */
.color-hex-input-wrap {
  display: flex;
  flex-direction: column;
}
.color-hex-input {
  /* 等宽字体：7 个字符宽度恒定，宽度用 7ch 刚好包住 #RRGGBB，不再留空 */
  width: calc(7ch + 22rem);
  padding: 5rem 8rem;
  border: 1rem solid transparent;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font-size: var(--fs-secondary);
  font-family: var(--font-family-mono);
  font-weight: 500;
  text-align: right;
  outline: none;
  transition: border-color 150ms ease;
}
.color-hex-input:focus {
  border-color: #0071e3;
}
.color-hex-input.has-error {
  border-color: rgba(255, 59, 48, 0.4);
}
.color-hex-input:disabled {
  opacity: 0.35;
  cursor: default;
}

/* ---- 颜色选择器 ---- */
.color-input {
  -webkit-appearance: none;
  appearance: none;
  width: 31rem;
  height: 31rem;
  border: 1rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-radius: 6rem;
  cursor: pointer;
  padding: 0;
  background: none;
  flex-shrink: 0;
}
.color-input::-webkit-color-swatch-wrapper {
  padding: 0;
}
.color-input::-webkit-color-swatch {
  border: none;
  border-radius: 5rem;
}

/* ---- 响应式：窗口很窄时堆叠为单列 ---- */
@media (max-width: 380px) {
  .setting-item {
    gap: 8rem;
  }
  .setting-item.has-hint {
    align-items: stretch;
  }
  .setting-item.setting-item-slider {
    gap: 8rem;
  }
}

/* ---- 滑动条（已由 AppSlider 组件接管）---- */

/* ---- 调度器诊断 ---- */
.section-title {
  display: flex;
  align-items: center;
  gap: 8rem;
}
.sched-refresh-btn {
  width: 22rem;
  height: 22rem;
  border: none;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.1);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-body) * 0.95);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 150ms ease;
  flex-shrink: 0;
}
.sched-refresh-btn:hover {
  background: rgba(128, 128, 128, 0.2);
  color: var(--text-color);
}
.sched-refresh-btn:active {
  transform: scale(0.92);
  transition: transform 70ms ease;
}
.setting-hint-inline {
  color: var(--text-color-secondary);
  font-weight: 400;
  font-size: calc(var(--fs-secondary) * 0.88);
}
/* 苹果风格淡染胶囊：背景为语义色极淡染，文字同色系 */
.sched-badge {
  font-size: calc(var(--fs-secondary) * 0.88);
  padding: 2rem 8rem;
  border-radius: 4rem;
  font-weight: 500;
}
.sched-badge--ok {
  background: rgba(52, 199, 89, 0.1);
  color: rgb(52, 199, 89);
}
.sched-badge--warn {
  background: rgba(255, 149, 0, 0.1);
  color: rgb(255, 149, 0);
}
.sched-badge--danger {
  background: rgba(255, 59, 48, 0.1);
  color: rgb(255, 59, 48);
}
.sched-warn {
  color: rgb(255, 149, 0);
}
.sched-tasks {
  margin-top: 12rem;
  display: flex;
  flex-direction: column;
  gap: 8rem;
}
.sched-tasks-title {
  font-size: var(--fs-secondary);
  font-weight: 600;
  color: var(--text-color-secondary);
  margin-bottom: 4rem;
}
.sched-task-card {
  padding: 10rem;
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.04);
  border: 1px solid rgba(128, 128, 128, 0.08);
}
.sched-task-card--disabled {
  opacity: 0.6;
  border-color: rgba(255, 59, 48, 0.2);
}
.sched-task-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4rem;
}
.sched-task-name {
  font-size: calc(var(--fs-secondary) * 0.95);
  font-weight: 600;
}
.sched-task-meta {
  font-size: calc(var(--fs-secondary) * 0.8);
  color: var(--text-color-secondary);
}
.sched-task-error {
  font-size: calc(var(--fs-secondary) * 0.78);
  color: rgb(255, 59, 48);
  margin-top: 4rem;
  padding: 4rem 6rem;
  background: rgba(255, 59, 48, 0.06);
  border-radius: 4rem;
  word-break: break-all;
}
</style>
