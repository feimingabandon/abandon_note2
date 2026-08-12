<script setup>
/**
 * DateTimePicker.vue
 *
 * 布局：dt-panel 固定宽高，内部 flex 2:7:1 分割上/中/下
 * 视图切换：v-show（DOM 常驻，布局已解好）
 * 滚动定位：nextTick + el.scrollTop = value（瞬间完成，不触发外层跳动）
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import TimeSpinner from './TimeSpinner.vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '选择日期时间' },
  width: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  minDate: { type: Date, default: null },
  defaultTime: { type: String, default: '' },
  shortcuts: {
    type: Array,
    default: () => [
      { label: '今天', getValue: () => new Date() },
      {
        label: '昨天',
        getValue: () => {
          const d = new Date()
          d.setDate(d.getDate() - 1)
          return d
        }
      },
      {
        label: '一周前',
        getValue: () => {
          const d = new Date()
          d.setDate(d.getDate() - 7)
          return d
        }
      }
    ]
  }
})

const emit = defineEmits(['update:modelValue', 'change', 'clear'])

// ==================== 常量 ====================
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

// ==================== 状态 ====================
const open = ref(false)
const wrapperRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})

const year = ref(new Date().getFullYear())
const month = ref(new Date().getMonth() + 1)
const day = ref(new Date().getDate())
const hour = ref(new Date().getHours())
const minute = ref(new Date().getMinutes())
const second = ref(new Date().getSeconds())

const viewYear = ref(year.value)
const viewMonth = ref(month.value - 1)
const currentView = ref('calendar')
const calendarDirection = ref('next')

// 可编辑输入框的临时值
const inputDate = ref('')
const inputTime = ref('')

// ==================== 计算属性 ====================
const displayText = computed(() =>
  props.modelValue ? props.modelValue.replace('T', ' ') : props.placeholder
)
const wrapperStyle = computed(() =>
  props.width ? { width: typeof props.width === 'number' ? props.width + 'px' : props.width } : {}
)
const showClearAction = computed(() => props.clearable && !!props.modelValue)

const daysInMonth = computed(() => new Date(viewYear.value, viewMonth.value + 1, 0).getDate())
const firstDayOfWeek = computed(() => new Date(viewYear.value, viewMonth.value, 1).getDay())
const daysInPrevMonth = computed(() => new Date(viewYear.value, viewMonth.value, 0).getDate())

const calendarCells = computed(() => {
  const offset = firstDayOfWeek.value === 0 ? 6 : firstDayOfWeek.value - 1
  const total = daysInMonth.value
  const prev = daysInPrevMonth.value
  const today = new Date()
  // 日期下限（仅比较日期部分，忽略时分秒）
  const minDay = props.minDate
    ? new Date(props.minDate.getFullYear(), props.minDate.getMonth(), props.minDate.getDate())
    : null
  const c = []
  for (let i = 0; i < 42; i++) {
    const o = i - offset
    let d, t, cm, cy
    if (o < 0) {
      d = prev + o + 1
      t = 'prev'
      cm = viewMonth.value === 0 ? 11 : viewMonth.value - 1
      cy = viewMonth.value === 0 ? viewYear.value - 1 : viewYear.value
    } else if (o >= total) {
      d = o - total + 1
      t = 'next'
      cm = viewMonth.value === 11 ? 0 : viewMonth.value + 1
      cy = viewMonth.value === 11 ? viewYear.value + 1 : viewYear.value
    } else {
      d = o + 1
      t = 'curr'
      cm = viewMonth.value
      cy = viewYear.value
    }
    const cellDate = new Date(cy, cm, d)
    c.push({
      day: d,
      type: t,
      month: cm,
      year: cy,
      isToday: cy === today.getFullYear() && cm === today.getMonth() && d === today.getDate(),
      isSelected: cy === year.value && cm === month.value - 1 && d === day.value,
      isDisabled: minDay ? cellDate < minDay : false
    })
  }
  return c
})

const dateDisplay = computed(() => `${year.value}-${pad(month.value)}-${pad(day.value)}`)
const timeDisplay = computed(() => `${pad(hour.value)}:${pad(minute.value)}:${pad(second.value)}`)
const yearMonthLabel = computed(() => `${viewYear.value}年 ${viewMonth.value + 1}月`)

// ==================== 工具函数 ====================
function pad(n) {
  return String(n).padStart(2, '0')
}
function buildValue() {
  return `${year.value}-${pad(month.value)}-${pad(day.value)} ${pad(hour.value)}:${pad(minute.value)}:${pad(second.value)}`
}
function setFromDate(d) {
  year.value = d.getFullYear()
  month.value = d.getMonth() + 1
  day.value = d.getDate()
  hour.value = d.getHours()
  minute.value = d.getMinutes()
  second.value = d.getSeconds()
}

function parseDateTimeParts(val) {
  if (typeof val !== 'string') return null
  const match = val.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  const [parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute, parsedSecond] = parts
  if (
    parsedYear < 1900 ||
    parsedYear > 2100 ||
    parsedMonth < 1 ||
    parsedMonth > 12 ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59 ||
    parsedSecond < 0 ||
    parsedSecond > 59
  )
    return null
  const maxDay = new Date(parsedYear, parsedMonth, 0).getDate()
  if (parsedDay < 1 || parsedDay > maxDay) return null
  return parts
}

function parseValue(val) {
  const parts = parseDateTimeParts(val)
  if (!parts) return false
  ;[year.value, month.value, day.value, hour.value, minute.value, second.value] = parts
  return true
}

function parseClockTime(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''))
  if (!match) return null
  const parts = match.slice(1).map((part) => Number(part || 0))
  if (parts[0] > 23 || parts[1] > 59 || parts[2] > 59) return null
  return parts
}

function resetToDefault() {
  const n = new Date()
  year.value = n.getFullYear()
  month.value = n.getMonth() + 1
  day.value = n.getDate()
  const defaultTime = parseClockTime(props.defaultTime)
  hour.value = defaultTime?.[0] ?? n.getHours()
  minute.value = defaultTime?.[1] ?? n.getMinutes()
  second.value = defaultTime?.[2] ?? n.getSeconds()
}

// ==================== 可编辑输入框 ====================
function onDateFocus() {
  inputDate.value = dateDisplay.value
}
function onDateInput(e) {
  inputDate.value = e.target.value
}
function onDateBlur() {
  commitDate()
  inputDate.value = ''
}
function onDateKeydown(e) {
  if (e.key === 'Enter') {
    commitDate()
    e.target.blur()
  }
}

function commitDate() {
  const raw = inputDate.value.trim()
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const y = parseInt(m[1]),
      mo = parseInt(m[2]),
      d = parseInt(m[3])
    if (
      y >= 1900 &&
      y <= 2100 &&
      mo >= 1 &&
      mo <= 12 &&
      d >= 1 &&
      d <= new Date(y, mo, 0).getDate()
    ) {
      // 日期下限校验
      if (props.minDate) {
        const minDay = new Date(
          props.minDate.getFullYear(),
          props.minDate.getMonth(),
          props.minDate.getDate()
        )
        const inputDay = new Date(y, mo - 1, d)
        if (inputDay < minDay) {
          inputDate.value = dateDisplay.value
          return
        }
      }
      year.value = y
      month.value = mo
      day.value = d
      viewYear.value = y
      viewMonth.value = mo - 1
      return
    }
  }
  inputDate.value = dateDisplay.value
}

function onTimeFocus() {
  inputTime.value = timeDisplay.value
}
function onTimeInput(e) {
  inputTime.value = e.target.value
}
function onTimeBlur() {
  commitTime()
  inputTime.value = ''
}
function onTimeKeydown(e) {
  if (e.key === 'Enter') {
    commitTime()
    e.target.blur()
  }
}

function commitTime() {
  const raw = inputTime.value.trim()
  const m = raw.match(/^(\d{2}):(\d{2}):(\d{2})$/)
  if (m) {
    const h = parseInt(m[1]),
      mi = parseInt(m[2]),
      s = parseInt(m[3])
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59) {
      hour.value = h
      minute.value = mi
      second.value = s
      return
    }
  }
  inputTime.value = timeDisplay.value
}

// ==================== 同步外部值 ====================
watch(
  () => props.modelValue,
  (val) => {
    if (!parseValue(val)) resetToDefault()
  },
  { immediate: true }
)

// ==================== 触发器宽度自适应过渡 ====================
// displayText 变化时（占位文本 <-> 具体日期），测量新旧宽度并平滑伸缩
watch(displayText, async () => {
  const el = wrapperRef.value
  if (!el) return
  const from = el.offsetWidth
  await nextTick()
  const to = el.offsetWidth
  if (from === to) return
  el.animate([{ width: from + 'px' }, { width: to + 'px' }], {
    duration: 300,
    easing: 'cubic-bezier(0.2, 0, 0, 1)'
  })
})

// ==================== 日历导航 ====================
function prevYear() {
  calendarDirection.value = 'prev'
  viewYear.value--
}
function prevMonth() {
  calendarDirection.value = 'prev'
  if (viewMonth.value === 0) {
    viewMonth.value = 11
    viewYear.value--
  } else viewMonth.value--
}
function nextMonth() {
  calendarDirection.value = 'next'
  if (viewMonth.value === 11) {
    viewMonth.value = 0
    viewYear.value++
  } else viewMonth.value++
}
function nextYear() {
  calendarDirection.value = 'next'
  viewYear.value++
}
function goToToday() {
  const n = new Date()
  const current = viewYear.value * 12 + viewMonth.value
  const target = n.getFullYear() * 12 + n.getMonth()
  calendarDirection.value = target < current ? 'prev' : 'next'
  viewYear.value = n.getFullYear()
  viewMonth.value = n.getMonth()
}

function selectDateCell(cell) {
  if (cell.isDisabled) return
  if (cell.type === 'prev') prevMonth()
  else if (cell.type === 'next') nextMonth()
  year.value = cell.year
  month.value = cell.month + 1
  day.value = cell.day
}

// ==================== 面板操作 ====================
/** 计算面板 fixed 定位（相对于触发器元素） */
function updatePanelPosition() {
  if (!wrapperRef.value) return
  const rect = wrapperRef.value.getBoundingClientRect()
  let left = rect.left
  // 面板宽 320rem，防右侧溢出
  const remSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const panelW = 320 * remSize
  if (left + panelW > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - panelW - 8)
  }
  panelStyle.value = {
    position: 'fixed',
    top: rect.bottom + 4 + 'px',
    left: left + 'px',
    zIndex: 'var(--z-global-popover)'
  }
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    open.value = false
    return
  }
  if (!parseValue(props.modelValue)) resetToDefault()
  viewYear.value = year.value
  viewMonth.value = month.value - 1
  currentView.value = 'calendar'
  updatePanelPosition()
  open.value = true
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

