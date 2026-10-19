import { computed, onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import {
  canScheduleNoteNotification,
  deriveNoteStatusForTime,
  getAllowedNoteStatuses,
  resolveNoteCreateSchedule,
  resolveNoteDraftSchedule,
  sameTimestampSecond
} from '../../../shared/note-scheduling-rules.js'

const STATUS_OPTIONS = Object.freeze([
  { label: '未开始', value: 'initialized' },
  { label: '进行中', value: 'in_progress' },
  { label: '已完成', value: 'completed' }
])

export function parseNoteDraftTime(value) {
  return value === '' || value === null || value === undefined || value === 'now'
    ? null
    : new Date(value).getTime()
}

// Keep the user's chosen progress/completion preference separate from the
// temporary status imposed by a future date. A clock tick never writes a preference.
export function useNoteStateDraft({ effectiveTimestamp, statusChoice, finishedAt, originalNote }) {
  const currentTime = ref(Date.now())
  let timer
  function refreshClock() {
    currentTime.value = Date.now()
  }
  onMounted(() => {
    timer = setInterval(refreshClock, 1000)
    window.addEventListener('focus', refreshClock)
    document.addEventListener('visibilitychange', refreshClock)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    window.removeEventListener('focus', refreshClock)
    document.removeEventListener('visibilitychange', refreshClock)
  })

  const status = computed(() =>
    deriveNoteStatusForTime({
      effectiveAt: toValue(effectiveTimestamp),
      requestedStatus: statusChoice.value,
      currentTime: currentTime.value
    })
  )
  const isFuture = computed(() => status.value === 'initialized')
  const statusOptions = computed(() => {
    const allowed = getAllowedNoteStatuses(toValue(effectiveTimestamp), currentTime.value)
    return STATUS_OPTIONS.map((option) => ({
      ...option,
      disabled: !allowed.includes(option.value)
    }))
  })
  const canScheduleNotification = computed(() => {
    const requested = toValue(effectiveTimestamp)
    const original = toValue(originalNote)
    const originalEffectiveAt = Number(original?.effective_at)
    // An unchanged appointment retains its original precision, just as the
    // main-process draft resolver does. Only that appointment may keep its
    // reminder after entering the minimum lead-time window.
    const unchangedAppointment =
      original?.status === 'initialized' &&
      Number.isFinite(originalEffectiveAt) &&
      originalEffectiveAt > 0 &&
      (requested === undefined ||
        (requested !== null &&
          requested !== '' &&
          requested !== 'now' &&
          sameTimestampSecond(requested, originalEffectiveAt)))
    return unchangedAppointment
      ? originalEffectiveAt > currentTime.value
      : canScheduleNoteNotification(requested, currentTime.value)
  })
  const stateHint = computed(() => {
    if (isFuture.value) {
      if (toValue(originalNote)?.status === 'completed') {
        return '保存后将取消完成，改为未开始。'
      }
      return statusChoice.value === 'completed'
        ? '未来生效仅支持未开始。'
        : '未来生效，到时进入进行中。'
    }
    return ''
  })

  function chooseStatus(value) {
    if (!getAllowedNoteStatuses(toValue(effectiveTimestamp), Date.now()).includes(value)) return
    if (value === 'completed' && status.value !== 'completed') finishedAt.value = ''
    statusChoice.value = value
  }

  function submissionFields(overrides = {}) {
    const now = Date.now()
    refreshClock()
    const original = toValue(originalNote)
    const requestedEffectiveAt = Object.hasOwn(overrides, 'effectiveAt')
      ? overrides.effectiveAt
      : toValue(effectiveTimestamp)
    const effectiveAt =
      requestedEffectiveAt === undefined && original ? original.effective_at : requestedEffectiveAt
    const requestedStatus = deriveNoteStatusForTime({
      effectiveAt,
      requestedStatus: statusChoice.value,
      currentTime: now
    })
    const requestedFinishedAt = Object.hasOwn(overrides, 'finishedAt')
      ? overrides.finishedAt
      : parseNoteDraftTime(finishedAt.value)
    const requested = {
      requestedEffectiveAt,
      requestedStatus,
      requestedFinishedAt,
      currentTime: now
    }
    if (original) {
      resolveNoteDraftSchedule({
        ...requested,
        status: original.status,
        currentEffectiveAt: original.effective_at,
        currentFinishedAt: original.finished_at,
        currentNotifyEnabled: original.notify_enabled
      })
    } else {
      resolveNoteCreateSchedule(requested)
    }
    return {
      status: requestedStatus,
      effectiveAt: requestedEffectiveAt,
      ...(requestedStatus === 'completed' ? { finishedAt: requestedFinishedAt } : {})
    }
  }

  return {
    status,
    isFuture,
    currentTime,
    statusOptions,
    canScheduleNotification,
    stateHint,
    chooseStatus,
    submissionFields
  }
}
