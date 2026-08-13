<script setup>
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'

defineProps({
  visible: { type: Boolean, default: false },
  year: { type: Number, required: true }
})

const emit = defineEmits(['dismiss', 'open-settings'])
</script>

<template>
  <AppModalShell
    :visible="visible"
    title="节假日数据需要更新"
    :subtitle="`${year} 年数据尚未安装`"
    width="min(430rem, calc(100vw - 40rem))"
    aria-label="节假日数据更新提示"
    @update:visible="emit('dismiss')"
  >
    <div class="holiday-notice">
      <span class="holiday-notice__icon" aria-hidden="true">!</span>
      <div>
        <p>日历视图会继续显示公历、农历、节气和便签，但暂时隐藏“休 / 班”标记。</p>
        <p>你可以在设置中在线下载，也可以从官方地址获取 JSON 后手动导入。</p>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="default" @click="emit('dismiss')">稍后</BaseButton>
      <BaseButton variant="primary" @click="emit('open-settings')">前往设置</BaseButton>
    </template>
  </AppModalShell>
</template>

<style scoped>
.holiday-notice {
  display: flex;
  align-items: flex-start;
  gap: 13rem;
}
.holiday-notice__icon {
  display: inline-grid;
  width: 30rem;
  height: 30rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, #ff9f0a 14%, transparent);
  color: #ff9f0a;
  font-size: var(--fs-body);
  font-weight: 700;
}
.holiday-notice p {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
  line-height: 1.55;
}
.holiday-notice p + p {
  margin-top: 8rem;
}
</style>