function confirm() {
  const val = buildValue()
  emit('update:modelValue', val)
  emit('change', val)
  open.value = false
}

function doClear(e) {
  e.stopPropagation()
  emit('update:modelValue', '')
  emit('clear')
  resetToDefault()
}

function applyShortcut(sc) {
  const d = sc.getValue()
  if (!(d instanceof Date) || isNaN(d.getTime())) return
  setFromDate(d)
  viewYear.value = year.value
  viewMonth.value = month.value - 1
  currentView.value = 'calendar'
}

function applyNowAndConfirm() {
  applyShortcut({ getValue: () => new Date() })
  confirm()
}

function switchToTime() {
  currentView.value = 'time'
}

// ==================== 点击外部关闭 ====================
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target)) return
  if (panelRef.value?.contains(e.target)) return
  open.value = false
}

function onKeydown(e) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', updatePanelPosition)
})

function onEnter(el, done) {
  enterPopover(el, done, 'reveal')
}
function onLeave(el, done) {
  leavePopover(el, done, 'reveal')
}
</script>

<template>
  <div ref="wrapperRef" class="dt-wrapper" :style="wrapperStyle">
    <button
      class="dt-trigger"
      :class="{ 'is-open': open, 'is-disabled': disabled }"
      :disabled="disabled"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="dt-label" :class="{ 'is-placeholder': !modelValue }">{{ displayText }}</span>
      <svg
        class="dt-arrow"
        :class="{ 'is-open': open, 'is-concealed': showClearAction }"
        width="10"
        height="6"
      >
        <path
          d="M1 1l4 4 4-4"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <button
      class="dt-clear-btn"
      :class="{ 'is-visible': showClearAction }"
      :disabled="disabled || !showClearAction"
      :tabindex="showClearAction ? 0 : -1"
      :aria-hidden="!showClearAction"
      title="清除"
      aria-label="清除日期时间"
      @click="doClear"
    >
      <svg width="10" height="10">
        <path
          d="M1 1l8 8M9 1l-8 8"
          stroke="currentColor"
          stroke-width="1.2"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <Transition :css="false" @enter="onEnter" @leave="onLeave">
        <div v-if="open" ref="panelRef" class="dt-panel-wrap" :style="panelStyle" @click.stop>
          <div class="dt-panel-glass">
            <div class="dt-panel">
              <!-- ===== 上：日期+时间可编辑区 ===== -->
              <div class="dt-time-header">
                <div
                  class="dt-header-field"
                  :class="{ active: currentView === 'calendar' }"
                  @click="currentView = 'calendar'"
                >
                  <span class="dt-header-field-label">日期</span>
                  <input
                    class="dt-header-input"
                    :value="inputDate || dateDisplay"
                    placeholder="YYYY-MM-DD"
                    @focus="onDateFocus"
                    @input="onDateInput"
                    @blur="onDateBlur"
                    @keydown="onDateKeydown"
                  />
                </div>
                <span class="dt-header-sep" />
                <div
                  class="dt-header-field"
                  :class="{ active: currentView === 'time' }"
                  @click="switchToTime"
                >
                  <span class="dt-header-field-label">时间</span>
                  <input
                    class="dt-header-input"
                    :value="inputTime || timeDisplay"
                    placeholder="HH:mm:ss"
                    @focus="onTimeFocus"
                    @input="onTimeInput"
                    @blur="onTimeBlur"
                    @keydown="onTimeKeydown"
                  />
                </div>
              </div>
              <div class="dt-divider" />

              <!-- ===== 中：内容区（双视图常驻，通过透明度与水平位移切换） ===== -->
              <div class="dt-content">
                <div
                  class="dt-view dt-view--calendar"
                  :class="{ 'is-active': currentView === 'calendar' }"
                  :inert="currentView !== 'calendar'"
                  :aria-hidden="currentView !== 'calendar'"
                >
                  <div class="dt-header-nav">
                    <button class="dt-nav-btn" title="上一年" @click="prevYear">
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path
                          d="M8 2L4 6l4 4"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                        <path
                          d="M11 2L7 6l4 4"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                    <button class="dt-nav-btn" title="上一月" @click="prevMonth">
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path
                          d="M7 2L3 5l4 3"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                    <button class="dt-nav-label" @click="goToToday">{{ yearMonthLabel }}</button>
                    <button class="dt-nav-btn" title="下一月" @click="nextMonth">
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path
                          d="M3 2l4 3-4 3"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                    <button class="dt-nav-btn" title="下一年" @click="nextYear">
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path
                          d="M4 2l4 4-4 4"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                        <path
                          d="M1 2l4 4-4 4"
                          stroke="currentColor"
                          stroke-width="1.2"
                          fill="none"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                  <div class="dt-weekdays">
                    <span v-for="w in WEEKDAYS" :key="w" class="dt-weekday">{{ w }}</span>
                  </div>
                  <Transition :name="`dt-month-${calendarDirection}`" mode="out-in">
                    <div :key="`${viewYear}-${viewMonth}`" class="dt-calendar">
                      <button
                        v-for="(c, i) in calendarCells"
                        :key="i"
                        class="dt-cell"
                        :class="{
                          'is-other': c.type !== 'curr',
                          'is-today': c.isToday,
                          'is-sel': c.isSelected,
                          'is-disabled': c.isDisabled
                        }"
                        :disabled="c.isDisabled"
                        @click="selectDateCell(c)"
                      >
                        {{ c.day }}
                      </button>
                    </div>
                  </Transition>
                </div>

                <div
                  class="dt-view dt-view--time"
                  :class="{ 'is-active': currentView === 'time' }"
                  :inert="currentView !== 'time'"
                  :aria-hidden="currentView !== 'time'"
                >
                  <div class="dt-time-picker">
                    <div class="dt-sp-col">
                      <div class="dt-sp-label">时</div>
                      <TimeSpinner v-model="hour" :max="24" :visible="currentView === 'time'" />
                    </div>
                    <div class="dt-sp-col">
                      <div class="dt-sp-label">分</div>
                      <TimeSpinner v-model="minute" :max="60" :visible="currentView === 'time'" />
                    </div>
                    <div class="dt-sp-col">
                      <div class="dt-sp-label">秒</div>
                      <TimeSpinner v-model="second" :max="60" :visible="currentView === 'time'" />
                    </div>
                  </div>
                </div>
              </div>

              <div class="dt-divider" />

              <!-- ===== 下：按钮区 ===== -->
              <div class="dt-footer">
                <div class="dt-shortcuts">
                  <button
                    v-for="(sc, i) in shortcuts"
                    :key="i"
                    class="dt-sc-chip"
                    @click="applyShortcut(sc)"
                  >
                    {{ sc.label }}
                  </button>
                </div>
                <div class="dt-footer-spacer" />
                <button class="dt-btn dt-btn--now" @click="applyNowAndConfirm">此刻</button>
                <button class="dt-btn dt-btn--confirm" @click="confirm">确认</button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ===== 容器 ===== */
