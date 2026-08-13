import { normalizeViewMode, VIEW_MODES } from '../../shared/settings-schema.js'

const VIEW_LABELS = Object.freeze({
  [VIEW_MODES.LIST]: '便签列表',
  [VIEW_MODES.MONTH]: '月视图',
  [VIEW_MODES.WEEK]: '周视图'
})

export function buildStickyTrayTemplate({
  stickyService,
  openMainWindow,
  activeViewMode = 'list',
  switchMainView = () => {},
  quitApplication
}) {
  const normalizedViewMode = normalizeViewMode(activeViewMode)
  const stickies = stickyService?.list() || []
  const count = stickies.length
  const overview =
    count > 0
      ? stickies.map((sticky) => ({
          label: sticky.preview,
          submenu: [
            {
              label: '显示便利贴',
              click: () => stickyService.focus(sticky.id)
            },
            {
              label: '× 删除这张便利贴',
              click: () => stickyService.close(sticky.id)
            }
          ]
        }))
      : [{ label: '暂无便利贴', enabled: false }]

  return [
    { label: '打开主窗口', click: openMainWindow },
    {
      label: `当前视图：${VIEW_LABELS[normalizedViewMode]}`,
      submenu: Object.values(VIEW_MODES).map((viewMode) => ({
        label: VIEW_LABELS[viewMode],
        type: 'radio',
        checked: normalizedViewMode === viewMode,
        click: () => switchMainView(viewMode)
      }))
    },
    { type: 'separator' },
    {
      label: `显示全部便利贴（${count}）`,
      enabled: count > 0,
      click: () => stickyService.showAll()
    },
    { label: `便利贴总览（${count}）`, submenu: overview },
    {
      label: '× 删除全部便利贴',
      enabled: count > 0,
      click: () => stickyService.closeAll()
    },
    { type: 'separator' },
    { label: '退出应用', click: quitApplication }
  ]
}
