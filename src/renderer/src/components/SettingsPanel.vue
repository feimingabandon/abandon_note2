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

import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import StyledSelect from './StyledSelect.vue'
import AppToggle from './AppToggle.vue'
import BaseButton from './BaseButton.vue'
import AppSlider from './AppSlider.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useMessage } from '../composables/useMessage.js' // 消息弹窗

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

/** 关闭动画定时器 ID，用于取消竞态关闭 */
let closeTimer = null

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
const winOpacity = ref(0.25) // 统一的窗口透明度（控制 CSS 层透明度）
const bgBlur = ref(10)
const bgBorder = ref(true)
const fontScale = ref(1)
const textColor = ref('#1d1d1f')

/** 字体缩放选项 */
const fontScaleOptions = [
  { label: '0.5x', value: 0.5 },
  { label: '0.75x', value: 0.75 },
  { label: '1x', value: 1 },
  { label: '1.25x', value: 1.25 },
  { label: '1.5x', value: 1.5 },
  { label: '1.75x', value: 1.75 },
  { label: '2x', value: 2 },
  { label: '2.5x', value: 2.5 },
  { label: '3x', value: 3 }
]

/** 预设背景色 */
const presetColors = [
  { label: '白', value: '255 255 255' },
  { label: '暖黄', value: '255 248 220' },
  { label: '薄荷', value: '220 255 240' },
  { label: '淡蓝', value: '220 240 255' },
  { label: '淡紫', value: '240 225 255' },
  { label: '深灰', value: '40 40 45' }
]

// ---- 窗口设置 ----
const autoStart = ref(false)

/** 开机自启状态是否已从 OS 同步完成（防止首次同步触发持久化） */
let _autoStartSynced = false

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
      // OS 确认成功 → 成功消息
      showMessage('success', v ? '开机自启已开启' : '开机自启已关闭')
    } else {
      // OS 状态与请求不符 → 错误消息 + 回滚 UI
      autoStart.value = verified
      showMessage('error', '设置失败，请检查系统权限后重试', 4000)
    }
  } catch (e) {
    console.warn('[SettingsPanel] 设置开机自启失败:', e)
    showMessage('error', '设置失败，请重试', 4000)
  }
})

// ---- 防抖保存工具 ----
const debounceTimers = {}
function debouncedSave(type, key, value) {
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    window.api.setSetting(WINDOW_NAME, type, key, String(value))
  }, 300)
}

// ---- 实时生效 watchers ----

// 背景颜色 → CSS --bg-color
watch(bgColor, (v) => {
  el.style.setProperty('--bg-color', v)
  debouncedSave('css', 'bg_color', v)
})

// 窗口透明度 → CSS --popup-opacity
watch(winOpacity, (v) => {
  el.style.setProperty('--popup-opacity', v)
  debouncedSave('css', 'win_opacity', v)
})

// 弹窗模糊 → CSS --bg-blur
watch(bgBlur, (v) => {
  el.style.setProperty('--bg-blur', v + 'px')
  debouncedSave('css', 'bg_blur', v + 'px')
})

// 边框开关 → CSS --bg-border
watch(bgBorder, (v) => {
  el.style.setProperty('--bg-border', v ? '1' : '0')
  window.api.setSetting(WINDOW_NAME, 'css', 'bg_border', v ? '1' : '0')
})

// 字体缩放 → CSS --font-scale
watch(fontScale, (v) => {
  el.style.setProperty('--font-scale', v)
  debouncedSave('css', 'font_scale', v)
})

// 文字颜色 → CSS --text-color
watch(textColor, (v) => {
  el.style.setProperty('--text-color', v)
  debouncedSave('css', 'text_color', v)
})

// ---- 挂载时加载持久化设置 ----
onMounted(async () => {
  try {
    const cssSettings = await window.api.getSettings(WINDOW_NAME, 'css')
    cssSettings.forEach(({ key, value }) => {
      if (key === 'bg_color') bgColor.value = value
      else if (key === 'win_opacity') winOpacity.value = parseFloat(value)
      else if (key === 'bg_blur') bgBlur.value = parseFloat(value)
      else if (key === 'bg_border') bgBorder.value = value === '1'
      else if (key === 'font_scale') fontScale.value = parseFloat(value)
      else if (key === 'text_color') textColor.value = value
    })

  } catch (e) {
    console.warn('[SettingsPanel] 加载设置失败:', e)
  }

  // 开机自启：从 OS 读取真实状态，若与数据库不一致自动同步
  try {
    _autoStartSynced = false
    autoStart.value = await window.api.getAutoStart()
    await nextTick() // 等待 Vue watcher 冲刷完毕，避免首次赋值触发持久化
    _autoStartSynced = true
  } catch (e) {
    console.warn('[SettingsPanel] 加载开机自启状态失败:', e)
    _autoStartSynced = true // 即使失败也放开监听，允许用户手动切换
  }
})

