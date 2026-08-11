import { computed } from 'vue'
import { localDateKey } from '../../../shared/calendar/calendar-date-rules.js'
import { useSharedMinuteClock } from './useSharedMinuteClock.js'

/**
 * 共享的本地“今天”。对齐整分刷新，从休眠或后台恢复时立即校时。
 */
export function useTodayKey() {
  const sharedNow = useSharedMinuteClock()
  return computed(() => localDateKey(sharedNow.value))
}
