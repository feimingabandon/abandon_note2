import { getMonthCalendarData } from '../calendar/calendar-service.js'
import {
  dismissMissingHolidayDataNotice,
  downloadHolidayData,
  getHolidayDataStatus,
  getMissingHolidayDataNotice,
  importHolidayDataFile
} from '../calendar/holiday-data-service.js'
import { holidayDataDownloadUrl } from '../../shared/calendar/holiday-data-rules.js'

export function registerCalendarIpcHandlers({ ipcMain, dialog, shell, getMainWindow }) {
  const assertAuthorized = (event) => {
    if (event.sender !== getMainWindow()?.webContents) throw new Error('无权访问日历数据')
  }
  const broadcastChanged = (payload) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed())
      window.webContents.send('calendar:holiday-data-changed', payload)
  }

  ipcMain.handle('calendar:get-month', (event, { year, month } = {}) => {
    assertAuthorized(event)
    return getMonthCalendarData(year, month)
  })
  ipcMain.handle('calendar:holiday-data-status', (event, { year } = {}) => {
    assertAuthorized(event)
    return getHolidayDataStatus(year)
  })
  ipcMain.handle('calendar:holiday-data-import', async (event) => {
    assertAuthorized(event)
    const parent = getMainWindow()
    const result = await dialog.showOpenDialog(parent, {
      title: '导入节假日 JSON',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const imported = await importHolidayDataFile(result.filePaths[0])
    broadcastChanged(imported)
    return { canceled: false, ...imported }
  })
  ipcMain.handle('calendar:holiday-data-download', async (event, { year } = {}) => {
    assertAuthorized(event)
    const downloaded = await downloadHolidayData(year)
    broadcastChanged(downloaded)
    return downloaded
  })
  ipcMain.handle('calendar:holiday-data-open-link', async (event, { year } = {}) => {
    assertAuthorized(event)
    await shell.openExternal(holidayDataDownloadUrl(year))
    return true
  })
  ipcMain.handle('calendar:holiday-data-notice', (event) => {
    assertAuthorized(event)
    return getMissingHolidayDataNotice()
  })
  ipcMain.handle('calendar:holiday-data-dismiss-notice', async (event, { year } = {}) => {
    assertAuthorized(event)
    return dismissMissingHolidayDataNotice(year)
  })
}
