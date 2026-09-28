import { onMounted, onBeforeUnmount } from 'vue'

// An online signal only asks the shared main-process policy to check its due time.
// It must not bypass request deduplication, minimum intervals or Retry-After.
export function useWeatherRecovery() {
  const check = () => void window.api.getWeatherForecast().catch(() => {})
  onMounted(() => window.addEventListener('online', check))
  onBeforeUnmount(() => window.removeEventListener('online', check))
}
