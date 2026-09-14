import { getMonthCalendarData, getWeekCalendarData } from '../calendar/calendar-service.js'
import {
  dismissMissingHolidayDataNotice,
  downloadHolidayData,
  getHolidayDataStatus,
  getMissingHolidayDataNotice,
  importHolidayDataFile
} from '../calendar/holiday-data-service.js'
import { holidayDataDownloadUrl } from '../../shared/calendar/holiday-data-rules.js'
import { assertMainWindowSender, createMainWindowIpc } from './ipc-authorization.js'

export function registerCalendarIpcHandlers({ ipcMain, dialog, shell, getMainWindow }) {
  const assertAuthorized = (event) => assertMainWindowSender(event, getMainWindow, '日历数据')
  const mainWindowIpc = createMainWindowIpc(ipcMain, getMainWindow, '日历数据')
  const broadcastChanged = (payload) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed())
      window.webContents.send('calendar:holiday-data-changed', payload)
  }

  ipcMain.handle(
    'calendar:get-month',
    (event, { year, month, includeRecurringPreviews = false } = {}) => {
      assertAuthorized(event)
      return getMonthCalendarData(year, month, {
        includeRecurringPreviews: !!includeRecurringPreviews
      })
    }
  )
  ipcMain.handle(
    'calendar:get-week',
    (event, { anchorDate, includeRecurringPreviews = false } = {}) => {
      assertAuthorized(event)
      return getWeekCalendarData(anchorDate, {
        includeRecurringPreviews: !!includeRecurringPreviews
      })
    }
  )
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
  // 视图替换期间旧 renderer 可能已发出这项只读启动请求。sender 过期时返回空结果，
  // 避免把正常的窗口销毁竞态记录成权限错误；其他日历读写接口仍严格拒绝旧 sender。
  mainWindowIpc.handle('calendar:holiday-data-notice', () => getMissingHolidayDataNotice(), {
    onStaleSender: () => null
  })
  ipcMain.handle('calendar:holiday-data-dismiss-notice', async (event, { year } = {}) => {
    assertAuthorized(event)
    return dismissMissingHolidayDataNotice(year)
  })
}
