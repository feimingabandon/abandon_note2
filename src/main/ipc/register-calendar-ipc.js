import { getMonthCalendarData } from '../calendar/calendar-service.js'

export function registerCalendarIpcHandlers({ ipcMain }) {
  ipcMain.handle('calendar:get-month', (_event, { year, month } = {}) =>
    getMonthCalendarData(year, month)
  )
}