.dt-wrapper {
  position: relative;
  display: inline-block;
}

/* ===== 触发器 ===== */
.dt-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6rem;
  width: 100%;
  padding: 5rem 8rem 5rem 10rem;
  font-size: inherit;
  font-family: inherit;
  color: var(--text-color);
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  cursor: pointer;
  outline: none;
  transition: border-color 150ms ease;
}
.dt-trigger:hover:not(.is-disabled) {
  border-color: var(--ui-border-hover);
}
.dt-trigger.is-open {
  border-color: var(--ui-border-hover);
}
.dt-trigger.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dt-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dt-label.is-placeholder {
  opacity: 0.4;
}
.dt-clear-btn {
  position: absolute;
  right: 5rem;
  top: 50%;
  transform: translateY(-50%) scale(0.9);
  z-index: var(--z-local-content);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16rem;
  height: 16rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    background-color 120ms ease;
}
.dt-clear-btn.is-visible {
  opacity: 0.5;
  pointer-events: auto;
  transform: translateY(-50%) scale(1);
}
.dt-clear-btn.is-visible:hover {
  opacity: 1;
  background: var(--ui-fill-hover);
}
.dt-clear-btn:disabled {
  pointer-events: none;
}
.dt-arrow {
  flex-shrink: 0;
  opacity: 0.45;
  color: var(--text-color);
  transition:
    transform 200ms ease,
    opacity 120ms ease;
}
.dt-arrow.is-open {
  transform: rotate(180deg);
}
.dt-arrow.is-concealed {
  opacity: 0;
}

