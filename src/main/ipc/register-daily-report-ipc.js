import { access, writeFile } from 'fs/promises'
import { basename, dirname } from 'path'
import {
  buildDailyReportText,
  normalizeDailyReportDate,
  queryDailyReportNotes,
  selectDailyReportNotes
} from '../services/daily-report.js'

export function registerDailyReportIpcHandlers({ ipcMain, dialog, shell, getMainWindow }) {
  let lastExportPath = ''
  const assertAuthorized = (event) => {
    if (event.sender !== getMainWindow()?.webContents) throw new Error('无权访问日报导出功能')
  }

  const openLastExportFolder = async () => {
    if (!lastExportPath) throw new Error('没有可打开的日报导出位置')
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
    const dateKey = normalizeDailyReportDate(options.dateKey)
    return {
      dateKey,
      notes: queryDailyReportNotes({ dateKey, statuses: options.statuses })
    }
  })

  ipcMain.handle('daily-report:export', async (event, options = {}) => {
    assertAuthorized(event)
    // 兼容开发期尚未重载的 preload：复用已经暴露的导出方法打开最近一次导出位置。
    if (options.action === 'open-folder') return openLastExportFolder()
    const dateKey = normalizeDailyReportDate(options.dateKey)
    // 导出前重新读取当天数据，确保最终文件不使用已经失效或删除的预览快照。
    const currentNotes = queryDailyReportNotes({
      dateKey,
      statuses: options.statuses
    })
    const selectedNotes = selectDailyReportNotes(currentNotes, options.noteIds)
    const parent = getMainWindow()
    const result = await dialog.showSaveDialog(parent, {
      title: '导出日报',
      defaultPath: `Abandon日报-${dateKey}.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    const content = buildDailyReportText({ dateKey, notes: selectedNotes })
    // UTF-8 BOM 让 Windows 记事本和常见办公软件稳定识别中文。
    await writeFile(result.filePath, `\uFEFF${content}`, 'utf8')
    lastExportPath = result.filePath
    return {
      canceled: false,
      filePath: result.filePath,
      fileName: basename(result.filePath)
    }
  })

  ipcMain.handle('daily-report:open-export-folder', async (event) => {
    assertAuthorized(event)
    return openLastExportFolder()
  })
}
