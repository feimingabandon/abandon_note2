<script setup>
/**
 * SchedulerPanel.vue — 调度器健康诊断面板
 *
 * 4.2: 展示 Scheduler 实时状态、任务列表、错误诊断
 * 通过「帮助」按钮或开发者快捷键唤起
 */
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['close'])

/** 健康数据 */
const health = ref(null)
/** 加载状态 */
const loading = ref(false)
/** 自动刷新定时器 */
let autoRefreshTimer = null

// ============================================================
// 数据加载
// ============================================================

async function loadHealth() {
  loading.value = true
  try {
    health.value = await window.api.getSchedulerHealth()
  } catch (e) {
    console.error('[SchedulerPanel] 获取健康数据失败:', e)
    health.value = { error: e.message }
  } finally {
    loading.value = false
  }
}

// ============================================================
// 格式化
// ============================================================

function formatTime(ts) {
  if (!ts) return '——'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function timeAgo(ts) {
  if (!ts) return '——'
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  return `${Math.floor(diff / 3600000)} 小时前`
}

// ============================================================
// 生命周期
// ============================================================

onMounted(() => {
  loadHealth()
  // 每 10 秒自动刷新
  autoRefreshTimer = setInterval(loadHealth, 10000)
})

onUnmounted(() => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
})
</script>

<template>
  <div class="sp-overlay" @click.self="emit('close')">
    <div class="sp-panel app-bg scroll-y">
      <!-- 标题栏 -->
      <div class="sp-header">
        <span class="sp-title">🔧 调度器诊断</span>
        <button class="sp-close-btn" @click="emit('close')">✕</button>
      </div>

      <!-- 加载/错误 -->
      <div v-if="loading && !health" class="sp-loading">加载中…</div>
      <div v-else-if="health?.error" class="sp-error">获取失败：{{ health.error }}</div>

      <!-- 诊断内容 -->
      <template v-else-if="health">
        <!-- 总体状态 -->
        <div class="sp-section">
          <div class="sp-section-title">总体状态</div>
          <div class="sp-status-row">
            <span class="sp-label">运行状态</span>
            <span
              class="sp-badge"
              :class="health.status === 'running' ? 'sp-badge--ok' : 'sp-badge--warn'"
            >
              {{ health.status === 'running' ? '● 运行中' : '○ 已停止' }}
            </span>
          </div>
          <div class="sp-status-row">
            <span class="sp-label">上次 tick</span>
            <span class="sp-value">
              {{ formatTime(health.lastTickAt) }}
              <span class="sp-ago">（{{ timeAgo(health.lastTickAt) }}）</span>
            </span>
          </div>
          <div class="sp-status-row">
            <span class="sp-label">看门狗运行状态</span>
            <span
              class="sp-badge"
              :class="health.watchdogRunning ? 'sp-badge--ok' : 'sp-badge--warn'"
            >
              {{ health.watchdogRunning ? '● 运行中' : '○ 未注册' }}
            </span>
          </div>
          <div class="sp-status-row">
            <span class="sp-label">tick 互斥锁</span>
            <span class="sp-badge" :class="!health.tickStuck ? 'sp-badge--ok' : 'sp-badge--danger'">
              {{ health.tickStuck ? '⚠ 卡死' : '● 正常' }}
            </span>
          </div>
          <div class="sp-status-row">
            <span class="sp-label">主线代数</span>
            <span class="sp-value">gen={{ health.mainGeneration }}</span>
          </div>
          <div class="sp-status-row">
            <span class="sp-label">看门狗恢复次数</span>
            <span class="sp-value" :class="{ 'sp-value--warn': health.recoveryFailures > 0 }">
              {{ health.recoveryFailures }}
            </span>
          </div>
        </div>

        <!-- 任务列表 -->
        <div class="sp-section">
          <div class="sp-section-title">
            注册任务
            <span class="sp-section-count">{{ health.tasks?.length || 0 }} 个</span>
          </div>

          <div v-if="!health.tasks || health.tasks.length === 0" class="sp-empty">暂无注册任务</div>

          <div v-else class="sp-task-list">
            <div
              v-for="task in health.tasks"
              :key="task.name"
              class="sp-task-card"
              :class="{ 'sp-task-card--disabled': task.disabled }"
            >
              <div class="sp-task-header">
                <span class="sp-task-name">{{ task.name }}</span>
                <span
                  v-if="task.disabled"
                  class="sp-badge sp-badge--danger"
                  title="连续失败 10 次已自动禁用"
                >
                  ⚠ 已熔断
                </span>
                <span v-else class="sp-badge sp-badge--ok">正常</span>
              </div>
              <div class="sp-task-meta">
                <span>失败次数：{{ task.failures }}</span>
              </div>
              <div v-if="task.lastError" class="sp-task-error">
                {{ task.lastError }}
              </div>
            </div>
          </div>
        </div>

        <!-- 按钮区 -->
        <div class="sp-actions">
          <button class="sp-refresh-btn" @click="loadHealth">🔄 刷新</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== 遮罩 ===== */
