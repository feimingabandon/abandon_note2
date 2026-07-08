<script setup>
/**
 * DateTimePicker.vue
 *
 * 布局：dt-panel 固定宽高，内部 flex 2:7:1 分割上/中/下
 * 视图切换：v-show（DOM 常驻，布局已解好）
 * 滚动定位：nextTick + el.scrollTop = value（瞬间完成，不触发外层跳动）
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import TimeSpinner from './TimeSpinner.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '选择日期时间' },
  width: { type: [String, Number], default: '' },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  shortcuts: {
    type: Array,
    default: () => [
      { label: '今天', getValue: () => new Date() },
      { label: '昨天', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 1); return d } },
      { label: '一周前', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 7); return d } }
    ]
  }
})

const emit = defineEmits(['update:modelValue', 'change', 'clear'])

// ==================== 常量 ====================
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

// ==================== 状态 ====================
const open = ref(false)
const wrapperRef = ref(null)

const year = ref(new Date().getFullYear())
const month = ref(new Date().getMonth() + 1)
const day = ref(new Date().getDate())
const hour = ref(new Date().getHours())
const minute = ref(new Date().getMinutes())
const second = ref(new Date().getSeconds())

const viewYear = ref(year.value)
const viewMonth = ref(month.value - 1)
const currentView = ref('calendar')

// 可编辑输入框的临时值
const inputDate = ref('')
const inputTime = ref('')

// ==================== 计算属性 ====================
const displayText = computed(() => props.modelValue ? props.modelValue.replace('T', ' ') : props.placeholder)
const wrapperStyle = computed(() => props.width ? { width: typeof props.width === 'number' ? props.width + 'px' : props.width } : {})

const daysInMonth = computed(() => new Date(viewYear.value, viewMonth.value + 1, 0).getDate())
const firstDayOfWeek = computed(() => new Date(viewYear.value, viewMonth.value, 1).getDay())
const daysInPrevMonth = computed(() => new Date(viewYear.value, viewMonth.value, 0).getDate())

const calendarCells = computed(() => {
  const offset = firstDayOfWeek.value === 0 ? 6 : firstDayOfWeek.value - 1
  const total = daysInMonth.value
  const prev = daysInPrevMonth.value
  const today = new Date()
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
    c.push({
      day: d, type: t, month: cm, year: cy,
      isToday: cy === today.getFullYear() && cm === today.getMonth() && d === today.getDate(),
      isSelected: cy === year.value && cm === month.value - 1 && d === day.value
    })
  }
  return c
})

const dateDisplay = computed(() => `${year.value}-${pad(month.value)}-${pad(day.value)}`)
const timeDisplay = computed(() => `${pad(hour.value)}:${pad(minute.value)}:${pad(second.value)}`)
const yearMonthLabel = computed(() => `${viewYear.value}年 ${viewMonth.value + 1}月`)

// ==================== 工具函数 ====================
function pad(n) { return String(n).padStart(2, '0') }
function buildValue() { return `${year.value}-${pad(month.value)}-${pad(day.value)} ${pad(hour.value)}:${pad(minute.value)}:${pad(second.value)}` }
function setFromDate(d) {
  year.value = d.getFullYear(); month.value = d.getMonth() + 1; day.value = d.getDate()
  hour.value = d.getHours(); minute.value = d.getMinutes(); second.value = d.getSeconds()
}

function parseValue(val) {
  if (!val) return false
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return false
  year.value = parseInt(m[1]); month.value = parseInt(m[2]); day.value = parseInt(m[3])
  hour.value = parseInt(m[4]); minute.value = parseInt(m[5]); second.value = parseInt(m[6])
  return true
}

function resetToNow() {
  const n = new Date()
  year.value = n.getFullYear(); month.value = n.getMonth() + 1; day.value = n.getDate()
  hour.value = n.getHours(); minute.value = n.getMinutes(); second.value = n.getSeconds()
}

// ==================== 可编辑输入框 ====================
function onDateFocus() { inputDate.value = dateDisplay.value }
function onDateInput(e) { inputDate.value = e.target.value }
function onDateBlur() { commitDate() }
function onDateKeydown(e) { if (e.key === 'Enter') { commitDate(); e.target.blur() } }

function commitDate() {
  const raw = inputDate.value.trim()
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3])
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(y, mo, 0).getDate()) {
      year.value = y; month.value = mo; day.value = d
      viewYear.value = y; viewMonth.value = mo - 1
      return
    }
  }
  inputDate.value = dateDisplay.value
}

function onTimeFocus() { inputTime.value = timeDisplay.value }
function onTimeInput(e) { inputTime.value = e.target.value }
function onTimeBlur() { commitTime() }
function onTimeKeydown(e) { if (e.key === 'Enter') { commitTime(); e.target.blur() } }

function commitTime() {
  const raw = inputTime.value.trim()
  const m = raw.match(/^(\d{2}):(\d{2}):(\d{2})$/)
  if (m) {
    const h = parseInt(m[1]), mi = parseInt(m[2]), s = parseInt(m[3])
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59) {
      hour.value = h; minute.value = mi; second.value = s
      return
    }
  }
  inputTime.value = timeDisplay.value
}

// ==================== 同步外部值 ====================
watch(() => props.modelValue, (val) => { if (!parseValue(val)) resetToNow() }, { immediate: true })

// ==================== 日历导航 ====================
function prevYear() { viewYear.value-- }
function prevMonth() {
  if (viewMonth.value === 0) { viewMonth.value = 11; viewYear.value-- }
  else viewMonth.value--
}
function nextMonth() {
  if (viewMonth.value === 11) { viewMonth.value = 0; viewYear.value++ }
  else viewMonth.value++
}
function nextYear() { viewYear.value++ }
function goToToday() {
  const n = new Date()
  viewYear.value = n.getFullYear(); viewMonth.value = n.getMonth()
}

function selectDateCell(cell) {
  if (cell.type === 'prev') prevMonth()
  else if (cell.type === 'next') nextMonth()
  year.value = cell.year; month.value = cell.month + 1; day.value = cell.day
}

// ==================== 面板操作 ====================
function toggle() {
  if (props.disabled) return
  if (open.value) { open.value = false; return }
  if (!parseValue(props.modelValue)) resetToNow()
  viewYear.value = year.value; viewMonth.value = month.value - 1
  currentView.value = 'calendar'; open.value = true
}

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
  resetToNow()
}

function applyShortcut(sc) {
  const d = sc.getValue()
  if (!(d instanceof Date) || isNaN(d.getTime())) return
  setFromDate(d)
  viewYear.value = year.value; viewMonth.value = month.value - 1
  currentView.value = 'calendar'
}

function switchToTime() { currentView.value = 'time' }

// ==================== 点击外部关闭 ====================
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target)) return
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
})

// ==================== 下拉动画 ====================
function onBeforeEnter(el) { el.style.height = '0' }
function onEnter(el, done) {
  el.animate(
    [{ height: '0px' }, { height: el.scrollHeight + 'px' }],
    { duration: 350, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' }
  ).onfinish = () => {
    el.style.setProperty('height', 'auto', 'important')
    done()
  }
}
function onBeforeLeave(el) { el.style.height = el.scrollHeight + 'px' }
function onLeave(el, done) {
  el.animate(
    [{ height: el.scrollHeight + 'px' }, { height: '0px' }],
    { duration: 200, easing: 'cubic-bezier(0.42, 0, 1, 1)', fill: 'forwards' }
  ).onfinish = done
}
</script>

<template>
  <div ref="wrapperRef" class="dt-wrapper" :style="wrapperStyle">
    <button class="dt-trigger" :class="{ 'is-open': open, 'is-disabled': disabled }" :disabled="disabled" @click="toggle">
      <span class="dt-label" :class="{ 'is-placeholder': !modelValue }">{{ displayText }}</span>
      <button v-if="clearable && modelValue" class="dt-clear-btn" tabindex="-1" @click="doClear" title="清除">
        <svg width="10" height="10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>
      </button>
      <svg class="dt-arrow" :class="{ 'is-open': open }" width="10" height="6">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      </svg>
    </button>

    <Transition @before-enter="onBeforeEnter" @enter="onEnter" @before-leave="onBeforeLeave" @leave="onLeave">
      <div v-if="open" class="dt-panel-wrap app-bg" @click.stop>
        <div class="dt-panel">
          <!-- ===== 上：日期+时间可编辑区 ===== -->
          <div class="dt-time-header">
            <div class="dt-header-field" :class="{ active: currentView === 'calendar' }" @click="currentView = 'calendar'">
              <span class="dt-header-field-label">日期</span>
              <input class="dt-header-input" :value="inputDate || dateDisplay" @focus="onDateFocus" @input="onDateInput" @blur="onDateBlur" @keydown="onDateKeydown" placeholder="YYYY-MM-DD" />
            </div>
            <span class="dt-header-sep"/>
            <div class="dt-header-field" :class="{ active: currentView === 'time' }" @click="switchToTime">
              <span class="dt-header-field-label">时间</span>
              <input class="dt-header-input" :value="inputTime || timeDisplay" @focus="onTimeFocus" @input="onTimeInput" @blur="onTimeBlur" @keydown="onTimeKeydown" placeholder="HH:mm:ss" />
            </div>
          </div>
          <div class="dt-divider"/>

          <!-- ===== 中：内容区（v-show 保持 DOM 常驻） ===== -->
          <div class="dt-content">
            <div v-show="currentView === 'calendar'" class="dt-view">
              <div class="dt-header-nav">
                <button class="dt-nav-btn" title="上一年" @click="prevYear">
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                    <path d="M11 2L7 6l4 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                  </svg>
                </button>
                <button class="dt-nav-btn" title="上一月" @click="prevMonth">
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M7 2L3 5l4 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                  </svg>
                </button>
                <button class="dt-nav-label" @click="goToToday">{{ yearMonthLabel }}</button>
                <button class="dt-nav-btn" title="下一月" @click="nextMonth">
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                  </svg>
                </button>
                <button class="dt-nav-btn" title="下一年" @click="nextYear">
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                    <path d="M1 2l4 4-4 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
              <div class="dt-weekdays">
                <span v-for="w in WEEKDAYS" :key="w" class="dt-weekday">{{ w }}</span>
              </div>
              <div class="dt-calendar">
                <button v-for="(c, i) in calendarCells" :key="i" class="dt-cell" :class="{ 'is-other': c.type !== 'curr', 'is-today': c.isToday, 'is-sel': c.isSelected }" @click="selectDateCell(c)">
                  {{ c.day }}
                </button>
              </div>
            </div>

            <div v-show="currentView === 'time'" class="dt-view">
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

          <div class="dt-divider"/>

          <!-- ===== 下：按钮区 ===== -->
          <div class="dt-footer">
            <div class="dt-shortcuts">
              <button v-for="(sc, i) in shortcuts" :key="i" class="dt-sc-chip" @click="applyShortcut(sc)">{{ sc.label }}</button>
            </div>
            <div class="dt-footer-spacer"/>
            <button class="dt-btn dt-btn--now" @click="applyShortcut({ getValue: () => new Date() }); confirm()">此刻</button>
            <button class="dt-btn dt-btn--confirm" @click="confirm">确认</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ===== 容器 ===== */
