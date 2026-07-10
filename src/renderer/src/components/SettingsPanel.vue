<script setup>
/**
 * SettingsPanel.vue — 底部弹出式设置面板
 *
 * 职责：
 *   1. 从主窗口底部向上滑入，占主窗口 70% 高度
 *   2. 使用 .app-bg 类继承全局玻璃态样式 + 单独阴影
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
import AppToggle from './AppToggle.vue'
import BaseButton from './BaseButton.vue'
import FontSizeInput from './FontSizeInput.vue'
import AppSlider from './AppSlider.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import HelpButton from './HelpButton.vue'
import { useMessage } from '../composables/useMessage.js' // 消息弹窗

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

const emit = defineEmits(['update:visible'])

const WINDOW_NAME = 'main'
const el = document.documentElement

// ---- 面板动画控制 ----
const rendered = ref(props.visible)
const panelActive = ref(false)
const panelRef = ref(null)
const panelHeight = ref(70) // 面板高度百分比，默认 70%

/** 关闭动画定时器 ID，用于取消竞态关闭 */
let closeTimer = null

// ---- 拖拽调整面板高度 ----
let isDragging = false
let dragStartY = 0
let dragStartHeight = 0
let dragRaf = null
const resizing = ref(false)

function onDragStart(e) {
  isDragging = true
  resizing.value = true
  dragStartY = e.clientY
  dragStartHeight = panelHeight.value
  if (panelRef.value) {
    panelRef.value.style.transition = 'none'
  }
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e) {
  if (!isDragging || !panelRef.value) return
  // RAF 节流：每帧只更新一次
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const wrapper = panelRef.value.parentElement
    const wrapperHeight = wrapper ? wrapper.getBoundingClientRect().height : window.innerHeight
    const deltaY = dragStartY - e.clientY
    const deltaPct = (deltaY / wrapperHeight) * 100
    let newHeight = dragStartHeight + deltaPct
    newHeight = Math.max(25, Math.min(95, newHeight))
    newHeight = Math.round(newHeight)
    // 直接操作 DOM 绕过 Vue 响应式
    panelRef.value.style.height = newHeight + '%'
    panelHeight.value = newHeight
  })
}

function onDragEnd() {
  isDragging = false
  resizing.value = false
  if (dragRaf) {
    cancelAnimationFrame(dragRaf)
    dragRaf = null
  }
  if (panelRef.value) {
    panelRef.value.style.transition = ''
    panelRef.value.style.height = panelHeight.value + '%'
  }
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

// 清理拖拽监听（组件卸载时）
onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
})

/** 点击面板外区域关闭（排除自身弹窗内的点击） */
const onDocClick = (e) => {
  if (!rendered.value || !panelActive.value) return
  // 点击在设置面板内部 → 不关闭
  if (panelRef.value && panelRef.value.contains(e.target)) return
  // 点击在 ConfirmDialog 弹窗内部 → 不关闭（弹窗通过 Teleport 渲染在 panelRef 之外）
  if (e.target.closest('.confirm-overlay')) return
  close()
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true))

const close = () => {
  panelActive.value = false
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
const bgColor = ref('255 255 255')
const bgBorder = ref(true)
const fontSizeBase = ref(18)
const textColor = ref('#000000')

/** 字体大小预设（datalist 选项） */
const fontSizePresets = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40]

/** 十六进制颜色预设（文字颜色 / 背景颜色共用） */
const hexPresets = [
  { label: '纯黑', value: '#000000' },
  { label: '纯白', value: '#ffffff' }
]

// ---- 文字颜色输入校验 ----
const textColorInput = ref('#000000')
const textColorInputError = ref(false)

// ---- 背景颜色 hex 显示与校验 ----
const bgColorHex = computed(() => {
  const parts = bgColor.value.split(' ').map(Number)
  if (parts.length !== 3) return '#ffffff'
  return (
    '#' + parts.map((p) => Math.min(255, Math.max(0, p)).toString(16).padStart(2, '0')).join('')
  )
})
const bgColorInput = ref('#ffffff')
const bgColorInputError = ref(false)

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

// ---- 窗口设置 ----
const autoStart = ref(false)
const autoStartError = ref(null) // 持久错误（null = 无错误），恒显示不自动消失

/** 开机自启状态是否已从 OS 同步完成（防止首次同步触发持久化） */
let _autoStartSynced = false

