import { createShortcutTrayImages } from './shortcut-status.js'
import { buildStickyTrayTemplate } from '../sticky/StickyTrayMenu.js'

/** Owns the actual tray, icon representations, menu and listener lifetime. */
export function createMainTrayController({
  Tray,
  Menu,
  icon,
  getShortcutsEnabled,
  getViewMode,
  getStickyCommands,
  getCaptureCommands,
  showReminders,
  getReminderCount = () => 0,
  toggleShortcuts,
  acknowledgeReminders,
  attachReminderTray,
  setReminderBaseIcon,
  openMainWindow,
  switchView,
  toggleWindow,
  requestQuit,
  logger,
  createShortcutImages = createShortcutTrayImages
}) {
  let tray = null
  let images = null
  let disposed = false
  const report = (scope, error, context) => logger.error(scope, error, context)
  const click = () => {
    if (disposed) return
    acknowledgeReminders()
    toggleWindow()
  }

  function menuTemplate() {
    const capture = getCaptureCommands()
    const reminderCount = Math.max(0, Number(getReminderCount()) || 0)
    const stickyItems = buildStickyTrayTemplate({
      stickyService: getStickyCommands(),
      activeViewMode: getViewMode(),
      openMainWindow: () =>
        void openMainWindow().catch((error) => report('presentation-mode.tray-open', error)),
      switchMainView: (targetMode) =>
        void switchView(targetMode).catch((error) =>
          report('view.switch-tray', error, { targetMode })
        ),
      quitApplication: () => requestQuit('tray-menu')
    })
    stickyItems.splice(1, 0, {
      id: 'show-note-reminders',
      label: `待处理提醒（${reminderCount}）`,
      enabled: reminderCount > 0,
      click: showReminders
    })
    return [
      {
        id: 'toggle-global-shortcuts',
        label: '禁用全部快捷键（本次运行）',
        type: 'checkbox',
        checked: !getShortcutsEnabled(),
        click: () => {
          toggleShortcuts()
          rebuild()
        }
      },
      { type: 'separator' },
      ...(capture
        ? [
            {
              label: '截图',
              click: () => void capture.capture().catch((error) => capture.report(error))
            },
            {
              label: '快速截图复制',
              click: () =>
                void capture
                  .capture({ mode: 'copy-on-select' })
                  .catch((error) => capture.report(error))
            },
            { label: '剪贴板贴图', click: () => void capture.action('pinClipboard') },
            { label: '恢复最近关闭的贴图', click: () => void capture.action('restorePin') },
            {
              label: '截图快速保存目录…',
              click: () => void capture.action('configureCaptureSave')
            },
            { label: '显示/隐藏全部贴图', click: () => void capture.action('togglePins') },
            { type: 'separator' }
          ]
        : []),
      ...stickyItems
    ]
  }

  function rebuild() {
    if (disposed || !tray || tray.isDestroyed() || !getStickyCommands()) return false
    const enabled = getShortcutsEnabled()
    const baseIcon = enabled ? images.enabled : images.disabled
    setReminderBaseIcon(baseIcon)
    tray.setToolTip(enabled ? '便签' : '便签 · 快捷键已禁用（重启恢复）')
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
    return true
  }

  function dispose() {
    if (disposed) return
    disposed = true
    const owned = tray
    tray = null
    images = null
    if (owned) {
      owned.removeListener('click', click)
      if (!owned.isDestroyed()) owned.destroy()
    }
  }

  return Object.freeze({
    create() {
      if (disposed) throw new Error('托盘服务已退出')
      if (tray) return false
      try {
        images = createShortcutImages(icon)
        tray = new Tray(images.enabled)
        attachReminderTray(tray)
        tray.on('click', click)
        rebuild()
        return true
      } catch (error) {
        dispose()
        throw error
      }
    },
    rebuild,
    menuTemplate,
    triggerClick: () => tray?.emit('click'),
    dispose,
    snapshot: () => ({ created: Boolean(tray && !tray.isDestroyed()), disposed })
  })
}
