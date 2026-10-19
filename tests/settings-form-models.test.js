import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, h, nextTick } from 'vue'
import { createDefaultSettings, DOCK_REVEAL_HANDLE_MODES } from '../src/shared/settings-schema.js'
import { useDockSettingsForm } from '../src/renderer/src/composables/useDockSettingsForm.js'
import { useStickySettingsForm } from '../src/renderer/src/composables/useStickySettingsForm.js'

const apps = []
const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null
})
function mount(setup) {
  let form
  const app = renderer.createApp({
    setup() {
      form = setup()
      return () => h('div')
    }
  })
  app.mount({})
  apps.push(app)
  return form
}
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
})

describe('dock domain form', () => {
  it('normalizes actual view snapshots without writing or aliasing their arrays', () => {
    const write = vi.fn()
    const defaults = createDefaultSettings('week').dock
    const form = mount(() =>
      useDockSettingsForm({ getDefaults: () => defaults, write, canWrite: () => true })
    )
    const stored = {
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.PERSISTENT,
      enabledEdges: ['right', 'bogus', 'top', 'right']
    }
    form.assignConfig(stored)
    expect(form.enabledEdges.value).toEqual(['top', 'right'])
    expect(form.revealHandleMode.value).toBe(DOCK_REVEAL_HANDLE_MODES.PERSISTENT)
    form.enabledEdges.value.pop()
    expect(stored.enabledEdges).toEqual(['right', 'bogus', 'top', 'right'])
    expect(write).not.toHaveBeenCalled()
    form.assignConfig({ revealHandleMode: 'invalid' })
    expect(form.revealHandleMode.value).toBe(DOCK_REVEAL_HANDLE_MODES.DIRECT)
    expect(form.enabledEdges.value).toEqual(defaults.enabledEdges)
  })

  it('preserves view edge ordering and a deliberate empty selection in each write', () => {
    const write = vi.fn()
    const form = mount(() =>
      useDockSettingsForm({
        getDefaults: () => ({ revealHandleMode: 'direct', enabledEdges: ['left'] }),
        write,
        canWrite: () => true
      })
    )
    form.toggleEdge('left')
    expect(write).toHaveBeenLastCalledWith({ revealHandleMode: 'direct', enabledEdges: [] })
    form.toggleEdge('right')
    form.toggleEdge('top')
    form.setRevealHandleMode(DOCK_REVEAL_HANDLE_MODES.ON_TOUCH)
    expect(write).toHaveBeenLastCalledWith({
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.ON_TOUCH,
      enabledEdges: ['top', 'right']
    })
  })

  it('blocks unsupported, reset-gated and invalid actions before optimistic mutation', () => {
    const write = vi.fn()
    let writable = true
    const form = mount(() =>
      useDockSettingsForm({
        getDefaults: () => createDefaultSettings().dock,
        write,
        canWrite: () => writable
      })
    )
    const initial = [...form.enabledEdges.value]
    form.assignRuntime({ supported: false, error: 'no desktop' })
    form.toggleEdge('left')
    form.setRevealHandleMode(DOCK_REVEAL_HANDLE_MODES.PERSISTENT)
    expect(form.runtime.value.reason).toBe('no desktop')
    form.assignRuntime({ supported: true })
    writable = false
    form.toggleEdge('right')
    writable = true
    form.toggleEdge('bottom')
    form.setRevealHandleMode('invalid')
    expect(form.enabledEdges.value).toEqual(initial)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('new-sticky defaults form', () => {
  function fixture() {
    const save = vi.fn(),
      showMessage = vi.fn()
    const form = mount(() =>
      useStickySettingsForm({ defaults: createDefaultSettings().sticky, save, showMessage })
    )
    return { form, save, showMessage }
  }

  it('expands shorthand colors, removes surrounding whitespace and saves the normalized value', async () => {
    const f = fixture()
    f.form.onColorInput({ target: { value: ' #AbC ' } })
    f.form.commitColor()
    await nextTick()
    expect(f.form.backgroundColor.value).toBe('#aabbcc')
    expect(f.form.colorInput.value).toBe('#aabbcc')
    expect(f.save.mock.calls).toEqual([['sticky.backgroundColor', '#aabbcc']])
    expect(f.form.colorInputError.value).toBe(false)
  })

  it('rejects malformed colors without persisting and lets the next edit recover', async () => {
    const f = fixture(),
      initial = f.form.backgroundColor.value
    f.form.onColorInput({ target: { value: '#abcxyz' } })
    f.form.commitColor()
    await nextTick()
    expect(f.form.backgroundColor.value).toBe(initial)
    expect(f.form.colorInput.value).toBe(initial)
    expect(f.form.colorInputError.value).toBe(true)
    expect(f.save).not.toHaveBeenCalled()
    expect(f.showMessage).toHaveBeenCalledWith(
      'warning',
      '请输入有效的便利贴十六进制颜色，如 #FFF2A8'
    )
    f.form.onColorInput({ target: { value: '#Ff00AB' } })
    expect(f.form.colorInputError.value).toBe(false)
    f.form.commitColor()
    await nextTick()
    expect(f.save).toHaveBeenCalledWith('sticky.backgroundColor', '#ff00ab')
  })

  it('treats empty input as cancellation and synchronizes snapshot/color-picker displays', async () => {
    const f = fixture()
    f.form.onColorInput({ target: { value: '' } })
    f.form.commitColor()
    await nextTick()
    expect(f.save).not.toHaveBeenCalled()
    const nextTop = !f.form.alwaysOnTop.value
    f.form.assign({
      fontSize: 24,
      backgroundColor: '#123456',
      cornerRadius: 10,
      alwaysOnTop: nextTop
    })
    await nextTick()
    expect(f.form.colorInput.value).toBe('#123456')
    expect(f.form.fontSize.value).toBe(24)
    expect(f.save.mock.calls).toEqual([
      ['sticky.fontSize', 24],
      ['sticky.backgroundColor', '#123456'],
      ['sticky.cornerRadius', 10],
      ['sticky.alwaysOnTop', nextTop]
    ])
    // The single write queue suppresses these watcher calls during real snapshot assignment.
  })

  it('stops form watchers on actual Vue unmount', async () => {
    const f = fixture()
    const app = apps.pop()
    app.unmount()
    f.form.fontSize.value = 30
    f.form.backgroundColor.value = '#654321'
    await nextTick()
    expect(f.save).not.toHaveBeenCalled()
  })
})
