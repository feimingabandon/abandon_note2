<script setup>
/**
 * StyledSelect.vue — 自定义下拉选择组件
 *
 * 使用 Teleport to="body" + position:fixed 渲染下拉面板，
 *
 * Props:
 *   modelValue  — 当前选中值（v-model 绑定）
 *   options     — 选项数组 [{ label, value }]
 *   placeholder — 占位文本（默认 '-'）
 *   size        — 尺寸 sm / md / lg
 *   width       — 组件宽度（px 或 CSS 字符串）
 *   disabled    — 是否禁用
 *
 * Events:
 *   update:modelValue — v-model 更新
 *   change            — 选中变化，参数为 option 对象 { label, value }
 */

import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: '' },
  options: { type: Array, required: true },
  placeholder: { type: String, default: '-' },
  size: { type: String, default: '' },
  width: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

// ============ State ============
const open = ref(false)
const wrapperRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})

// ============ Computed ============
const displayLabel = computed(() => {
  const val = props.modelValue
  if (val === '' || val === null || val === undefined) return props.placeholder
  const opt = props.options.find((o) => o.value === val)
  return opt ? opt.label : props.placeholder
})

const sizeClass = computed(() => (props.size ? `sel--${props.size}` : ''))

const wrapperStyle = computed(() => {
  if (!props.width) return {}
  return { width: typeof props.width === 'number' ? props.width + 'px' : props.width }
})

// ============ Methods ============
function toggle() {
  if (props.disabled) return
  if (open.value) { open.value = false; return }
  updatePanelPosition()
  open.value = true
}

/** 计算面板 fixed 定位（对齐触发器左下角） */
function updatePanelPosition() {
  if (!wrapperRef.value) return
  const rect = wrapperRef.value.getBoundingClientRect()
  panelStyle.value = {
    position: 'fixed',
    top: (rect.bottom + 4) + 'px',
    left: rect.left + 'px',
    minWidth: rect.width + 'px',
    zIndex: 100
  }
}

function select(opt) {
  if (opt.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt)
  open.value = false
}

// ============ 下拉动画 ============
function onBeforeEnter(el) {
  el.style.height = '0'
}

function onEnter(el, done) {
  const h = el.scrollHeight
  el.animate([{ height: '0px' }, { height: h + 'px' }], {
    duration: 350,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'forwards'
  }).onfinish = () => {
    el.style.height = 'auto'
    done()
  }
}

function onBeforeLeave(el) {
  el.style.height = el.scrollHeight + 'px'
}

function onLeave(el, done) {
  el.animate([{ height: el.scrollHeight + 'px' }, { height: '0px' }], {
    duration: 200,
    easing: 'cubic-bezier(0.42, 0, 1, 1)',
    fill: 'forwards'
  }).onfinish = done
}

// 点击外部关闭
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target)) return
  if (panelRef.value?.contains(e.target)) return
  open.value = false
}

// 面板打开时监听窗口 resize，保持定位跟随
watch(open, (val) => {
  if (val) {
    nextTick(() => updatePanelPosition())
    window.addEventListener('resize', updatePanelPosition)
  } else {
    window.removeEventListener('resize', updatePanelPosition)
  }
})

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  window.removeEventListener('resize', updatePanelPosition)
})
</script>

<template>
  <div ref="wrapperRef" class="sel-wrapper" :class="sizeClass" :style="wrapperStyle">
    <!-- 触发器 -->
    <button
      class="sel-trigger"
      :class="{ 'is-open': open, 'is-disabled': disabled }"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="sel-label" :class="{ 'is-placeholder': !modelValue && modelValue !== 0 }">
        {{ displayLabel }}
      </span>
      <svg class="sel-arrow" :class="{ 'is-open': open }" width="10" height="6" aria-hidden="true">
        <path
          d="M1 1l4 4 4-4"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <Transition
        @before-enter="onBeforeEnter"
        @enter="onEnter"
        @before-leave="onBeforeLeave"
        @leave="onLeave"
      >
        <div v-if="open" ref="panelRef" class="sel-panel-wrap" :style="panelStyle" @click.stop>
          <div class="sel-panel-glass app-bg">
            <div class="sel-panel scroll-y">
              <button
                v-for="opt in options"
                :key="opt.value"
                class="sel-option"
                :class="{ 'is-active': modelValue === opt.value, 'is-disabled': opt.disabled }"
                :disabled="opt.disabled"
                @click="select(opt)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ============ 容器 ============ */
.sel-wrapper {
  display: inline-block;
}

/* ============ 触发器 ============ */
.sel-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  width: 100%;
  padding: 5rem 10rem;
  font-size: inherit;
  font-family: inherit;
  color: var(--text-color);
  background: rgba(255, 255, 255, 0.05);
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 6rem;
  cursor: pointer;
  outline: none;
  transition: border-color 150ms ease;
}
.sel-trigger:hover:not(.is-disabled) {
  border-color: rgba(255, 255, 255, 0.18);
}
.sel-trigger.is-open {
  border-color: rgba(255, 255, 255, 0.25);
}
.sel-trigger.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sel-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sel-label.is-placeholder {
  opacity: 0.4;
}

.sel-arrow {
  flex-shrink: 0;
  opacity: 0.45;
  color: var(--text-color);
  transition: transform 200ms ease;
}
.sel-arrow.is-open {
  transform: rotate(180deg);
}

/* ============ 下拉面板 ============ */
.sel-panel-wrap {
  border-radius: 10rem;
  box-shadow: 0 10rem 30rem rgba(0, 0, 0, 0.24);
  overflow: hidden;
}
.sel-panel-glass {
  --glass-opacity: var(--glass-select-opacity);
  --glass-blur: var(--glass-select-blur);
  min-width: 100%;
  border-radius: inherit;
}
.sel-panel {
  padding: 4rem 0;
  max-height: 256rem;
}

.sel-option {
  display: block;
  width: 100%;
  padding: 7rem 14rem;
  font-size: inherit;
  font-family: inherit;
  color: var(--text-color);
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  outline: none;
  transition: background-color 120ms ease;
}
.sel-option:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
.sel-option.is-active {
  color: #0071e3;
  background-color: rgba(0, 113, 227, 0.12);
  font-weight: 600;
}
.sel-option.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* ============ 尺寸变体 ============ */
.sel--sm,
.sel--sm .sel-trigger,
.sel--sm .sel-option {
  font-size: var(--fs-secondary);
}
.sel--md,
.sel--md .sel-trigger,
.sel--md .sel-option {
  font-size: var(--fs-secondary);
}
.sel--lg,
.sel--lg .sel-trigger,
.sel--lg .sel-option {
  font-size: var(--fs-body);
}
.sel--lg .sel-trigger {
  padding: 7rem 12rem;
}
.sel--lg .sel-option {
  padding: 9rem 16rem;
}
</style>