onBeforeUnmount(() => {
  // 清理所有待执行的防抖定时器，避免组件销毁后触发 IPC 写库
  Object.values(debounceTimers).forEach(t => clearTimeout(t))
  // 清理关闭动画定时器
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
})

/** 确认重置数据库 —— 清空所有持久化数据 + 同步重置 UI */
const onConfirmResetDatabase = async () => {
  try {
    await window.api.resetDatabase()
    resetUI() // 同步重置 UI 状态，使视觉变化与数据库清空保持一致
    showMessage('success', '数据库已重置')
  } catch (e) {
    console.warn('[SettingsPanel] 重置数据库失败:', e)
    showMessage('error', '重置数据库失败，请重试', 4000)
  }
}

/** 确认恢复默认设置 —— 仅重置 UI，不操作数据库 */
const onConfirmResetUI = () => {
  resetUI()
  showMessage('success', '已恢复默认设置')
}

/** 恢复默认设置 —— 仅重置 UI，不操作数据库 */
const resetUI = () => {
  bgColor.value = '255 255 255'
  winOpacity.value = 0.25
  bgBlur.value = 10
  bgBorder.value = true
  fontScale.value = 1
  textColor.value = '#1d1d1f'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="rendered" class="settings-wrapper">
      <!-- 遮罩层 -->
      <div
        class="settings-overlay"
        :class="{ active: panelActive }"
        @click="close"
      />

      <!-- 面板主体（玻璃态样式已内联到 .settings-panel + ::before，无需 .app-bg） -->
      <div class="settings-panel" :class="{ active: panelActive }">
        <!-- 顶部拖拽指示条 -->
        <div class="drag-indicator">
          <div class="drag-bar" />
        </div>

        <!-- 面板头部 -->
        <div class="panel-header">
          <h2 class="panel-title">设置</h2>
          <button class="panel-close-btn" @click="close" title="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 面板内容（可滚动） -->
        <div class="panel-body">
          <!-- ========== 基础样式修改 ========== -->
          <section class="settings-section">
            <h3 class="section-title">基础样式修改</h3>

            <!-- 窗口透明度（统一控制 CSS 层透明度） -->
            <div class="setting-item">
              <span class="setting-label">窗口透明度</span>
              <div class="setting-control">
                <AppSlider v-model="winOpacity" :min="0" :max="1" :step="0.01" />
                <span class="setting-value">{{ Math.round(winOpacity * 100) }}%</span>
              </div>
            </div>

            <!-- 弹窗模糊 -->
            <div class="setting-item">
              <span class="setting-label">弹窗模糊</span>
              <div class="setting-control">
                <AppSlider v-model="bgBlur" :min="0" :max="40" :step="1" />
                <span class="setting-value">{{ bgBlur }}px</span>
              </div>
            </div>

            <!-- 边框 -->
            <div class="setting-item">
              <span class="setting-label">边框</span>
              <AppToggle v-model="bgBorder" />
            </div>

            <!-- 字体缩放（下拉框） -->
            <div class="setting-item">
              <span class="setting-label">字体缩放</span>
              <div class="setting-control">
                <StyledSelect
                  v-model="fontScale"
                  :options="fontScaleOptions"
                  size="sm"
                  width="72rem"
                />
              </div>
            </div>

            <!-- 文字颜色 -->
            <div class="setting-item">
              <span class="setting-label">文字颜色</span>
              <div class="setting-control">
                <input type="color" class="color-input" v-model="textColor" />
                <span class="setting-value">{{ textColor }}</span>
              </div>
            </div>

            <!-- 背景颜色（预设 + 颜色选择器） -->
            <div class="setting-item">
              <span class="setting-label">背景颜色</span>
              <div class="bg-color-control">
                <div class="color-presets">
                  <button
                    v-for="c in presetColors"
                    :key="c.value"
                    class="color-dot"
                    :class="{ active: bgColor === c.value }"
                    :style="{ backgroundColor: `rgb(${c.value})` }"
                    :title="c.label"
                    @click="bgColor = c.value"
                  />
                </div>
                <input type="color" class="color-input" :value="`rgb(${bgColor})`"
                  @input="(e) => {
                    const hex = e.target.value
                    const r = parseInt(hex.slice(1,3), 16)
                    const g = parseInt(hex.slice(3,5), 16)
                    const b = parseInt(hex.slice(5,7), 16)
                    bgColor = `${r} ${g} ${b}`
                  }"
                />
              </div>
            </div>
          </section>

          <!-- ========== 系统设置 ========== -->
          <section class="settings-section">
            <h3 class="section-title">系统设置</h3>

            <div class="setting-item">
              <span class="setting-label">开机自启</span>
              <AppToggle v-model="autoStart" />
            </div>
          </section>

          <!-- ========== 关于 ========== -->
          <section class="settings-section">
            <h3 class="section-title">关于</h3>

            <div class="setting-item">
              <span class="setting-label">应用版本</span>
              <span class="setting-value">v1.0.0</span>
            </div>

            <div class="setting-item">
              <BaseButton variant="danger" @click="showResetDbDialog = true" style="width: 100%">
                重置数据库
              </BaseButton>
            </div>

            <div class="setting-item">
              <BaseButton variant="default" @click="showResetUIDialog = true" style="width: 100%">
                恢复默认设置
              </BaseButton>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 重置数据库确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showResetDbDialog"
      title="重置数据库"
      message="此操作将清空所有持久化数据（窗口位置、样式设置等），恢复为初始状态。此操作不可撤销。"
      confirm-text="重置"
      cancel-text="取消"
      variant="danger"
      @confirm="onConfirmResetDatabase"
    />

    <!-- 恢复默认设置确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showResetUIDialog"
      title="恢复默认设置"
      message="将所有样式（透明度、模糊、颜色、字体缩放等）恢复为默认值，不涉及数据库清空。"
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
  border-radius: 12px; /* 匹配窗口圆角，裁剪遮罩层和面板的直角 */
  overflow: hidden;    /* 裁剪超出圆角的内容 */
}

