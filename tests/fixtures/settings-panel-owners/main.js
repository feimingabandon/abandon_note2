import { createApp, h, nextTick, onMounted, ref } from 'vue'
import { useHolidayDataSettings } from '../../../src/renderer/src/composables/useHolidayDataSettings.js'
import { useSettingsDiagnostics } from '../../../src/renderer/src/composables/useSettingsDiagnostics.js'

// An actual Vue component owns the production composables. Only its API is a
// fixture: delayed promises and retained callbacks make ownership observable.
const listeners = { holiday: new Set(), blur: new Set(), remote: new Set() }
const retained = { holiday: [], blur: [], remote: [] }
const requests = []
const calls = { holiday: 0, scheduler: 0, retry: 0, remote: 0, import: 0 }
const messages = []
const intervals = new Set()
const setIntervalOriginal = window.setInterval.bind(window)
const clearIntervalOriginal = window.clearInterval.bind(window)
let schedulerInFlight = 0
let maximumSchedulerInFlight = 0
window.setInterval = (callback, delay, ...args) => {
  const id = setIntervalOriginal(callback, delay, ...args)
  if (delay === 10000) intervals.add(id)
  return id
}
window.clearInterval = (id) => {
  intervals.delete(id)
  clearIntervalOriginal(id)
}
function subscribe(kind, callback) {
  listeners[kind].add(callback)
  retained[kind].push(callback)
  return () => listeners[kind].delete(callback)
}
function request(kind) {
  calls[kind] += 1
  const scheduler = kind === 'scheduler' || kind === 'retry'
  if (scheduler) maximumSchedulerInFlight = Math.max(maximumSchedulerInFlight, ++schedulerInFlight)
  return new Promise((resolve, reject) => requests.push({ kind, resolve, reject })).finally(() => {
    if (scheduler) schedulerInFlight -= 1
  })
}
const api = {
  onHolidayDataChanged: (callback) => subscribe('holiday', callback),
  onBlurDiagnosticChanged: (callback) => subscribe('blur', callback),
  onRemoteHealthChanged: (callback) => subscribe('remote', callback),
  getHolidayDataStatus: () => request('holiday'),
  getRemoteHealth: () => request('remote'),
  getSchedulerHealth: () => request('scheduler'),
  retryScheduler: () => request('retry'),
  importHolidayData: () => request('import')
}
const flush = async () => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
  await nextTick()
}
let lastOwner
const Owner = {
  setup() {
    const showMessage = (...args) => messages.push(args)
    const holiday = useHolidayDataSettings({ api, showMessage, year: 2026 })
    const diagnostics = useSettingsDiagnostics({ api, showMessage })
    lastOwner = { holiday, diagnostics }
    onMounted(() => {
      void holiday.start()
      void diagnostics.start()
      // This isolated component has no settings-snapshot barrier. The product
      // panel calls this same port only after its existing initial read barrier.
      diagnostics.startBlurDiagnostics()
    })
    return () =>
      h('section', { id: 'owner' }, [
        h('p', '节假日：' + holiday.holidayDataStatusLabel.value),
        h('p', '远程：' + diagnostics.remoteHealthLabel.value),
        h('p', '调度：' + (diagnostics.schedulerHealth.value?.status || 'pending'))
      ])
  }
}
const mounted = ref(true)
const app = createApp({
  setup: () => () =>
    mounted.value ? h(Owner) : h('p', { id: 'unmounted' }, 'Settings owner unmounted')
})
app.mount('#app')
window.fixture = {
  async setMounted(value) {
    mounted.value = value
    await flush()
  },
  async refreshAndQueueRetry() {
    void lastOwner.diagnostics.loadSchedulerHealth()
    void lastOwner.diagnostics.loadSchedulerHealth()
    void lastOwner.diagnostics.retryScheduler()
    void lastOwner.diagnostics.retryScheduler()
    await flush()
  },
  async importData() {
    void lastOwner.holiday.importHolidayData()
    await flush()
  },
  async settle(kind, value, failure = null) {
    const index = requests.findIndex((entry) => entry.kind === kind)
    if (index < 0) throw new Error('No pending fixture request: ' + kind)
    const [entry] = requests.splice(index, 1)
    if (failure) entry.reject(new Error(failure))
    else entry.resolve(value)
    await flush()
  },
  async retainedEvents(generation = 0) {
    retained.holiday[generation]?.()
    retained.blur[generation]?.({ status: 'error', message: 'retained callback' })
    retained.remote[generation]?.({ retired: true })
    await flush()
  },
  snapshot() {
    const { holiday, diagnostics } = lastOwner
    return JSON.parse(
      JSON.stringify({
        calls,
        messages,
        subscriptions: Object.fromEntries(
          Object.entries(listeners).map(([kind, values]) => [kind, values.size])
        ),
        intervals: intervals.size,
        pending: requests.map(({ kind }) => kind),
        schedulerInFlight,
        maximumSchedulerInFlight,
        state: {
          holiday: holiday.holidayDataStatus.value,
          holidayBusy: holiday.holidayDataBusy.value,
          holidayError: holiday.holidayDataError.value,
          scheduler: diagnostics.schedulerHealth.value,
          remote: diagnostics.remoteHealthStatus.value,
          remoteError: diagnostics.remoteHealthError.value,
          blur: diagnostics.blurDiagnostic.value
        }
      })
    )
  },
  async cleanup() {
    app.unmount()
    for (const entry of requests.splice(0)) entry.resolve({})
    await flush()
    window.setInterval = setIntervalOriginal
    window.clearInterval = clearIntervalOriginal
  }
}
