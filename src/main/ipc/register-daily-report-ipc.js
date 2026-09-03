import { access, writeFile } from 'fs/promises'
import { basename, dirname } from 'path'
import {
  buildDailyReportExcel,
  buildDailyReportText,
  normalizeDailyReportExportFormat,
  normalizeDailyReportRange,
  queryDailyReportNotes,
  selectDailyReportNotes
} from '../services/daily-report.js'
import { assertMainWindowSender } from './ipc-authorization.js'

export function registerDailyReportIpcHandlers({ ipcMain, dialog, shell, getMainWindow }) {
  let lastExportPath = ''
  const assertAuthorized = (event) => assertMainWindowSender(event, getMainWindow, '报表导出功能')

  const openLastExportFolder = async () => {
    if (!lastExportPath) throw new Error('没有可打开的报表导出位置')
    try {
      await access(lastExportPath)
      shell.showItemInFolder(lastExportPath)
      return true
    } catch {
      const errorMessage = await shell.openPath(dirname(lastExportPath))
      if (errorMessage) throw new Error(errorMessage)
      return true
    }
  }

  ipcMain.handle('daily-report:preview', (event, options = {}) => {
    assertAuthorized(event)
    const range = normalizeDailyReportRange(options)
    return {
      startDateKey: range.startDateKey,
      endDateKey: range.endDateKey,
      notes: queryDailyReportNotes({ ...range, statuses: options.statuses })
    }
  })

  ipcMain.handle('daily-report:export', async (event, options = {}) => {
    assertAuthorized(event)
    // 兼容开发期尚未重载的 preload：复用已经暴露的导出方法打开最近一次导出位置。
    if (options.action === 'open-folder') return openLastExportFolder()
    const range = normalizeDailyReportRange(options)
    const format = normalizeDailyReportExportFormat(options.format)
    // 导出前重新读取范围内的数据，确保最终文件不使用已经失效或删除的预览快照。
    const currentNotes = queryDailyReportNotes({
      ...range,
      statuses: options.statuses
    })
    const selectedNotes = selectDailyReportNotes(currentNotes, options.noteIds)
    const parent = getMainWindow()
    const rangeLabel =
      range.startDateKey === range.endDateKey
        ? range.startDateKey
        : `${range.startDateKey}至${range.endDateKey}`
    const extension = format === 'xlsx' ? 'xlsx' : 'txt'
    const result = await dialog.showSaveDialog(parent, {
      title: '导出便签报表',
      defaultPath: `Abandon报表-${rangeLabel}.${extension}`,
      filters:
        format === 'xlsx'
          ? [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
          : [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    let truncatedCount = 0
    if (format === 'xlsx') {
      const excel = await buildDailyReportExcel({ ...range, notes: selectedNotes })
      await writeFile(result.filePath, excel.buffer)
      truncatedCount = excel.truncatedCount
    } else {
      const content = buildDailyReportText({ ...range, notes: selectedNotes })
      // UTF-8 BOM 让 Windows 记事本和常见办公软件稳定识别中文。
      await writeFile(result.filePath, `\uFEFF${content}`, 'utf8')
    }
    lastExportPath = result.filePath
    return {
      canceled: false,
      filePath: result.filePath,
      fileName: basename(result.filePath),
      format,
      truncatedCount
    }
  })

  ipcMain.handle('daily-report:open-export-folder', async (event) => {
    assertAuthorized(event)
    return openLastExportFolder()
  })
}