/* ===== 面板 ===== */
.dt-panel-wrap {
  border-radius: 10rem;
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.26);
  overflow: hidden;
  transform-origin: top center;
  will-change: clip-path, transform, opacity;
}
.dt-panel-glass {
  background-color: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
}
.dt-panel {
  width: 320rem;
  height: 320rem;
  display: flex;
  flex-direction: column;
}
.dt-divider {
  height: 1px;
  margin: 0;
  background: var(--ui-border-divider);
  flex-shrink: 0;
}

/* ===== 上：time-header ===== */
.dt-time-header {
  display: flex;
  align-items: stretch;
  padding: 0;
  flex: 2;
  min-height: 0;
}
.dt-header-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rem;
  padding: 8rem 6rem;
  border: none;
  background: transparent;
  cursor: pointer;
  outline: none;
  transition: background-color 120ms ease;
}
.dt-header-field:hover {
  background: var(--ui-surface-control);
}
.dt-header-field.active {
  background: var(--ui-surface-subtle);
}
.dt-header-field-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
}
.dt-header-input {
  width: 100%;
  padding: 2rem 4rem;
  font-size: var(--fs-body);
  font-family: var(--font-family-mono);
  font-weight: 600;
  color: var(--text-color);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4rem;
  text-align: center;
  outline: none;
  transition: border-color 120ms ease;
}
.dt-header-input:focus {
  border-color: var(--ui-border-hover);
  background: var(--ui-surface-subtle);
}
.dt-header-input::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.4;
}
.dt-header-sep {
  width: 1px;
  background: var(--ui-border-control);
  flex-shrink: 0;
}

