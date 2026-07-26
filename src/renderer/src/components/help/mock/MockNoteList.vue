<script setup>
/**
 * MockNoteList.vue — 便签列表整机的静态只读复刻（帮助图解「整机图」专用）
 *
 * 组合：顶部工具栏（标题 + 功能切换标签 + 时间线/自定义切换）、新建/搜索操作框、
 * 分组标签行、若干便签卡片、底部计数。用于便签模块开头的整机标注图。
 */
import MockActionBar from './MockActionBar.vue'
import MockNoteCard from './MockNoteCard.vue'
</script>

<template>
  <div class="mnl">
    <!-- 工具栏 -->
    <div class="mnl-toolbar">
      <span class="mnl-title">便签</span>
      <div class="mnl-tabs">
        <span class="mnl-tab">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span class="mnl-tab mnl-tab--active">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a4.5 4.5 0 0 1 0 9 4.5 4.5 0 0 0 0 9" />
            <circle cx="12" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span class="mnl-tab">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" />
            <path
              d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z"
              transform="rotate(120 12 12)"
            />
            <path
              d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z"
              transform="rotate(240 12 12)"
            />
          </svg>
        </span>
      </div>
      <span class="mnl-mode">
        时间线
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M3.5 5.5h9l-2.4-2.4M12.5 10.5h-9l2.4 2.4"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </div>

    <!-- 新建 / 搜索框 -->
    <div class="mnl-actions">
      <MockActionBar grow="new" />
    </div>

    <!-- 分组 + 卡片流 -->
    <div class="mnl-scroll">
      <div class="mnl-group-label">
        <span>置顶</span>
        <span class="mnl-count">· 1条</span>
        <span class="mnl-refresh">· 刷新 09:24:10</span>
      </div>
      <MockNoteCard
        status="in_progress"
        content="下午 3 点和设计团队过一遍新版本的交互稿，重点确认帮助中心的滑入动效与只读预览方案是否一致。"
        time-text="今天 15:00"
        :tags="[{ name: '工作' }, { name: '重要' }]"
        :more-tags="1"
        :attachments="2"
        disclosure
      />

      <div class="mnl-group-label">
        <span>近三天</span>
        <span class="mnl-count">· 2条</span>
      </div>
      <MockNoteCard
        status="initialized"
        content="晚上 8 点提醒我给绿植浇水。"
        time-text="6小时后生效"
        :tags="[{ name: '生活' }]"
        notify
      />
      <MockNoteCard
        status="completed"
        content="把上周的报销单据整理好交给财务。"
        time-text="已完成 · 昨天 17:20"
        :tags="[{ name: '琐事' }]"
      />
    </div>

    <!-- 底部计数 -->
    <div class="mnl-footer">
      <span>当前3条</span>
      <span>共18条</span>
    </div>
  </div>
</template>

<style scoped>
.mnl {
  display: flex;
  flex-direction: column;
  gap: 10rem;
  padding: 12rem;
  border-radius: 12rem;
  background: rgb(var(--bg-color) / 0.05);
}
.mnl-toolbar {
  display: flex;
  align-items: center;
  gap: 10rem;
}
.mnl-title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-color);
}
.mnl-tabs {
  display: flex;
  gap: 2rem;
  margin: 0 auto;
  padding: 2rem;
  border-radius: 9rem;
  background: rgba(128, 128, 128, 0.08);
}
.mnl-tab {
  display: grid;
  place-items: center;
  width: 26rem;
  height: 22rem;
  border-radius: 7rem;
  color: var(--text-color-secondary);
}
.mnl-tab--active {
  background: rgb(var(--bg-color) / 0.5);
  color: var(--text-color);
}
.mnl-mode {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.mnl-actions {
  padding: 2rem 0;
}
.mnl-scroll {
  display: flex;
  flex-direction: column;
  gap: 5rem;
}
.mnl-group-label {
  display: flex;
  align-items: center;
  gap: 4rem;
  margin: 6rem 0 2rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.86);
  font-weight: 600;
}
.mnl-count {
  font-weight: 500;
  opacity: 0.8;
}
.mnl-refresh {
  font-weight: 400;
  opacity: 0.6;
}
.mnl-footer {
  display: flex;
  justify-content: space-between;
  padding: 6rem 2rem 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  opacity: 0.7;
}
</style>
