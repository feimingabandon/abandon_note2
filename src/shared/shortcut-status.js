import { formatViewVisibilityShortcut } from './view-visibility-shortcut.js'
import { CAPTURE_SHORTCUTS } from './capture-shortcuts.js'

const labels = {
  viewVisibility: '显示／隐藏当前视图',
  ...Object.fromEntries(Object.entries(CAPTURE_SHORTCUTS).map(([key, value]) => [key, value.label]))
}

export function unavailableShortcuts(runtime = {}) {
  return Object.entries(labels).flatMap(([action, label]) => {
    const state = runtime[action]
    if (!state?.enabled || !state.configured || state.registered || state.capturing || !state.error)
      return []
    return [
      {
        action,
        label,
        accelerator: formatViewVisibilityShortcut(state.configured),
        message: state.error.message || '快捷键注册失败'
      }
    ]
  })
}
