import { onBeforeUnmount, ref, toValue, watch } from 'vue'
import { createAlmanacRequests } from '../utils/almanacRequests.js'

const requests = createAlmanacRequests((key) => window.api.getAlmanacDay(key))
const subscribers = new Set()
let stopHoliday

export function useAlmanac(date) {
  const result = ref(null)
  const loading = ref(false)
  const error = ref('')
  let sequence = 0
  async function reload() {
    const key = toValue(date)
    const request = ++sequence
    result.value = null
    error.value = ''
    loading.value = Boolean(key)
    if (!key) return
    try {
      const data = await requests.get(key)
      if (request === sequence) result.value = data
    } catch {
      if (request === sequence) error.value = '万年历暂时无法读取，请重试'
    } finally {
      if (request === sequence) loading.value = false
    }
  }
  watch(() => toValue(date), reload, { immediate: true })
  const refresh = () => {
    if (toValue(date)) void reload()
  }
  subscribers.add(refresh)
  if (!stopHoliday) {
    stopHoliday = window.api.onHolidayDataChanged?.(() => {
      requests.clear()
      for (const subscriber of subscribers) subscriber()
    })
  }
  onBeforeUnmount(() => {
    sequence += 1
    subscribers.delete(refresh)
    if (!subscribers.size) {
      stopHoliday?.()
      stopHoliday = null
      requests.clear()
    }
  })
  return { result, loading, error, reload }
}

export function openAlmanac(dateKey) {
  window.dispatchEvent(new CustomEvent('abandon:open-almanac', { detail: { dateKey } }))
}