// ---- 系统模糊设置 ----
const blurCaps = ref({ supported: false, platform: '', strategy: 'none' })
const blurEnabled = ref(true) // 启用毛玻璃，默认开启
const blurError = ref(null) // 持久错误（如 DLL 未加载），恒显示不自动消失
const blurRadius = ref(15) // 模糊半径，默认 15，范围 0-100
const blurOpacity = ref(1.0) // 系统模糊层透明度，开启时默认 1.0
const blurTintR = ref(255)
const blurTintG = ref(255)
const blurTintB = ref(255)
const blurSaturation = ref(1.8)
const blurCornerRadius = ref(12)
let _blurSynced = false

// ---- 窗口透明度（仅系统模糊关闭时显示） ----
const windowOpacity = ref(0.5) // 默认 0.5 = 半透明

// ---- CSS 组件模糊设置 ----
const cssBlur = ref(5) // CSS 模糊半径，默认 5px
const cssOpacity = ref(0.5) // CSS 组件透明度，默认 50%
const cssSaturation = ref(1.8) // CSS 饱和度，默认 1.8
const blurTintHex = computed(() => {
  const r = blurTintR.value.toString(16).padStart(2, '0')
  const g = blurTintG.value.toString(16).padStart(2, '0')
  const b = blurTintB.value.toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
})
const blurTintInput = ref('#ffffff')
const blurTintInputError = ref(false)

// ---- 模糊着色：输入变更 ----
function onBlurTintInput(e) {
  blurTintInput.value = e.target.value
  if (blurTintInputError.value) blurTintInputError.value = false
}

// ---- 模糊着色：提交校验 ----
function commitBlurTint() {
  const val = blurTintInput.value.trim()
  if (val === '') {
    blurTintInput.value = blurTintHex.value
    return
  }
  if (isValidHex(val)) {
    const normalized = normalizeHex(val)
    const { r, g, b } = hexToRgb(normalized)
    blurTintR.value = r
    blurTintG.value = g
    blurTintB.value = b
    blurTintInput.value = normalized
    blurTintInputError.value = false
  } else {
    blurTintInput.value = blurTintHex.value
    showMessage('warning', '请输入有效的十六进制颜色值，如 #FFFFFF')
    blurTintInputError.value = true
  }
}

// ---- 模糊着色预设点击 ----
function setBlurTintPreset(hex) {
  const { r, g, b } = hexToRgb(hex)
  blurTintR.value = r
  blurTintG.value = g
  blurTintB.value = b
}

const { showMessage } = useMessage()

// ---- 确认弹窗状态 ----
const showResetDbDialog = ref(false)
const showResetUIDialog = ref(false)

watch(autoStart, async (v) => {
  if (!_autoStartSynced) return

  try {
    // 写入 OS + 数据库，并获取 OS 确认的真实状态
    const verified = await window.api.setAutoStart(v)

    if (verified === v) {
      // OS 确认成功 → 清除持久错误 + 成功 Toast
      autoStartError.value = null
      showMessage('success', v ? '开机自启已开启' : '开机自启已关闭')
    } else {
      // OS 状态与请求不符 → 回滚 UI + 持久错误
      autoStart.value = verified
      autoStartError.value = v
        ? '开启失败，请检查系统安全软件是否拦截了开机启动权限'
        : '关闭失败，请检查系统权限设置'
    }
  } catch (e) {
    console.warn('[SettingsPanel] 设置开机自启失败:', e)
    autoStartError.value = '设置失败，请重试'
  }
})

// ---- 防抖保存工具 ----
const debounceTimers = {}
function debouncedSave(type, key, value, remark = '') {
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    window.api.setSetting(WINDOW_NAME, type, key, String(value), remark)
  }, 300)
}

// ---- 实时生效 watchers ----

// 背景颜色 → CSS --bg-color (基础样式，主窗口+组件共用)
watch(bgColor, (v) => {
  el.style.setProperty('--bg-color', v)
  debouncedSave('css', 'bg_color', v, '背景颜色（十六进制，如 #ffffff）')
})

// ---- CSS 组件模糊：模糊半径 → CSS --bg-blur ----
watch(cssBlur, (v) => {
  el.style.setProperty('--bg-blur', v + 'px')
  debouncedSave('css', 'bg_blur', String(v), 'CSS 背景模糊半径（像素值，如 5）')
})