.dt-wrapper { position: relative; display: inline-block; }

/* ===== 触发器 ===== */
.dt-trigger {
  display: flex; align-items: center; justify-content: space-between;
  gap: 6rem; width: 100%;
  padding: 5rem 8rem 5rem 10rem;
  font-size: inherit; font-family: inherit; color: var(--text-color);
  background-color: rgb(var(--bg-color)/var(--popup-opacity));
  border: 1rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-radius: 6rem; cursor: pointer; outline: none;
  transition: border-color 150ms ease;
}
.dt-trigger:hover:not(.is-disabled) { border-color: color-mix(in srgb, var(--text-color) 25%, transparent); }
.dt-trigger.is-open { border-color: color-mix(in srgb, var(--text-color) 30%, transparent); }
.dt-trigger.is-disabled { opacity: .4; cursor: not-allowed; }
.dt-label { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dt-label.is-placeholder { opacity: .4; }
.dt-clear-btn {
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  width: 16rem; height: 16rem; padding: 0;
  border: none; border-radius: 50%; background: transparent;
  color: var(--text-color-secondary); cursor: pointer;
  opacity: .5; transition: opacity 120ms ease, background-color 120ms ease;
}
.dt-clear-btn:hover { opacity: 1; background: rgba(128,128,128,.15); }
.dt-arrow { flex-shrink: 0; opacity: .45; color: var(--text-color); transition: transform 200ms ease; }
.dt-arrow.is-open { transform: rotate(180deg); }

/* ===== 面板 ===== */
.dt-panel-wrap {
  position: absolute; top: calc(100% + 4rem); left: 0; z-index: 100;
  border-radius: 10rem; box-shadow: 0 4rem 24rem rgba(0,0,0,.35);
  overflow: hidden;
}
.dt-panel { width: 320rem; height: 320rem; display: flex; flex-direction: column; }
.dt-divider { height: 1px; margin: 0; background: color-mix(in srgb, var(--text-color) 8%, transparent); flex-shrink: 0; }

/* ===== 上：time-header ===== */
.dt-time-header { display: flex; align-items: stretch; padding: 0; flex: 2; min-height: 0; }
.dt-header-field {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4rem;
  padding: 8rem 6rem; border: none; background: transparent;
  cursor: pointer; outline: none; transition: background-color 120ms ease;
}
.dt-header-field:hover { background: rgba(255,255,255,.06); }
.dt-header-field.active { background: rgba(255,255,255,.04); }
.dt-header-field-label { font-size: var(--fs-secondary); color: var(--text-color-secondary); font-weight: 500; }
.dt-header-input {
  width: 100%; padding: 2rem 4rem;
  font-size: var(--fs-body); font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  font-weight: 600; color: var(--text-color); background: transparent;
  border: 1px solid transparent; border-radius: 4rem; text-align: center; outline: none;
  transition: border-color 120ms ease;
}
.dt-header-input:focus { border-color: color-mix(in srgb, var(--text-color) 20%, transparent); background: rgba(255,255,255,.04); }
.dt-header-input::placeholder { color: var(--text-color-secondary); opacity: .4; }
.dt-header-sep { width: 1px; background: color-mix(in srgb, var(--text-color) 10%, transparent); flex-shrink: 0; }

/* ===== 中：内容区 ===== */
.dt-content { flex: 7; min-height: 0; display: flex; flex-direction: column; }
.dt-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ---- 日历 ---- */
.dt-header-nav { display: flex; align-items: center; justify-content: center; gap: 2rem; padding: 6rem 8rem 2rem; flex-shrink: 0; }
.dt-nav-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26rem; height: 26rem; border: none; border-radius: 6rem;
  background: transparent; color: var(--text-color-secondary); cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.dt-nav-btn:hover { background: rgba(255,255,255,.08); color: var(--text-color); }
.dt-nav-label {
  min-width: 100rem; padding: 3rem 6rem;
  font-size: var(--fs-body); font-family: inherit; font-weight: 600;
  color: var(--text-color); background: transparent; border: none; border-radius: 6rem;
  cursor: pointer; text-align: center; transition: background-color 120ms ease;
}
.dt-nav-label:hover { background: rgba(255,255,255,.06); }
.dt-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); padding: 2rem 8rem; flex-shrink: 0; }
.dt-weekday { text-align: center; font-size: var(--fs-secondary); color: var(--text-color-secondary); font-weight: 500; padding: 1rem 0; }
.dt-calendar { display: grid; grid-template-columns: repeat(7, 1fr); padding: 0 8rem 4rem; flex: 1; }
.dt-cell {
  display: flex; align-items: center; justify-content: center;
  font-size: var(--fs-secondary); font-family: inherit; font-weight: 500;
  color: var(--text-color); background: transparent; border: none; border-radius: 6rem;
  cursor: pointer; outline: none; transition: background-color 120ms ease, color 120ms ease;
}
.dt-cell:hover { background: rgba(255,255,255,.08); }
.dt-cell.is-other { color: var(--text-color-secondary); opacity: .4; }
.dt-cell.is-today { font-weight: 700; color: #0071e3; }
.dt-cell.is-sel { background: #0071e3; color: #fff; font-weight: 700; }
.dt-cell.is-sel:hover { background: #0077ed; }

/* ---- 时间滚轮 ---- */
.dt-time-picker { display: flex; padding: 8rem 8rem 0; gap: 0; flex: 1; min-height: 0; }
.dt-sp-col { flex: 1; display: flex; flex-direction: column; }
.dt-sp-label { text-align: center; font-size: var(--fs-secondary); color: var(--text-color-secondary); font-weight: 500; padding: 4rem 0 6rem; flex-shrink: 0; }

/* ===== 下：footer ===== */
.dt-footer { display: flex; align-items: center; gap: 6rem; padding: 8rem 10rem; flex: 1; min-height: 0; }
.dt-shortcuts { display: flex; flex-wrap: wrap; gap: 4rem; }
.dt-sc-chip {
  padding: 4rem 8rem; font-size: var(--fs-secondary); font-family: inherit; font-weight: 500;
  color: var(--text-color); background: rgba(255,255,255,.06);
  border: 1rem solid color-mix(in srgb, var(--text-color) 10%, transparent); border-radius: 14rem;
  cursor: pointer; outline: none; white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dt-sc-chip:hover { background: rgba(255,255,255,.12); border-color: color-mix(in srgb, var(--text-color) 20%, transparent); }
.dt-footer-spacer { flex: 1; }
.dt-btn {
  padding: 6rem 14rem; font-size: var(--fs-secondary); font-family: inherit; font-weight: 500;
  border: none; border-radius: 8rem; cursor: pointer; outline: none; white-space: nowrap;
  transition: background-color 150ms ease;
}
.dt-btn--now { color: #0071e3; background: rgba(0,113,227,.08); }
.dt-btn--now:hover { background: rgba(0,113,227,.16); }
.dt-btn--confirm { color: var(--text-color); background: #0071e3; }
.dt-btn--confirm:hover { background: #0077ed; }
</style>
