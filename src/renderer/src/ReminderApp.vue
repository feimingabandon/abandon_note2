<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import DateTimePicker from './components/ui/DateTimePicker.vue'
import { SNOOZE_MINUTES } from '../../shared/reminder-rules.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'

const rows = ref([])
const custom = reactive({})
const times = reactive({})
const busy = ref(null)
const message = ref('')
let stop = null
let lastFocusRequest = null
const hideAll = () => window.reminderAPI.hide()

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function accept(state) {
  rows.value = state.reminders
  applySettingsSnapshot(state.settings)
  const ids = new Set(rows.value.map((r) => r.id))
  for (const id of Object.keys(times))
    if (!ids.has(id)) {
      delete times[id]
      delete custom[id]
    }
  if (state.focusId && state.focusRequest !== lastFocusRequest) {
    lastFocusRequest = state.focusRequest
    custom[state.focusId] = true
    await nextTick()
    document.getElementById('reminder-' + state.focusId)?.scrollIntoView({ block: 'nearest' })
  }
}

async function act(row, action, minutes) {
  if (busy.value) return
  busy.value = row.id
  message.value = ''
  try {
    const result = await window.reminderAPI.action({
      id: row.id,
      action,
      minutes,
      ...(action === 'snooze' && minutes === undefined
        ? { dueAt: new Date(times[row.id]).getTime() }
        : {})
    })
    if (result.dueAt)
      message.value = `${result.created ? '已设置' : '已存在稍后提醒'}：${formatTime(result.dueAt)}`
  } catch (error) {
    message.value = error.message
  } finally {
    busy.value = null
  }
}

onMounted(async () => {
  stop = window.reminderAPI.onChanged((state) => void accept(state))
  try {
    await accept(await window.reminderAPI.getState())
    await window.reminderAPI.ready()
  } catch (error) {
    message.value = error.message
  }
})
onBeforeUnmount(() => stop?.())
</script>

<template>
  <main class="reminder-window">
    <header class="reminder-header">
      <h1>
        便签提醒 <span>{{ rows.length }}</span>
      </h1>
      <button
        aria-label="收起全部提醒"
        title="收起全部提醒，不影响已设置的稍后提醒"
        @click="hideAll"
      >
        ×
      </button>
    </header>
    <div class="reminder-list scroll-y" aria-label="待处理的便签提醒">
      <article v-for="row in rows" :id="'reminder-' + row.id" :key="row.id" class="reminder-card">
        <p class="reminder-time">
          {{ row.fromTemplate ? '循环便签' : '便签' }} · {{ formatTime(row.dueAt) }}
        </p>
        <p class="reminder-content">{{ row.content || '（空内容）' }}</p>
        <div class="reminder-options" aria-label="稍后提醒时间">
          <button
            v-for="minutes in SNOOZE_MINUTES"
            :key="minutes"
            :disabled="!!busy"
            @click="act(row, 'snooze', minutes)"
          >
            {{ minutes }} 分钟后
          </button>
        </div>
        <div class="reminder-actions">
          <button
            :aria-expanded="!!custom[row.id]"
            aria-haspopup="dialog"
            @click="custom[row.id] = !custom[row.id]"
          >
            自定义时间
          </button>
          <button :disabled="!!busy" @click="act(row, 'dismiss')">关闭本条</button>
        </div>
        <div v-if="custom[row.id]" class="reminder-custom">
          <DateTimePicker
            v-model="times[row.id]"
            :shortcuts="[]"
            :clearable="false"
            placeholder="选择下次提醒时间"
          />
          <button
            class="reminder-confirm"
            :disabled="!!busy || !times[row.id]"
            @click="act(row, 'snooze')"
          >
            稍后提醒
          </button>
        </div>
      </article>
      <p v-if="!rows.length" class="reminder-empty">当前没有待处理的提醒</p>
    </div>
    <p v-if="message" class="reminder-message" role="status" aria-live="polite">{{ message }}</p>
  </main>
</template>

<style>
/* This independent window uses the shared theme on an opaque reading surface. */
body {
  background: rgb(var(--bg-color));
  color: var(--text-color);
}
.reminder-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-size: var(--fs-body);
}
.reminder-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14rem 18rem;
  border-bottom: 1px solid var(--ui-border-divider);
  -webkit-app-region: drag;
}
.reminder-header h1 {
  font-size: var(--fs-body);
  font-weight: 600;
}
.reminder-header span {
  color: var(--ui-accent);
  margin-left: 8rem;
}
.reminder-header button {
  -webkit-app-region: no-drag;
  font-size: 24rem;
  padding: 0 8rem;
}
.reminder-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 18rem;
}
.reminder-card {
  padding: 18rem 0;
  border-bottom: 1px solid var(--ui-border-divider);
}
.reminder-time {
  opacity: 0.65;
  font-size: var(--fs-secondary);
  margin-bottom: 8rem;
}
.reminder-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 150rem;
  overflow-y: auto;
  line-height: 1.6;
}
.reminder-options,
.reminder-actions,
.reminder-custom {
  display: flex;
  flex-wrap: wrap;
  gap: 8rem;
  margin-top: 12rem;
}
.reminder-window button {
  cursor: pointer;
  font: inherit;
  color: inherit;
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  padding: 7rem 10rem;
}
.reminder-window button:hover {
  border-color: var(--ui-border-hover);
}
.reminder-window button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.reminder-window button:disabled {
  opacity: 0.45;
  cursor: default;
}
.reminder-actions {
  justify-content: space-between;
}
.reminder-window .reminder-confirm {
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  border-color: transparent;
}
.reminder-message,
.reminder-empty {
  padding: 12rem 18rem;
  font-size: var(--fs-secondary);
  overflow-wrap: anywhere;
}
.reminder-message {
  color: var(--ui-warning);
}
</style>
