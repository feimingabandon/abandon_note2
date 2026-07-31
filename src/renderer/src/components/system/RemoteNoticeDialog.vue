<script setup>
import { computed, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'

const props = defineProps({
  notices: {
    type: Array,
    default: () => []
  },
  historyMode: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'acknowledged'])
const currentIndex = ref(0)
const acknowledging = ref(false)

const current = computed(() => props.notices[currentIndex.value] || null)
const hasMultiple = computed(() => props.notices.length > 1)
const alreadyAcknowledged = computed(
  () => props.historyMode && Boolean(current.value?.acknowledgedAt)
)

watch(
  () => props.notices,
  (notices) => {
    if (!notices.length) currentIndex.value = 0
    else if (currentIndex.value >= notices.length) currentIndex.value = notices.length - 1
  }
)

async function acknowledge() {
  if (!current.value || acknowledging.value) return
  if (alreadyAcknowledged.value) {
    emit('close')
    return
  }
  acknowledging.value = true
  try {
    const changed = await window.api.acknowledgeRemoteNotice(current.value.id)
    if (changed) emit('acknowledged', current.value.id)
    else emit('close')
  } finally {
    acknowledging.value = false
  }
}
</script>

<template>
  <AppModalShell
    :visible="Boolean(current)"
    :title="current?.title || '软件通知'"
    :subtitle="
      historyMode && current?.publishedAt
        ? new Date(current.publishedAt).toLocaleString('zh-CN')
        : ''
    "
    aria-label="软件通知"
    width="min(540rem, calc(100vw - 40rem))"
    max-height="min(620rem, calc(100vh - 40rem))"
    :z-index="43000"
    @update:visible="emit('close')"
  >
    <div class="notice-body">{{ current?.body }}</div>
    <button
      v-if="current?.link"
      type="button"
      class="notice-link"
      @click="window.api.openRemoteNoticeLink(current.id)"
    >
      打开通知链接
      <span aria-hidden="true">↗</span>
    </button>

    <template #footer>
      <div class="notice-footer-info">
        <template v-if="hasMultiple">
          <button
            type="button"
            aria-label="上一条通知"
            :disabled="currentIndex === 0"
            @click="currentIndex -= 1"
          >
            ←
          </button>
          <span>{{ currentIndex + 1 }} / {{ notices.length }}</span>
          <button
            type="button"
            aria-label="下一条通知"
            :disabled="currentIndex >= notices.length - 1"
            @click="currentIndex += 1"
          >
            →
          </button>
          <span>共 {{ notices.length }} 条未确认通知</span>
        </template>
        <span v-else-if="historyMode">
          {{ alreadyAcknowledged ? '已确认通知' : '未确认通知' }}
        </span>
        <span v-else>1 条未确认通知</span>
      </div>
      <BaseButton variant="primary" size="md" :disabled="acknowledging" @click="acknowledge">
        {{ acknowledging ? '正在保存…' : alreadyAcknowledged ? '关闭' : '知道了' }}
      </BaseButton>
    </template>
  </AppModalShell>
</template>

<style scoped>
.notice-body {
  min-height: 150rem;
  color: var(--text-color);
  font-size: var(--fs-body);
  line-height: 1.72;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.notice-link {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  padding: 0;
  margin-top: 18rem;
  border: 0;
  color: #0071e3;
  background: transparent;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}

.notice-footer-info {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.notice-footer-info button {
  display: grid;
  place-items: center;
  width: 28rem;
  height: 28rem;
  padding: 0;
  border: 1rem solid var(--surface-float-border);
  border-radius: 8rem;
  color: var(--text-color);
  background: color-mix(in srgb, var(--surface-float) 94%, var(--text-color) 6%);
  cursor: pointer;
}

.notice-footer-info button:disabled {
  opacity: 0.32;
  cursor: default;
}
</style>
