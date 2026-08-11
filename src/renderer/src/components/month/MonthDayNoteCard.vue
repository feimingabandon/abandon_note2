<script setup>
import { computed, ref } from 'vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { useMessage } from '../../composables/useMessage.js'

const props = defineProps({ note: { type: Object, required: true } })
const emit = defineEmits(['edit'])
const { showMessage } = useMessage()
const busy = ref(false)
const earlyStartVisible = ref(false)
const deleteVisible = ref(false)

const statusLabel = computed(
  () =>
    ({ initialized: '待生效', in_progress: '进行中', completed: '已完成' })[props.note.status] ||
    props.note.status
)
const statusActionLabel = computed(
  () =>
    ({ initialized: '提前执行', in_progress: '完成', completed: '重新进行' })[props.note.status] ||
    ''
)
const earlyStartMessage = computed(() => {
  const duration = Math.max(1, Number(props.note.duration_days) || 1)
  return duration > 1
    ? `该便签持续 ${duration} 天。提前执行后，月历连续日期会从今天重新计算。是否确认？`
    : '提前执行后，生效时间会改为当前时间。是否确认？'
})
const effectiveLabel = computed(() => {
  const date = new Date(Number(props.note.effective_at))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
})

async function run(action, successText) {
  if (busy.value) return
  busy.value = true
  try {
    const result = await action()
    if (!result) throw new Error('操作未生效，便签可能已被修改')
    if (successText) showMessage('success', successText)
  } catch (error) {
    console.error('[MonthDayNoteCard] 操作失败:', error)
    showMessage('error', error.message || '操作失败，请重试')
  } finally {
    busy.value = false
  }
}

function requestStatusAction() {
  if (props.note.status === 'initialized') {
    earlyStartVisible.value = true
    return
  }
  void executeStatusAction()
}

function confirmEarlyStart() {
  void executeStatusAction()
}

async function executeStatusAction() {
  if (props.note.status === 'initialized') {
    await run(() => window.api.startProgress(props.note.id), '便签已提前执行')
  } else if (props.note.status === 'in_progress') {
    await run(() => window.api.completeNote(props.note.id), '便签已完成')
  } else if (props.note.status === 'completed') {
    await run(() => window.api.reopenNote(props.note.id), '便签已重新进行')
  }
}

function togglePinned() {
  void run(
    () => window.api.updateNote(props.note.id, { is_pinned: props.note.is_pinned ? 0 : 1 }),
    props.note.is_pinned ? '已取消置顶' : '已置顶'
  )
}

async function copyContent() {
  try {
    await navigator.clipboard.writeText(String(props.note.content || ''))
    showMessage('success', '便签正文已复制')
  } catch {
    showMessage('error', '复制失败，请重试')
  }
}

async function createSticky() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.api.createSticky(props.note.id)
    if (!result?.ok) throw new Error(result?.message || '无法贴到桌面')
    showMessage('success', '已贴到桌面')
  } catch (error) {
    showMessage('error', error.message || '无法贴到桌面')
  } finally {
    busy.value = false
  }
}

function confirmDelete() {
  void run(() => window.api.deleteNote(props.note.id), '便签已删除')
}
</script>

<template>
  <article class="month-note-card" :class="`is-${note.status}`" :data-note-id="note.id">
    <header>
      <span class="month-note-card__status">{{ statusLabel }}</span>
      <time>{{ effectiveLabel }}</time>
      <span v-if="note.duration_days > 1">持续 {{ note.duration_days }} 天</span>
    </header>
    <p>{{ note.content }}</p>
    <div v-if="note.tags?.length" class="month-note-card__tags">
      <span
        v-for="tag in note.tags"
        :key="tag.name"
        :style="{ '--tag-color': tag.color || '#8e8e93' }"
        >{{ tag.name }}</span
      >
    </div>
    <footer>
      <button type="button" :disabled="busy" @click="requestStatusAction">
        {{ statusActionLabel }}
      </button>
      <button type="button" :disabled="busy" @click="emit('edit', note)">修改</button>
      <button type="button" :disabled="busy" @click="togglePinned">
        {{ note.is_pinned ? '取消置顶' : '置顶' }}
      </button>
      <button type="button" @click="copyContent">复制</button>
      <button type="button" :disabled="busy" @click="createSticky">贴桌面</button>
      <button type="button" class="is-danger" :disabled="busy" @click="deleteVisible = true">
        删除
      </button>
    </footer>

    <ConfirmDialog
      v-model:visible="earlyStartVisible"
      title="确认提前执行"
      :message="earlyStartMessage"
      confirm-text="提前执行"
      @confirm="confirmEarlyStart"
    />
    <ConfirmDialog
      v-model:visible="deleteVisible"
      title="删除便签"
      message="便签会从列表和月视图中移除，确定继续吗？"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </article>
</template>

<style scoped>
.month-note-card {
  padding: 11rem;
  border: 1px solid var(--ui-border-divider);
  border-left: 3rem solid #ff9f0a;
  border-radius: 10rem;
  background: rgb(var(--bg-color) / 0.065);
}
.month-note-card.is-initialized {
  border-left-color: #0a84ff;
}
.month-note-card.is-completed {
  border-left-color: #8e8e93;
  opacity: 0.76;
}
.month-note-card header {
  display: flex;
  align-items: center;
  gap: 6rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.month-note-card__status {
  color: var(--text-color);
  font-weight: 650;
}
.month-note-card p {
  margin: 8rem 0;
  overflow-wrap: anywhere;
  color: var(--text-color);
  font-size: var(--fs-body);
  line-height: 1.48;
  white-space: pre-wrap;
}
.month-note-card__tags {
  display: flex;
  gap: 5rem;
  margin-bottom: 8rem;
}
.month-note-card__tags span {
  padding: 2rem 7rem;
  border-radius: 10rem;
  background: color-mix(in srgb, var(--tag-color) 16%, transparent);
  color: var(--tag-color);
  font-size: calc(var(--fs-secondary) * 0.8);
}
.month-note-card footer {
  display: flex;
  flex-wrap: wrap;
  gap: 5rem;
}
.month-note-card footer button {
  height: 25rem;
  padding: 0 8rem;
  border: 0;
  border-radius: 6rem;
  background: rgb(var(--bg-color) / 0.1);
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.78);
}
.month-note-card footer button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-note-card footer button.is-danger:hover:not(:disabled) {
  background: color-mix(in srgb, #ff453a 14%, transparent);
  color: #ff453a;
}
.month-note-card footer button:disabled {
  cursor: default;
  opacity: 0.45;
}
</style>