// ---- CSS 组件模糊：透明度 → CSS --popup-opacity ----
watch(cssOpacity, (v) => {
  el.style.setProperty('--popup-opacity', v)
  debouncedSave('css', 'win_opacity', v, '组件透明度（0~1 浮点数）')
})

// ---- CSS 组件模糊：饱和度 → CSS --bg-saturation ----
watch(cssSaturation, (v) => {
  el.style.setProperty('--bg-saturation', v)
  debouncedSave('css', 'bg_saturation', v, 'CSS 饱和度（0~2 浮点数）')
})

// ---- 窗口透明度 ----
watch(windowOpacity, (v) => {
  el.style.setProperty('--window-opacity', v)
  debouncedSave('css', 'window_opacity', v, '窗口透明度（0~1 浮点数）')
})

// ---- CSS 组件模糊：边框开关 → CSS --bg-border ----
watch(bgBorder, (v) => {
  el.style.setProperty('--bg-border', v ? '1' : '0')
  window.api.setSetting(
    WINDOW_NAME,
    'css',
    'bg_border',
    v ? '1' : '0',
    '边框显示开关（1=显示, 0=隐藏）'
  )
})

// 字体大小 → CSS --font-size-base
watch(fontSizeBase, (v) => {
  el.style.setProperty('--font-size-base', v + 'rem')
  debouncedSave('css', 'font_size_base', v, '基准字号（rem 单位数值）')
})

