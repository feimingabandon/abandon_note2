export const CAPTURE_SHORTCUTS = Object.freeze({
  screenshot: { label: '截图', defaultValue: 'F1' },
  screenshotCopy: { label: '快速截图复制', defaultValue: 'Control+F1' }
})

export const ACTION_SHORTCUTS = Object.freeze({
  ...CAPTURE_SHORTCUTS,
  newNote: { label: '新建便签', defaultValue: 'F3' }
})