/* ===== 中：内容区 ===== */
.dt-content {
  position: relative;
  flex: 7;
  min-height: 0;
  overflow: hidden;
}
.dt-view {
  position: absolute;
  inset: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 180ms ease,
    transform 240ms var(--ease-standard);
  will-change: opacity, transform;
}
.dt-view--calendar {
  transform: translateX(-10rem);
}
.dt-view--time {
  transform: translateX(10rem);
}
.dt-view.is-active {
  z-index: var(--z-local-content);
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

/* ---- 日历 ---- */
.dt-header-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2rem;
  padding: 6rem 8rem 2rem;
  flex-shrink: 0;
}
.dt-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26rem;
  height: 26rem;
  border: none;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.dt-nav-btn:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.dt-nav-label {
  min-width: 100rem;
  padding: 3rem 6rem;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 600;
  color: var(--text-color);
  background: transparent;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  text-align: center;
  transition: background-color 120ms ease;
}
.dt-nav-label:hover {
  background: var(--ui-surface-control);
}
.dt-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding: 2rem 8rem;
  flex-shrink: 0;
}
.dt-weekday {
  text-align: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
  padding: 1rem 0;
}
.dt-calendar {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding: 0 8rem 4rem;
  flex: 1;
}
.dt-month-next-enter-active,
.dt-month-next-leave-active,
.dt-month-prev-enter-active,
.dt-month-prev-leave-active {
  transition:
    opacity 150ms ease,
    transform var(--motion-control) var(--ease-standard);
}
.dt-month-next-enter-from,
.dt-month-prev-leave-to {
  opacity: 0;
  transform: translateX(8rem);
}
.dt-month-next-leave-to,
.dt-month-prev-enter-from {
  opacity: 0;
  transform: translateX(-8rem);
}
.dt-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  background: transparent;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  outline: none;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.dt-cell:hover {
  background: var(--ui-fill-hover);
}
.dt-cell.is-other {
  color: var(--text-color-secondary);
  opacity: 0.4;
}
.dt-cell.is-today {
  font-weight: 700;
  color: #0071e3;
}
.dt-cell.is-sel {
  background: #0071e3;
  color: #fff;
  font-weight: 700;
}
.dt-cell.is-sel {
  animation: dt-cell-select 180ms var(--ease-standard);
}
@keyframes dt-cell-select {
  from {
    transform: scale(0.86);
  }
  to {
    transform: scale(1);
  }
}
.dt-cell.is-sel:hover {
  background: #0077ed;
}
.dt-cell.is-disabled {
  opacity: 0.25;
  cursor: not-allowed;
  pointer-events: none;
}

