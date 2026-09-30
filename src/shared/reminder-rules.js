export const REMINDER_CHANNELS = Object.freeze({ system: 1, popup: 2, tray: 4 })
export const SNOOZE_MINUTES = Object.freeze([5, 10, 30, 60])

export function normalizeReminderChannels(value, legacyEnabled = false) {
  if (value === undefined || value === null) return legacyEnabled ? 1 : 0
  const channels = Number(value)
  if (!Number.isInteger(channels) || channels < 0 || channels > 7) {
    throw new Error('提醒方式无效')
  }
  return channels
}

export function availableReminderChannels(channels, platform) {
  const value = normalizeReminderChannels(channels)
  return platform === 'darwin' ? value & ~REMINDER_CHANNELS.system : value
}

export function assertSnoozeTime(value, now = Date.now()) {
  const dueAt = Number(value)
  if (!Number.isSafeInteger(dueAt) || dueAt <= now || dueAt > now + 366 * 86400000) {
    throw new Error('请选择未来一年内的提醒时间')
  }
  return dueAt
}

export function reminderChannelLabels(value) {
  const channels = normalizeReminderChannels(value)
  return [
    [1, '系统提醒'],
    [2, '软件弹窗'],
    [4, '托盘闪烁']
  ]
    .filter(([bit]) => channels & bit)
    .map(([, label]) => label)
    .join('、')
}
