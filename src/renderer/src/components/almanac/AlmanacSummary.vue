<script setup>
import { useAlmanac, openAlmanac } from '../../composables/useAlmanac.js'
import { almanacSummary } from '../../../../shared/calendar/almanac-display.js'
const props = defineProps({ dateKey: { type: String, required: true } })
const { result, loading, error } = useAlmanac(() => props.dateKey)
</script>
<template>
  <section class="almanac-summary" aria-label="所选日期万年历">
    <button
      type="button"
      class="almanac-summary__open"
      aria-haspopup="dialog"
      @click="openAlmanac(dateKey)"
    >
      万年历 <span>查看全部 ›</span>
    </button>
    <div v-if="result" :key="result.dateKey" class="almanac-summary__lines" aria-live="polite">
      <template v-if="result.almanac?.status === 'ok'">
        <p><b>宜</b>{{ almanacSummary(result.almanac.yi, '无特别宜项') }}</p>
        <p>
          <b class="almanac-summary__ji">忌</b>{{ almanacSummary(result.almanac.ji, '无特别忌项') }}
        </p>
      </template>
      <p v-else>
        {{ result.almanac?.status === 'unsupported' ? '该日期暂不支持宜忌' : '宜忌暂时无法计算' }}
      </p>
    </div>
    <p v-else-if="loading" class="almanac-summary__state">读取日期信息…</p>
    <p v-if="error" role="status">{{ error }}</p>
  </section>
</template>
<style scoped>
.almanac-summary {
  padding: 8rem 12rem;
  border-bottom: 1px solid var(--ui-border-divider);
  min-width: 0;
}
.almanac-summary__open {
  display: flex;
  justify-content: space-between;
  gap: 8rem;
  width: 100%;
  padding: 2rem 0;
  background: transparent;
  border: 0;
  color: var(--text-color);
  cursor: pointer;
}
.almanac-summary__open span {
  color: var(--ui-accent);
  font-size: var(--fs-secondary);
}
.almanac-summary p {
  margin: 5rem 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-secondary);
}
.almanac-summary b {
  color: var(--ui-accent);
  margin-right: 8rem;
}
.almanac-summary b.almanac-summary__ji {
  color: var(--ui-warning);
}
.almanac-summary__state {
  opacity: 0.7;
}
.almanac-summary__lines {
  animation: almanac-summary-reveal var(--motion-control) var(--ease-standard);
}
@keyframes almanac-summary-reveal {
  from {
    opacity: 0;
    transform: translateY(3rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