/* ---- 时间滚轮 ---- */
.dt-time-picker {
  display: flex;
  padding: 8rem 8rem 0;
  gap: 0;
  flex: 1;
  min-height: 0;
}
.dt-sp-col {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.dt-sp-label {
  text-align: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
  padding: 4rem 0 6rem;
  flex-shrink: 0;
}

/* ===== 下：footer ===== */
.dt-footer {
  display: flex;
  align-items: center;
  gap: 6rem;
  padding: 8rem 10rem;
  flex: 1;
  min-height: 0;
}
.dt-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 4rem;
}
.dt-sc-chip {
  padding: 4rem 8rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 14rem;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}
.dt-sc-chip:hover {
  border-color: var(--ui-border-hover);
}
.dt-footer-spacer {
  flex: 1;
}
.dt-btn {
  padding: 6rem 14rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 8rem;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  transition: background-color 150ms ease;
}
.dt-btn--now {
  color: #0071e3;
  background: rgba(0, 113, 227, 0.08);
}
.dt-btn--now:hover {
  background: rgba(0, 113, 227, 0.16);
}
.dt-btn--confirm {
  color: var(--text-color);
  background: #0071e3;
}
.dt-btn--confirm:hover {
  background: #0077ed;
}
.dt-nav-btn:active,
.dt-sc-chip:active,
.dt-btn:active {
  transform: scale(0.98);
  transition-duration: 70ms;
}
</style>
