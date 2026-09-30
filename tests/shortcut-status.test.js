import { describe, expect, it } from 'vitest'
import { unavailableShortcuts } from '../src/shared/shortcut-status.js'

describe('shortcut conflict notice', () => {
  const failed = {
    configured: 'Control+Alt+N',
    enabled: true,
    registered: false,
    capturing: false,
    error: { code: 'conflict', message: '快捷键已被系统或其他应用占用' }
  }
  it('lists both supported actions with their actual saved bindings and errors', () => {
    expect(
      unavailableShortcuts({ viewVisibility: failed, screenshot: { ...failed, configured: 'F1' } })
    ).toEqual([
      {
        action: 'viewVisibility',
        label: '显示／隐藏当前视图',
        accelerator: 'Ctrl + Alt + N',
        message: failed.error.message
      },
      { action: 'screenshot', label: '截图', accelerator: 'F1', message: failed.error.message }
    ])
  })
  it('does not call disabled, cleared, recording, healthy or retired actions conflicts', () => {
    for (const patch of [
      { enabled: false },
      { configured: '' },
      { registered: true },
      { capturing: true },
      { error: null }
    ])
      expect(unavailableShortcuts({ viewVisibility: { ...failed, ...patch } })).toEqual([])
    expect(unavailableShortcuts({ clipboardPin: failed })).toEqual([])
    expect(unavailableShortcuts()).toEqual([])
  })
})