.sp-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
}

/* ===== 面板 ===== */
.sp-panel {
  width: min(520rem, 90vw);
  max-height: 85vh;
  border-radius: 14rem;
  padding: 24rem;
  display: flex;
  flex-direction: column;
  gap: 20rem;
}

/* ===== 标题栏 ===== */
.sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sp-title {
  font-size: var(--fs-title);
  font-weight: 700;
}
.sp-close-btn {
  width: 24rem;
  height: 24rem;
  border: none;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sp-close-btn:hover {
  background: rgba(128, 128, 128, 0.2);
  color: var(--text-color);
}

/* ===== 加载/错误 ===== */
.sp-loading,
.sp-error,
.sp-empty {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  text-align: center;
  padding: 20rem 0;
}
.sp-error {
  color: rgb(255, 59, 48);
}

/* ===== 区块 ===== */
.sp-section {
  background: rgba(128, 128, 128, 0.04);
  border-radius: 10rem;
  padding: 16rem;
}
.sp-section-title {
  font-size: var(--fs-secondary);
  font-weight: 600;
  margin-bottom: 12rem;
  display: flex;
  align-items: center;
  gap: 8rem;
}
.sp-section-count {
  font-weight: 400;
  color: var(--text-color-secondary);
}

/* ===== 状态行 ===== */
.sp-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6rem 0;
  font-size: var(--fs-secondary);
}
.sp-label {
  color: var(--text-color-secondary);
}
.sp-value {
  font-weight: 500;
}
.sp-value--warn {
  color: rgb(255, 149, 0);
}
.sp-ago {
  color: var(--text-color-secondary);
  font-weight: 400;
}

/* ===== 徽章 ===== */
.sp-badge {
  font-size: calc(var(--fs-secondary) * 0.88);
  padding: 2rem 8rem;
  border-radius: 4rem;
  font-weight: 500;
}
.sp-badge--ok {
  background: rgba(52, 199, 89, 0.10);
  color: rgb(52, 199, 89);
}
.sp-badge--warn {
  background: rgba(255, 149, 0, 0.10);
  color: rgb(255, 149, 0);
}
.sp-badge--danger {
  background: rgba(255, 59, 48, 0.10);
  color: rgb(255, 59, 48);
}

/* ===== 任务卡片 ===== */
.sp-task-list {
  display: flex;
  flex-direction: column;
  gap: 10rem;
}
.sp-task-card {
  padding: 12rem;
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.04);
  border: 1px solid rgba(128, 128, 128, 0.08);
}
.sp-task-card--disabled {
  opacity: 0.6;
  border-color: rgba(255, 59, 48, 0.2);
}
.sp-task-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6rem;
}
.sp-task-name {
  font-size: var(--fs-secondary);
  font-weight: 600;
}
.sp-task-meta {
  font-size: calc(var(--fs-secondary) * 0.88);
  color: var(--text-color-secondary);
}
.sp-task-error {
  font-size: calc(var(--fs-secondary) * 0.8);
  color: rgb(255, 59, 48);
  margin-top: 4rem;
  padding: 6rem 8rem;
  background: rgba(255, 59, 48, 0.06);
  border-radius: 4rem;
  word-break: break-all;
}

/* ===== 按钮区 ===== */
.sp-actions {
  display: flex;
  justify-content: center;
}
.sp-refresh-btn {
  padding: 8rem 20rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.06);
  color: var(--text-color);
  cursor: pointer;
}
.sp-refresh-btn:hover {
  background: rgba(128, 128, 128, 0.12);
}
</style>
