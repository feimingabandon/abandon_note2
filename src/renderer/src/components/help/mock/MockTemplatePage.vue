<script setup>
/**
 * MockTemplatePage.vue — 便签模板页整机的静态只读复刻（帮助图解「整机图」专用）
 *
 * 组合：页头、折叠态新建框、工具栏（搜索 + 高级筛选 + 刷新）、结果摘要、若干模板卡片。
 */
import MockTemplateCard from './MockTemplateCard.vue'
</script>

<template>
  <div class="mtp">
    <div class="mtp-header">循环便签模版设置</div>

    <!-- 折叠态新建框 -->
    <div class="mtp-create">
      <span class="mtp-create-plus">
        <svg viewBox="0 0 1024 1024" width="15" height="15">
          <path
            d="M 512 200 V 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
          <path
            d="M 200 512 H 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="mtp-create-hint">展开以新建循环模板…</span>
    </div>

    <!-- 工具栏 -->
    <div class="mtp-toolbar">
      <div class="mtp-search">
        <svg
          viewBox="0 0 20 20"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <span class="mtp-search-ph">搜索模板内容</span>
      </div>
      <span class="mtp-filter-btn">
        高级筛选
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
      <span class="mtp-refresh">
        <svg
          viewBox="0 0 20 20"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M16 7a7 7 0 1 0 .4 5M16 3v4h-4" />
        </svg>
      </span>
    </div>

    <div class="mtp-summary">当前2条 · 此条件共2条 · 刷新 09:24:10</div>

    <div class="mtp-list">
      <MockTemplateCard
        state="running"
        state-label="运行中"
        rule="每天 09:00"
        content="早会前梳理今天的三件要事，并同步到协作看板。"
        context-text="下次 明天 09:00 · 18小时后"
        :tags="[{ name: '工作' }]"
        notify
        pinned
      />
      <MockTemplateCard
        state="paused"
        state-label="已暂停"
        rule="每周 一/三/五 20:00"
        content="健身打卡：完成一次 40 分钟力量训练。"
        context-text="已暂停"
        :tags="[{ name: '健康' }]"
      />
    </div>
  </div>
</template>

<style scoped>
.mtp {
  display: flex;
  flex-direction: column;
  gap: 10rem;
  padding: 12rem;
  border-radius: 12rem;
  background: rgb(var(--bg-color) / 0.05);
}
.mtp-header {
  text-align: center;
  padding-bottom: 8rem;
  border-bottom: 1px solid rgb(var(--bg-color) / 0.1);
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.mtp-create {
  display: flex;
  align-items: center;
  height: 36rem;
  border: 1px dashed color-mix(in srgb, var(--text-color) 18%, transparent);
  border-radius: 10rem;
  background: rgba(128, 128, 128, 0.03);
}
.mtp-create-plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36rem;
  height: 36rem;
  color: var(--text-color);
}
.mtp-create-hint {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  opacity: 0.75;
}
.mtp-toolbar {
  display: flex;
  align-items: center;
  gap: 8rem;
}
.mtp-search {
  display: flex;
  align-items: center;
  gap: 6rem;
  flex: 1;
  height: 32rem;
  padding: 0 10rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 9rem;
  background: rgba(128, 128, 128, 0.03);
  color: var(--text-color-secondary);
}
.mtp-search-ph {
  font-size: var(--fs-secondary);
  opacity: 0.7;
}
.mtp-filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 5rem;
  height: 32rem;
  padding: 0 10rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 9rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.mtp-refresh {
  display: grid;
  place-items: center;
  width: 32rem;
  height: 32rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 9rem;
  color: var(--text-color-secondary);
}
.mtp-summary {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.84);
  opacity: 0.7;
}
.mtp-list {
  display: flex;
  flex-direction: column;
  gap: 8rem;
}
</style>
