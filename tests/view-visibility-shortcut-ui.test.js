import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('view visibility shortcut UI wiring', () => {
  it('uses a read-only one-step recorder with explicit user states', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')
    const recorder = read('src/renderer/src/components/ui/ShortcutRecorder.vue')

    expect(panel).toContain('视图显示快捷键')
    expect(panel).toContain('列表、月视图和周视图共用')
    expect(panel).toContain('<ShortcutRecorder')
    expect(recorder).toContain('readonly')
    expect(recorder).toContain('@beforeinput.prevent')
    expect(recorder).toContain('beginViewVisibilityShortcutCapture')
    expect(recorder).toContain('setViewVisibilityShortcut')
    expect(recorder).toContain('if (captureRequested || isCapturing.value)')
    for (const text of [
      '未设置',
      '正在录制',
      '组合不完整',
      '无效',
      '冲突',
      '保存成功',
      '未变化',
      '已清除',
      '启动时已保存但注册失败'
    ]) {
      expect(recorder).toContain(text)
    }
  })

  it('documents shared scope and tray operation in the help page', () => {
    const help = read('src/renderer/src/components/help/HelpPage.vue')
    expect(help).toContain('<strong>视图显示快捷键</strong')
    expect(help).toContain('窗口隐藏到托盘后仍然有效')
  })

  it('uses dedicated IPC and the existing cross-mode window toggle path', () => {
    const main = read('src/main/index.js')
    const preload = read('src/preload/index.js')
    const genericAllowlist = main.slice(
      main.indexOf('const RENDERER_WRITABLE_SETTING_IDS'),
      main.indexOf('const APPLICATION_SETTING_IDS')
    )
    const shortcutHandler = main.slice(
      main.indexOf('function handleViewVisibilityShortcut()'),
      main.indexOf('function openMainWindow()')
    )

    expect(genericAllowlist).not.toContain('shortcuts.viewVisibility')
    expect(preload).toContain('beginViewVisibilityShortcutCapture')
    expect(preload).toContain('endViewVisibilityShortcutCapture')
    expect(preload).toContain('setViewVisibilityShortcut')
    expect(main).toContain("mainWindowIpc.handle('shortcut:view-visibility-set'")
    expect(main).toContain('viewVisibilityShortcutCaptureSenders.has(event.sender)')
    expect(shortcutHandler).toContain('isQuitting || switchingMainView || screenshotCaptureActive')
    expect(shortcutHandler).toContain('toggleWindow()')
    expect(main).toContain('if (compactWindowController.activePromise()) return')
    expect(main).toContain('viewVisibilityShortcutService?.dispose()')
  })
})
