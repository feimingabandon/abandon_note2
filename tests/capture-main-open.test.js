import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Execute the actual integrated open functions, isolating the compact-mode
// boundary without bootstrapping a second Windows application.
const main = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
const source = main.slice(
  main.indexOf('function focusMainWindow('),
  main.indexOf('const confirmEditingDrafts = createEditingDraftGuard(')
)
function fixture() {
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    show: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn()
  }
  let release
  const expansion = new Promise((resolve) => {
    release = resolve
  })
  const ports = {
    getMainWindow: () => window,
    shutdownCoordinator: { isQuitting: () => false },
    mainViewNavigation: {
      snapshot: () => ({ stopped: false }),
      getUserHideGeneration: () => 0,
      isReadyDocument: () => true,
      requestInitialOpen: () => null
    },
    settingsWriteSource: { readGeneration: () => 1 },
    zOrderRuntime: { mode: 'normal' },
    WINDOW_Z_ORDER_MODES: { BOTTOM: 'bottom' },
    reassertBottomWindowZOrder: vi.fn(),
    dockRuntime: { hidden: false },
    doShow: vi.fn(),
    syncVisibleDockSide: vi.fn(),
    exitCompactPresentation: vi.fn(() => expansion),
    logger: { error: vi.fn() }
  }
  const open = new Function(...Object.keys(ports), source + '\nreturn openMainWindowFromTray;')(
    ...Object.values(ports)
  )
  return { open, window, ports, release }
}
describe('capture business opening authority', () => {
  it('does not reveal or focus after its delivery expires while compact expansion waits', async () => {
    const f = fixture()
    let current = true
    const pending = f.open({ source: 'capture-delivery', isCurrent: () => current })
    expect(f.ports.exitCompactPresentation).toHaveBeenCalledOnce()
    current = false
    f.release()
    expect(await pending).toBe(false)
    expect(f.window.show).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
  })
  it('checks authority again if showing the window cancels the delivery synchronously', async () => {
    const f = fixture()
    let current = true
    f.window.show.mockImplementation(() => {
      current = false
    })
    const pending = f.open({ isCurrent: () => current })
    f.release()
    expect(await pending).toBe(false)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).not.toHaveBeenCalled()
  })
  it('keeps the existing ordinary tray opening behavior without a delivery guard', async () => {
    const f = fixture()
    const pending = f.open()
    f.release()
    expect(await pending).toBe(true)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
  })
})