// 文字颜色 → CSS --text-color
watch(textColor, (v) => {
  el.style.setProperty('--text-color', v)
  debouncedSave('css', 'text_color', v, '文字颜色（十六进制，如 #333333）')
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

// 同步模糊着色输入显示值
watch(blurTintHex, (v) => {
  blurTintInput.value = v
  blurTintInputError.value = false
})

// ---- 系统模糊 watch（防抖发送到主进程） ----
function syncBlurConfig() {
  if (!_blurSynced) return
  window.api
    .setBlurConfig({
      enabled: blurEnabled.value,
      radius: blurRadius.value,
      opacity: blurOpacity.value,
      saturation: blurSaturation.value,
      cornerRadius: blurCornerRadius.value,
      tint: { r: blurTintR.value, g: blurTintG.value, b: blurTintB.value }
    })
    .catch((e) => console.warn('[SettingsPanel] 同步模糊配置失败:', e))
}

let _blurSyncTimer = null
function debouncedSyncBlur() {
  if (_blurSyncTimer) clearTimeout(_blurSyncTimer)
  _blurSyncTimer = setTimeout(syncBlurConfig, 150)
}

watch(blurEnabled, debouncedSyncBlur)
watch(blurRadius, debouncedSyncBlur)
watch(blurOpacity, debouncedSyncBlur)
watch(blurTintR, debouncedSyncBlur)
watch(blurTintG, debouncedSyncBlur)
watch(blurTintB, debouncedSyncBlur)
watch(blurSaturation, debouncedSyncBlur)
watch(blurCornerRadius, debouncedSyncBlur)
// 圆角 CSS 变量即时同步（不等防抖，视觉必须立即跟上）
watch(blurCornerRadius, (v) => {
  document.documentElement.style.setProperty('--window-radius', v + 'px')
})

// ---- 挂载时加载持久化设置 ----
onMounted(async () => {
  try {
    const cssSettings = await window.api.getSettings(WINDOW_NAME, 'css')
    cssSettings.forEach(({ key, value }) => {
      if (key === 'bg_color') bgColor.value = value
      else if (key === 'win_opacity') cssOpacity.value = parseFloat(value)
      else if (key === 'bg_blur') cssBlur.value = parseInt(value)
      else if (key === 'bg_saturation') cssSaturation.value = parseFloat(value)
      else if (key === 'window_opacity') windowOpacity.value = parseFloat(value)
      else if (key === 'bg_border') bgBorder.value = value === '1'
      else if (key === 'font_size_base') fontSizeBase.value = parseInt(value)
      else if (key === 'text_color') textColor.value = value
    })
  } catch (e) {
    console.warn('[SettingsPanel] 加载设置失败:', e)
  }

  // 校验开机自启（DB 为权威，同步 OS，失败则显示持久错误）
  try {
    _autoStartSynced = false
    const result = await window.api.verifyAutoStart()
    autoStart.value = result.value
    autoStartError.value = result.error
    await nextTick() // 等待 Vue watcher 冲刷完毕，避免首次赋值触发持久化
    _autoStartSynced = true
  } catch (e) {
    console.warn('[SettingsPanel] 校验开机自启失败:', e)
    _autoStartSynced = true // 即使失败也放开监听，允许用户手动切换
  }

  // 加载系统模糊配置
  try {
    blurCaps.value = await window.api.getBlurCapabilities()
    const savedBlur = await window.api.getBlurConfig()
    if (savedBlur) {
      blurEnabled.value = savedBlur.enabled ?? true
      blurRadius.value = savedBlur.radius ?? 10
      blurOpacity.value = savedBlur.opacity ?? 1.0
      blurSaturation.value = savedBlur.saturation ?? 1.8
      blurCornerRadius.value = savedBlur.cornerRadius ?? 12
      if (savedBlur.tint) {
        blurTintR.value = savedBlur.tint.r ?? 255
        blurTintG.value = savedBlur.tint.g ?? 255
        blurTintB.value = savedBlur.tint.b ?? 255
      }
    }
    _blurSynced = true
  } catch (e) {
    console.warn('[SettingsPanel] 加载模糊配置失败:', e)
    _blurSynced = true
  }

  // 校验毛玻璃运行时状态（DB 为权威，失败则显示持久错误）
  try {
    const result = await window.api.verifyBlurEnabled()
    if (result.error) {
      blurError.value = result.error
      blurEnabled.value = result.value // 使用实际状态（如 DLL 未加载 → false）
    }
  } catch (e) {
    console.warn('[SettingsPanel] 校验毛玻璃状态失败:', e)
  }

  // 启动调度器健康检查（每 10 秒刷新）
  loadSchedulerHealth()
  _schedulerTimer = setInterval(loadSchedulerHealth, 10000)
})

onBeforeUnmount(() => {
  // 清理所有待执行的防抖定时器，避免组件销毁后触发 IPC 写库
  Object.values(debounceTimers).forEach((t) => clearTimeout(t))
  // 清理关闭动画定时器
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
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

/** 确认重置数据库 —— 清空除设置外的所有业务数据（便签/模板/标签/附件），保留 app_settings */
const onConfirmResetDatabase = async () => {
  try {
    await window.api.resetDatabase()
    showMessage('success', '业务数据已重置，设置已保留')
  } catch (e) {
    console.warn('[SettingsPanel] 重置数据库失败:', e)
    showMessage('error', '重置数据库失败，请重试', 4000)
  }
}

/** 确认恢复默认设置 —— 重置 UI + 窗口几何，并将默认值持久化到数据库 */
const onConfirmResetUI = async () => {
  resetUI()
  try {
    await window.api.resetWindowGeometry()
  } catch (e) {
    console.warn('[SettingsPanel] 重置窗口几何失败:', e)
  }
  showMessage('success', '已恢复默认设置')
}

/** 恢复默认设置 —— 重置 UI + 同步模糊/自启 */
const resetUI = () => {
  bgColor.value = '255 255 255'
  cssOpacity.value = 0.5
  cssBlur.value = 5
  cssSaturation.value = 1.8
  windowOpacity.value = 0.5
  bgBorder.value = true
  fontSizeBase.value = 18
  textColor.value = '#000000'
  blurEnabled.value = true
  blurOpacity.value = 1.0
  blurRadius.value = 15
  blurTintR.value = 255
  blurTintG.value = 255
  blurTintB.value = 255
  blurSaturation.value = 1.8
  blurCornerRadius.value = 12
  autoStart.value = true
  // 清除所有持久错误
  autoStartError.value = null
  blurError.value = null
  textColorInputError.value = false
  bgColorInputError.value = false
  blurTintInputError.value = false
}
</script>

<template>
  <Teleport to="body">
    <div v-if="rendered" class="settings-wrapper">
      <!-- 遮罩层（已移除） -->

      <!-- 面板主体（玻璃态样式由 .app-bg 统一提供） -->
      <div
        ref="panelRef"
        class="settings-panel app-bg"
        :class="{ active: panelActive, 'is-resizing': resizing }"
        :style="{ height: panelHeight + '%' }"
      >
        <!-- 顶部拖拽指示条（拖拽调整面板高度） -->
        <div class="drag-indicator" @mousedown="onDragStart">
          <div class="drag-bar" />
        </div>

        <!-- 面板头部 -->
        <div class="panel-header">
          <h2 class="panel-title">设置</h2>
          <button class="panel-close-btn" title="关闭" @click="close">
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
        <div class="panel-body scroll-y">
          <!-- ========== 系统窗口模糊玻璃效果 ========== -->
          <section v-if="blurCaps.supported" class="settings-section">
            <h3 class="section-title">系统窗口模糊玻璃效果</h3>

            <!-- 启用开关（所有支持平台通用） -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">启用毛玻璃</span>
                <span v-if="blurError" class="setting-error">
                  <svg class="warn-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" />
                    <path d="M6 3.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                    <circle cx="6" cy="9" r="0.7" fill="currentColor" />
                  </svg>
                  {{ blurError }}
                </span>
              </div>
              <div class="setting-right">
                <AppToggle v-model="blurEnabled" />
              </div>
            </div>

            <!-- 窗口透明度（始终显示，控制主窗口背景） -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label">窗口透明度<HelpButton text="控制主窗口背景透明度。0=OS毛玻璃完全透出，1=不透明纯色底" /></span>
              <span class="range-label-start"></span>
              <AppSlider v-model="windowOpacity" :min="0" :max="1" :step="0.01" />
              <span class="range-label-end"></span>
              <span class="setting-value">{{ Math.round(windowOpacity * 100) }}%</span>
            </div>

            <!-- 开启时：显示系统模糊设置（仅 Windows） -->
            <template v-if="blurEnabled && blurCaps.platform === 'Windows'">
              <!-- 系统透明度 -->
              <div class="setting-item setting-item-slider">
                <span class="setting-label">系统透明度<HelpButton text="控制DComp模糊层的通透程度。1=不透明（最强模糊）" /></span>
                <span class="range-label-start"></span>
                <AppSlider v-model="blurOpacity" :min="0" :max="1" :step="0.01" />
                <span class="range-label-end"></span>
                <span class="setting-value">{{ Math.round(blurOpacity * 100) }}%</span>
              </div>

              <!-- 模糊半径 -->
              <div class="setting-item setting-item-slider">
                <span class="setting-label">模糊半径<HelpButton text="控制背景被打散的程度。推荐值10–20" /></span>
                <span class="range-label-start">清晰</span>
                <AppSlider v-model="blurRadius" :min="0" :max="100" :step="1" />
                <span class="range-label-end">模糊</span>
                <span class="setting-value">{{ blurRadius }} DIP</span>
              </div>

              <!-- 颜色 -->
              <div class="setting-item">
                <div class="setting-left">
                <span class="setting-label">颜色<HelpButton text="选中颜色如染色玻璃盖在模糊层上。白色≈无色叠加（推荐）" /></span>
                </div>
                <div class="setting-right">
                  <button
                    v-for="c in hexPresets" :key="c.value" class="color-dot"
                    :class="{ active: blurTintHex === c.value }"
                    :style="{ backgroundColor: c.value }" :title="c.label"
                    @click="setBlurTintPreset(c.value)"
                  />
                  <input type="color" class="color-input" :value="blurTintHex"
                    @input="(e) => { const h = e.target.value; blurTintR = parseInt(h.slice(1,3),16); blurTintG = parseInt(h.slice(3,5),16); blurTintB = parseInt(h.slice(5,7),16) }"
                  />
                  <div class="color-hex-input-wrap">
                    <input type="text" class="color-hex-input" spellcheck="false"
                      :class="{ 'has-error': blurTintInputError }" :value="blurTintInput"
                      placeholder="#FFFFFF" maxlength="7"
                      @input="onBlurTintInput" @blur="commitBlurTint" @keydown.enter="commitBlurTint"
                    />
                  </div>
                </div>
              </div>

              <!-- 饱和度 -->
              <div class="setting-item setting-item-slider">
                <span class="setting-label">饱和度<HelpButton text="模糊会让颜色变灰，提高饱和度能把鲜艳度补回来。推荐1.6–2.0（苹果用1.8）" /></span>
                <span class="range-label-start">黑白</span>
                <AppSlider v-model="blurSaturation" :min="0" :max="2" :step="0.1" />
                <span class="range-label-end">鲜艳</span>
                <span class="setting-value">{{ blurSaturation.toFixed(1) }}x</span>
              </div>
            </template>

            <!-- 窗口圆角（所有平台通用，纯 CSS 控制） -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label">窗口圆角<HelpButton text="四个角的圆润程度。0=直角，数值越大越圆。推荐8–16（苹果原生风格）" /></span>
              <span class="range-label-start">直角</span>
              <AppSlider v-model="blurCornerRadius" :min="0" :max="30" :step="1" />
              <span class="range-label-end">圆润</span>
              <span class="setting-value">{{ blurCornerRadius }}px</span>
            </div>
          </section>

          <!-- ========== CSS组件模糊玻璃效果 ========== -->
          <section class="settings-section">
            <h3 class="section-title">CSS组件模糊玻璃效果</h3>

            <!-- 模糊半径 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label">模糊半径<HelpButton text="控制弹窗、下拉框等浮动组件的背景模糊程度。推荐5px" /></span>
              <span class="range-label-start"></span>
              <AppSlider v-model="cssBlur" :min="0" :max="30" :step="1" />
              <span class="range-label-end"></span>
              <span class="setting-value">{{ cssBlur }}px</span>
            </div>

            <!-- 组件透明度 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label">组件透明度<HelpButton text="控制浮动组件的霜层厚薄。值越小越透，推荐50%" /></span>
              <span class="range-label-start"></span>
              <AppSlider v-model="cssOpacity" :min="0" :max="1" :step="0.01" />
              <span class="range-label-end"></span>
              <span class="setting-value">{{ Math.round(cssOpacity * 100) }}%</span>
            </div>

            <!-- 饱和度 -->
            <div class="setting-item setting-item-slider">
              <span class="setting-label">饱和度<HelpButton text="模糊会洗掉颜色，提高饱和度补偿回来。推荐1.6–2.0（苹果用1.8）" /></span>
              <span class="range-label-start">黑白</span>
              <AppSlider v-model="cssSaturation" :min="0" :max="2" :step="0.1" />
              <span class="range-label-end">鲜艳</span>
              <span class="setting-value">{{ cssSaturation.toFixed(1) }}x</span>
            </div>
          </section>

          <!-- ========== 基础样式 ========== -->
          <section class="settings-section">
            <h3 class="section-title">基础样式</h3>

            <!-- 背景颜色 -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">背景颜色</span>
              </div>
              <div class="setting-right">
                <button
                  v-for="c in hexPresets" :key="c.value" class="color-dot"
                  :class="{ active: bgColorHex === c.value }"
                  :style="{ backgroundColor: c.value }" :title="c.label"
                  @click="setBgColorPreset(c.value)"
                />
                <input type="color" class="color-input" :value="bgColorHex"
                  @input="(e) => { const h = e.target.value; const r = parseInt(h.slice(1,3),16); const g = parseInt(h.slice(3,5),16); const b = parseInt(h.slice(5,7),16); bgColor = `${r} ${g} ${b}` }"
                />
                <div class="color-hex-input-wrap">
                  <input type="text" class="color-hex-input" spellcheck="false"
                    :class="{ 'has-error': bgColorInputError }" :value="bgColorInput"
                    placeholder="#FFFFFF" maxlength="7"
                    @input="onBgColorInput" @blur="commitBgColor" @keydown.enter="commitBgColor"
                  />
                </div>
              </div>
            </div>

            <!-- 字体大小（输入 + 下拉预设） -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">字体大小</span>
              </div>
              <div class="setting-right">
                <FontSizeInput v-model="fontSizeBase" :presets="fontSizePresets" :min="12" :max="50" width="90rem" />
              </div>
            </div>

            <!-- 文字颜色 -->
            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">文字颜色</span>
              </div>
              <div class="setting-right">
                <button
                  v-for="c in hexPresets" :key="c.value" class="color-dot"
                  :class="{ active: textColor === c.value }"
                  :style="{ backgroundColor: c.value }" :title="c.label"
                  @click="textColor = c.value"
                />
                <input v-model="textColor" type="color" class="color-input" />
                <div class="color-hex-input-wrap">
                  <input type="text" class="color-hex-input" spellcheck="false"
                    :class="{ 'has-error': textColorInputError }" :value="textColorInput"
                    placeholder="#000000" maxlength="7"
                    @input="onTextColorInput" @blur="commitTextColor" @keydown.enter="commitTextColor"
                  />
                </div>
              </div>
            </div>
          </section>

          <!-- ========== 系统设置 ========== -->
          <section class="settings-section">
            <h3 class="section-title">系统设置</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">开机自启</span>
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

          <!-- ========== 关于 ========== -->
          <section class="settings-section">
            <h3 class="section-title">关于</h3>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">应用版本</span>
              </div>
              <div class="setting-right">
                <span class="setting-value">v1.0.0</span>
              </div>
            </div>

            <div class="setting-item setting-item-full">
              <BaseButton variant="danger" style="width: 100%" @click="showResetDbDialog = true">
                重置数据库
              </BaseButton>
            </div>

            <div class="setting-item setting-item-full">
              <BaseButton variant="default" style="width: 100%" @click="showResetUIDialog = true">
                恢复默认设置
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
                <span class="setting-label">调度器状态</span>
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
                <span class="setting-label">最近执行</span>
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
                <span class="setting-label">故障监控</span>
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
                <span class="setting-label">执行保护</span>
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
                <span class="setting-label">调度计数</span>
                <span class="setting-hint-caption">每发生一次故障恢复 +1</span>
              </div>
              <div class="setting-right">
                <span class="setting-value">第 {{ schedulerHealth.mainGeneration }} 轮</span>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-left">
                <span class="setting-label">自动恢复</span>
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
        </div>
      </div>
    </div>

    <!-- 重置数据库确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showResetDbDialog"
      title="重置数据库"
      message="此操作将清空所有便签、模板、标签和附件数据（直接物理删除），设置项（样式、窗口等）不受影响。此操作不可撤销。"
      confirm-text="重置"
      cancel-text="取消"
      variant="danger"
      @confirm="onConfirmResetDatabase"
    />

    <!-- 恢复默认设置确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showResetUIDialog"
      title="恢复默认设置"
      message="将所有样式（透明度、模糊、颜色、字体缩放等）恢复为默认值，并将窗口宽高重置为默认（屏幕 25% × 90%），同时保存到数据库。"
      confirm-text="恢复"
      cancel-text="取消"
      variant="default"
      @confirm="onConfirmResetUI"
    />
  </Teleport>
</template>

<style scoped>
/* ---- 外层容器 ---- */
.settings-wrapper {
  position: fixed;
  inset: 0;
  z-index: 1000;
  pointer-events: none;
  border-radius: var(--window-radius, 12px); /* 同步窗口圆角，裁剪面板直角 */
  overflow: hidden; /* 裁剪超出圆角的内容 */
}

/* ---- 遮罩层（已移除） ---- */

/* ---- 面板主体（玻璃态样式由 .app-bg 统一提供，此处仅保留位置/动画/阴影等独有样式） ---- */
.settings-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 70%;
  border-radius: 16rem 16rem 0 0;
  box-shadow: 0px -8px 32px 0px rgba(0, 0, 0, 0.37);
  transform: translateY(100%);
  transition: transform 350ms cubic-bezier(0.25, 0.1, 0.25, 1);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 拖拽时暂停 backdrop-filter 和 transition，避免卡顿 */
.settings-panel.is-resizing,
.settings-panel.is-resizing::before,
.settings-panel.is-resizing::after {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
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
}
.drag-bar {
  width: 36rem;
  height: 4rem;
  border-radius: 2rem;
  background-color: rgba(255, 255, 255, 0.2);
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
  transition: all 150ms ease;
}
.panel-close-btn:hover {
  background-color: rgba(255, 255, 255, 0.15);
  opacity: 1;
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
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
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

/* 有辅助文字时，左列顶部对齐 */
.setting-item.has-hint {
  align-items: start;
}

/* 按钮项占满宽度（单列） */
.setting-item.setting-item-full {
  display: flex;
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
/* 标题+问号：固定 22% */
.setting-item.setting-item-slider .setting-label {
  flex: 0 0 22%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  width: 90rem;
  padding: 5rem 8rem;
  border: 1rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font-size: var(--fs-secondary);
  font-family: inherit;
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
.setting-hint-inline {
  color: var(--text-color-secondary);
  font-weight: 400;
  font-size: calc(var(--fs-secondary) * 0.88);
}
/* 纯黑底 + 彩色文字：完全不透明，字在最暗底上最锐利 */
.sched-badge {
  font-size: calc(var(--fs-secondary) * 0.88);
  padding: 2rem 8rem;
  border-radius: 4rem;
  font-weight: 500;
  background: var(--text-color);
  opacity: 0.8;
}
.sched-badge--ok {
  color: rgb(52, 199, 89);
}
.sched-badge--warn {
  color: rgb(255, 149, 0);
}
.sched-badge--danger {
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
