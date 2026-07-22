import { onMounted, onUnmounted, ref } from 'vue'

// 所有需要相对时间的组件共享同一个分钟时钟，避免为每张卡片创建定时器。
const sharedNow = ref(Date.now())
let sharedClockTimer = null
let sharedClockUsers = 0

function syncSharedClock() {
  sharedNow.value = Date.now()
}

function startSharedClock() {
  sharedClockUsers++
  syncSharedClock()
  if (sharedClockTimer) return

  const delay = 60_000 - (Date.now() % 60_000) + 20
  sharedClockTimer = setTimeout(function tick() {
    syncSharedClock()
    sharedClockTimer = setTimeout(tick, 60_000)
  }, delay)
  document.addEventListener('visibilitychange', syncSharedClock)
}

function stopSharedClock() {
  sharedClockUsers = Math.max(0, sharedClockUsers - 1)
  if (sharedClockUsers || !sharedClockTimer) return

  clearTimeout(sharedClockTimer)
  sharedClockTimer = null
  document.removeEventListener('visibilitychange', syncSharedClock)
}

export function useSharedMinuteClock() {
  onMounted(startSharedClock)
  onUnmounted(stopSharedClock)
  return sharedNow
}
