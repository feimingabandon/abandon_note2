import { describe, expect, it, vi } from 'vitest'
import { createCaptureWindowIntegration } from '../src/main/capture/capture-window-integration.js'

function fixture({ visible = true, focused = true, hide = true, dockHidden = false } = {}) {
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focused,
    showInactive: vi.fn(),
    focus: vi.fn()
  }
  let current = window
  let quitting = false
  const ports = {
    suspendDock: vi.fn(),
    resumeDock: vi.fn(),
    hideWindow: vi.fn(),
    reassertZOrder: vi.fn(),
    openBusiness: vi.fn()
  }
  const owner = createCaptureWindowIntegration({
    getWindow: () => current,
    isDockHidden: () => dockHidden,
    shouldHide: () => hide,
    isQuitting: () => quitting,
    ...ports
  })
  return {
    owner,
    window,
    ...ports,
    replace: () => {
      current = { ...window }
    },
    quit: () => {
      quitting = true
    }
  }
}
describe('capture window restoration ticket', () => {
  it.each([true, false])('preserves off-screen Dock state with hide preference %s', (hide) => {
    const f = fixture({ dockHidden: true, hide })
    f.owner.begin()
    expect(f.suspendDock).toHaveBeenCalledWith('screenshot', { preserveHidden: true })
    expect(f.owner.snapshot()).toMatchObject({ wasVisible: true, hidden: false })
    expect(f.hideWindow).not.toHaveBeenCalled()
    f.owner.finish('global')
    expect(f.window.showInactive).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.resumeDock).toHaveBeenCalledWith('screenshot')
  })
  it('keeps an explicitly opened business form visible after a rejected delivery from Dock', () => {
    const f = fixture({ dockHidden: true })
    f.owner.begin()
    f.owner.finish('global', { businessOpened: true, businessAccepted: false })
    expect(f.hideWindow).not.toHaveBeenCalled()
  })
  it('restores the originally hidden window and its prior focus once', () => {
    const f = fixture()
    f.owner.begin()
    f.owner.begin()
    expect(f.owner.isActive()).toBe(true)
    expect(f.suspendDock).toHaveBeenCalledTimes(1)
    expect(f.hideWindow).toHaveBeenCalledWith(f.window)
    f.owner.finish('global')
    f.owner.finish('global')
    expect(f.resumeDock).toHaveBeenCalledTimes(1)
    expect(f.window.showInactive).toHaveBeenCalledTimes(1)
    expect(f.window.focus).toHaveBeenCalledTimes(1)
    expect(f.reassertZOrder).toHaveBeenCalledWith('screenshot-finished')
    expect(f.owner.isActive()).toBe(false)
  })
  it('restores an unfocused window without stealing focus', () => {
    const f = fixture({ focused: false })
    f.owner.begin()
    f.owner.finish('global')
    expect(f.window.showInactive).toHaveBeenCalledTimes(1)
    expect(f.window.focus).not.toHaveBeenCalled()
  })
  it('does not show an originally hidden main view for cancellation or rejected business', () => {
    const f = fixture({ visible: false, focused: false })
    f.owner.begin()
    f.owner.finish('global', { businessOpened: true, businessAccepted: false })
    expect(f.hideWindow).toHaveBeenCalledTimes(1)
    expect(f.window.showInactive).not.toHaveBeenCalled()
    expect(f.window.focus).not.toHaveBeenCalled()
  })
  it('preserves the intentional business reveal after accepted delivery', () => {
    const f = fixture({ visible: false })
    f.owner.begin()
    f.owner.finish('global', { businessOpened: true, businessAccepted: true })
    expect(f.hideWindow).not.toHaveBeenCalled()
    expect(f.window.showInactive).not.toHaveBeenCalled()
  })
  it('leaves visible capture sources alone when the hide preference is disabled', () => {
    const f = fixture({ hide: false })
    f.owner.begin()
    f.owner.finish('note')
    expect(f.hideWindow).not.toHaveBeenCalled()
    expect(f.window.showInactive).not.toHaveBeenCalled()
    expect(f.resumeDock).toHaveBeenCalledTimes(1)
  })
  it('releases the suspension but does not revive a quitting or replacement window', () => {
    for (const action of ['quit', 'replace']) {
      const f = fixture()
      f.owner.begin()
      f[action]()
      f.owner.finish('global')
      expect(f.resumeDock).toHaveBeenCalledTimes(1)
      expect(f.window.showInactive).not.toHaveBeenCalled()
      expect(f.window.focus).not.toHaveBeenCalled()
    }
  })
})
