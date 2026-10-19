import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { compileScript, parse } from '@vue/compiler-sfc'
import { isComposingInput } from '../src/renderer/src/utils/inputComposition.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function rendererHandler(path, name, dependencies) {
  const { descriptor } = parse(read(path), { filename: path })
  const parsed = compileScript(descriptor, { id: 'windows-shortcut-ui-contract' })
  const node = parsed.scriptSetupAst.find(
    (entry) => entry.type === 'FunctionDeclaration' && entry.id.name === name
  )
  if (!node) throw new Error(`Renderer handler ${name} not found`)
  return new Function(
    ...Object.keys(dependencies),
    `return (${descriptor.scriptSetup.content.slice(node.start, node.end)})`
  )(...Object.values(dependencies))
}

function keyboardEvent(key, modifiers = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

describe('view visibility shortcut UI wiring', () => {
  it('uses Ctrl for local search actions and keeps the Windows key distinct', () => {
    const focus = vi.fn(),
      select = vi.fn(),
      openSearch = vi.fn(),
      clearQuery = vi.fn()
    const help = rendererHandler('src/renderer/src/components/help/HelpPage.vue', 'onKeydown', {
      cancelNavigation: vi.fn(),
      searchInput: { value: { focus, select } },
      hasQuery: { value: false },
      navCollapsed: { value: true },
      clearSearch: vi.fn()
    })
    const action = rendererHandler(
      'src/renderer/src/components/list/ActionBar.vue',
      'onGlobalKeydown',
      {
        document: { querySelector: vi.fn(() => null) },
        openSearch
      }
    )
    const search = rendererHandler(
      'src/renderer/src/components/list/SearchBox.vue',
      'onInputKeydown',
      {
        isComposingInput,
        submitSearch: vi.fn(),
        clearQuery,
        advancedOpen: { value: false },
        query: { value: '' },
        emit: vi.fn()
      }
    )
    for (const [handler, key, actionSpy] of [
      [help, 'F', focus],
      [action, 'f', openSearch],
      [search, 'Backspace', clearQuery]
    ]) {
      const windowsKey = keyboardEvent(key, { metaKey: true })
      handler(windowsKey)
      expect(actionSpy).not.toHaveBeenCalled()
      expect(windowsKey.preventDefault).not.toHaveBeenCalled()
      const control = keyboardEvent(key, { ctrlKey: true })
      handler(control)
      expect(actionSpy).toHaveBeenCalledTimes(1)
      expect(control.preventDefault).toHaveBeenCalledTimes(1)
    }
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('keeps search shortcuts behind the inactive scene and composition guards', () => {
    const openSearch = vi.fn(),
      clearQuery = vi.fn()
    const action = rendererHandler(
      'src/renderer/src/components/list/ActionBar.vue',
      'onGlobalKeydown',
      {
        document: { querySelector: vi.fn(() => ({})) },
        openSearch
      }
    )
    const blocked = keyboardEvent('f', { ctrlKey: true })
    action(blocked)
    expect(openSearch).not.toHaveBeenCalled()
    expect(blocked.preventDefault).not.toHaveBeenCalled()
    const search = rendererHandler(
      'src/renderer/src/components/list/SearchBox.vue',
      'onInputKeydown',
      {
        isComposingInput,
        submitSearch: vi.fn(),
        clearQuery,
        advancedOpen: { value: false },
        query: { value: '' },
        emit: vi.fn()
      }
    )
    const composing = keyboardEvent('Backspace', { ctrlKey: true, isComposing: true })
    search(composing)
    expect(clearQuery).not.toHaveBeenCalled()
    expect(composing.preventDefault).not.toHaveBeenCalled()
  })

  it('uses a read-only one-step recorder with explicit user states', () => {
    const panel = read('src/renderer/src/components/system/SettingsPanel.vue')
    const recorder = read('src/renderer/src/components/ui/ShortcutRecorder.vue')

    expect(panel).toContain('视图显示快捷键')
    expect(panel).toMatch(/视图显示快捷键\s*<small>所有<\/small\s*>/)
    expect(panel).toContain('class="setting-item shortcut-setting"')
    expect(panel).toContain(
      'shortcutSummary(viewVisibilityShortcut, viewVisibilityShortcutRuntime)'
    )
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
      '未能启用',
      '重试启用',
      'retryShortcuts'
    ]) {
      expect(recorder).toContain(text)
    }
  })

  it('documents shared scope and tray operation in the help page', () => {
    const help = read('src/renderer/src/components/help/help-content.js')
    expect(help).toContain('视图显示快捷键')
    expect(help).toContain('窗口隐藏到托盘后仍然有效')
  })

  it('uses dedicated IPC and the existing cross-mode window toggle path', () => {
    const main = read('src/main/index.js')
    const preload = read('src/preload/index.js')
    const genericAllowlistStart = main.indexOf('const RENDERER_WRITABLE_SETTING_IDS')
    const genericAllowlist = main.slice(
      genericAllowlistStart,
      main.indexOf('])', genericAllowlistStart) + 2
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
    // 执行实际处理器验证保护条件，避免等价重构被字面表达式断言误报。
    const calls = []
    for (const [isQuitting, switchingMainView, screenshotCaptureActive] of [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [true, true, true]
    ]) {
      calls.length = 0
      const invoke = new Function(
        'shutdownCoordinator',
        'mainViewNavigation',
        'captureWindowIntegration',
        'getMainWindow',
        'dockRuntime',
        'logger',
        'toggleWindow',
        `${shortcutHandler}; handleViewVisibilityShortcut()`
      )
      invoke(
        { isQuitting: () => isQuitting },
        { isSwitching: () => switchingMainView },
        { isActive: () => screenshotCaptureActive },
        () => null,
        { hidden: false },
        { info: () => {} },
        () => calls.push('toggle')
      )
      expect(calls).toEqual(
        isQuitting || switchingMainView || screenshotCaptureActive ? [] : ['toggle']
      )
    }
    expect(main).toContain('viewVisibilityShortcutService?.dispose()')
  })
})