/* ---- 遮罩层 ---- */
.settings-overlay {
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0);
  transition: background-color 350ms ease;
  pointer-events: auto;
}
.settings-overlay.active {
  background-color: rgba(0, 0, 0, 0.25);
}

/* ---- 面板主体（.app-bg 继承全局玻璃态，单独加阴影） ---- */
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

  /* 从 .app-bg 继承背景色和边框，但 backdrop-filter 交给 ::before 伪元素 */
  background-color: rgb(var(--bg-color) / var(--popup-opacity));
  border: calc(var(--bg-border) * 1px) solid rgba(255, 255, 255, 0.18);
}

/* 固定模糊层：独立于滚动内容，避免滚动时每帧重算 blur */
.settings-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  -webkit-backdrop-filter: blur(var(--bg-blur)) saturate(180%) contrast(100%) brightness(100%);
  backdrop-filter: blur(var(--bg-blur)) saturate(180%) contrast(100%) brightness(100%);
  pointer-events: none;
  z-index: 0;
}

/* 确保内容在模糊层之上 */
.settings-panel > * {
  position: relative;
  z-index: 1;
}
.settings-panel.active {
  transform: translateY(0);
}

/* ---- 拖拽指示条 ---- */
.drag-indicator {
  display: flex;
  justify-content: center;
  padding: 10rem 0 4rem;
  flex-shrink: 0;
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
  font-size: 18rem;
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
  overflow-y: auto;
  padding: 0 20rem 0;
  margin-bottom: 32rem; /* 底部留安全区，内容不贴边 */

  /* GPU 层提升：将滚动区域独立到自己的合成层，避免滚动时触发父级 backdrop-filter 重绘 */
  will-change: transform;
  transform: translateZ(0);

  /* 阻止滚动链接 */
  overscroll-behavior: contain;

  /* 平滑滚动 */
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
}

/* ---- 设置分区 ---- */
.settings-section {
  margin-bottom: 24rem;
}
.settings-section:last-child {
  margin-bottom: 0;
}
.section-title {
  font-size: 12rem;
  font-weight: 600;
  color: var(--text-color);
  opacity: 0.38;
  text-transform: uppercase;
  letter-spacing: 0.5rem;
  margin-bottom: 12rem;
  padding-left: 2rem;
}

/* ---- 单条设置项 ---- */
.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12rem 14rem;
  border-radius: 10rem;
  background-color: rgba(255, 255, 255, 0.04);
  margin-bottom: 6rem;
  transition: background-color 120ms ease;
}
.setting-item:hover {
  background-color: rgba(255, 255, 255, 0.07);
}

.setting-label {
  font-size: 14rem;
  color: var(--text-color);
  flex-shrink: 0;
}
.setting-value {
  font-size: 13rem;
  color: var(--text-color);
  opacity: 0.5;
  min-width: 40rem;
  text-align: right;
  flex-shrink: 0;
}
.setting-control {
  display: flex;
  align-items: center;
  gap: 10rem;
}

/* ---- 背景颜色控制区（预设 + 颜色选择器） ---- */
.bg-color-control {
  display: flex;
  align-items: center;
  gap: 8rem;
}

/* ---- 预设色块 ---- */
.color-presets {
  display: flex;
  gap: 6rem;
}
.color-dot {
  width: 20rem;
  height: 20rem;
  border-radius: 50%;
  border: 2rem solid transparent;
  cursor: pointer;
  transition: all 150ms ease;
  padding: 0;
  flex-shrink: 0;
}
.color-dot:hover {
  transform: scale(1.15);
}
.color-dot.active {
  border-color: #0071e3;
  box-shadow: 0 0 0 2rem rgba(0, 113, 227, 0.3);
}

/* ---- 颜色选择器 ---- */
.color-input {
  -webkit-appearance: none;
  appearance: none;
  width: 28rem;
  height: 28rem;
  border: none;
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
  border: 1rem solid rgba(255, 255, 255, 0.15);
  border-radius: 6rem;
}

/* ---- 滑动条（已由 AppSlider 组件接管） ---- */
</style>
