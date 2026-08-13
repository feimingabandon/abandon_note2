function isActiveDay(day) {
  return Boolean(day && (day.isActive ?? day.inCurrentMonth))
}

export function calendarGridTabKey(days, selectedKey, todayKey) {
  const activeDays = days.filter(isActiveDay)
  if (activeDays.some((day) => day.key === selectedKey)) return selectedKey
  if (activeDays.some((day) => day.key === todayKey)) return todayKey
  return activeDays[0]?.key || ''
}

export function calendarGridNavigationTarget(days, currentKey, key) {
  const currentIndex = days.findIndex((day) => day.key === currentKey)
  if (currentIndex < 0) return null

  let targetIndex = currentIndex
  if (key === 'ArrowLeft') targetIndex -= 1
  else if (key === 'ArrowRight') targetIndex += 1
  else if (key === 'ArrowUp') targetIndex -= 7
  else if (key === 'ArrowDown') targetIndex += 7
  else if (key === 'Home') {
    const rowStart = Math.floor(currentIndex / 7) * 7
    targetIndex = days.findIndex(
      (day, index) => index >= rowStart && index < rowStart + 7 && isActiveDay(day)
    )
  } else if (key === 'End') {
    const rowStart = Math.floor(currentIndex / 7) * 7
    targetIndex = -1
    for (let index = Math.min(rowStart + 6, days.length - 1); index >= rowStart; index -= 1) {
      if (isActiveDay(days[index])) {
        targetIndex = index
        break
      }
    }
  } else return null

  const target = days[targetIndex]
  return isActiveDay(target) ? target : null
}
