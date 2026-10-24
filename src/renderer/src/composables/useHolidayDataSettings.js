import { computed, onScopeDispose, ref } from 'vue'

// One panel owns the subscription, coalesced local reads and user action. IPC
// work may finish after disposal; it no longer owns this panel's state or toast.
export function useHolidayDataSettings({
  api = window.api,
  showMessage,
  year = new Date().getFullYear()
}) {
  const holidayDataStatus = ref(null)
  const holidayDataBusy = ref('')
  const holidayDataError = ref('')
  let active = true
  let started = false
  let stopListener = null
  let revision = 0
  let readPending = null
  let readAgain = false

  const holidayDataStatusLabel = computed(() =>
    holidayDataStatus.value?.available ? '● 数据可用' : '○ 需要更新'
  )
  const holidayDataSourceLabel = computed(() => {
    const status = holidayDataStatus.value
    if (!status?.available) return '暂无数据'
    if (status.source === 'download') return '在线下载'
    if (status.source === 'import') return '手动导入'
    return '应用内置'
  })
  const holidayCoveredYearsLabel = computed(() => {
    const years = holidayDataStatus.value?.coveredYears || []
    if (!years.length) return '无'
    const ranges = []
    let start = years[0]
    let end = years[0]
    for (const next of years.slice(1)) {
      if (next === end + 1) {
        end = next
        continue
      }
      ranges.push(start === end ? String(start) : `${start}–${end}`)
      start = next
      end = next
    }
    ranges.push(start === end ? String(start) : `${start}–${end}`)
    return ranges.join('、')
  })
  const holidayDataSourceDetail = computed(() => {
    const status = holidayDataStatus.value
    if (!status?.available) return '未安装当前年份数据'
    const time = status.updatedAt
      ? new Date(status.updatedAt).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '随应用提供'
    return [status.sourceName, time].filter(Boolean).join(' · ')
  })

  function loadHolidayDataStatus() {
    if (!active) return Promise.resolve()
    revision += 1
    readAgain = true
    if (readPending) return readPending
    readPending = (async () => {
      await Promise.resolve()
      try {
        while (active && readAgain) {
          readAgain = false
          const current = revision
          try {
            const status = await api.getHolidayDataStatus(year)
            if (!active || current !== revision) continue
            holidayDataStatus.value = status
            holidayDataError.value = ''
          } catch (error) {
            if (!active || current !== revision) continue
            console.warn('[SettingsPanel] 读取节假日数据状态失败:', error)
            holidayDataError.value = error?.message || '无法读取节假日数据状态'
          }
        }
      } finally {
        readPending = null
      }
    })()
    return readPending
  }

  async function changeHolidayData(kind) {
    if (!active || holidayDataBusy.value) return
    const current = revision
    holidayDataBusy.value = kind
    holidayDataError.value = ''
    try {
      const result = await (kind === 'import'
        ? api.importHolidayData()
        : api.downloadHolidayData(year))
      if (!active) return
      if (result?.canceled) return
      // A broadcast after this action began schedules an authoritative local
      // read. Its result must not be replaced by an older mutation response.
      if (current === revision) {
        revision += 1
        holidayDataStatus.value = result.status
      }
      showMessage(
        'success',
        kind === 'import'
          ? `已导入 ${(result.importedYears || []).join('、')} 年节假日数据`
          : `${year} 年节假日数据已下载并导入`
      )
    } catch (error) {
      if (!active) return
      console.warn(`[SettingsPanel] ${kind === 'import' ? '导入' : '下载'}节假日数据失败:`, error)
      holidayDataError.value = error?.message || (kind === 'import' ? '导入失败' : '下载失败')
      showMessage('error', holidayDataError.value, 4000)
    } finally {
      if (active) holidayDataBusy.value = ''
    }
  }
  async function openHolidayDataLink() {
    if (!active) return
    try {
      await api.openHolidayDataLink(year)
    } catch (error) {
      if (!active) return
      console.warn('[SettingsPanel] 打开节假日数据地址失败:', error)
      showMessage('error', error?.message || '无法打开下载地址', 4000)
    }
  }
  function start() {
    if (!active || started) return readPending || Promise.resolve()
    started = true
    stopListener = api.onHolidayDataChanged?.(() => {
      if (active) void loadHolidayDataStatus()
    })
    return loadHolidayDataStatus()
  }
  function dispose() {
    if (!active) return
    active = false
    revision += 1
    readAgain = false
    stopListener?.()
    stopListener = null
  }
  onScopeDispose(dispose)
  return {
    currentHolidayYear: year,
    holidayDataStatus,
    holidayDataBusy,
    holidayDataError,
    holidayDataStatusLabel,
    holidayDataSourceLabel,
    holidayCoveredYearsLabel,
    holidayDataSourceDetail,
    loadHolidayDataStatus,
    importHolidayData: () => changeHolidayData('import'),
    downloadCurrentHolidayData: () => changeHolidayData('download'),
    openHolidayDataLink,
    start,
    dispose
  }
}
