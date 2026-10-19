import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const pickerUrl = new URL('../src/renderer/src/components/ui/DateTimePicker.vue', import.meta.url)

// Exercise the actual compiled picker setup. The renderer does not mount its
// child controls; popup positioning, focus, and motion belong to window tests.
async function pickerComponent() {
  const { descriptor } = parse(readFileSync(pickerUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'date-time-relative-now' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/usePopoverLifecycle.js')) {
      dependency = {
        usePopoverLifecycle: (open) => ({
          close: () => (open.value = false),
          onKeydown: vi.fn()
        })
      }
    } else if (name.endsWith('/popoverMotion.js')) {
      dependency = { enterPopover: vi.fn(), leavePopover: vi.fn() }
    } else dependency = await import(new URL(name, pickerUrl).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name} = dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}

const renderer = vue.createRenderer({
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
const apps = []
async function flush() {
  for (let index = 0; index < 4; index += 1) await vue.nextTick()
}
async function mount(overrides = {}) {
  const component = await pickerComponent()
  const props = vue.reactive({
    modelValue: '',
    relativeNow: true,
    relativeNowLabel: '保存时完成',
    ...overrides
  })
  const onUpdate = vi.fn((value) => (props.modelValue = value))
  const onChange = vi.fn()
  let state
  const wrapped = {
    ...component,
    setup(componentProps, context) {
      state = component.setup(componentProps, context)
      return state
    },
    render: () => vue.h('div')
  }
  const app = renderer.createApp({
    setup() {
      return () =>
        vue.h(wrapped, {
          ...props,
          'onUpdate:modelValue': onUpdate,
          onChange
        })
    }
  })
  app.mount({})
  apps.push(app)
  await flush()
  return { state, props, onUpdate, onChange }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-14T10:00:00.123'))
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('actual DateTimePicker relative completion intention', () => {
  it('chooses now as a relative value and displays the completion label', async () => {
    const picker = await mount()
    picker.state.toggle()
    picker.state.applyNowAndConfirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('now')
    expect(picker.onChange).toHaveBeenLastCalledWith('now')
    expect(picker.props.modelValue).toBe('now')
    expect(picker.state.displayText.value).toBe('保存时完成')
    expect(picker.state.open.value).toBe(false)
  })

  it('keeps now after reopening and confirming without a date or time change', async () => {
    const picker = await mount({ modelValue: 'now' })
    picker.state.toggle()
    vi.advanceTimersByTime(65000)
    picker.state.confirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('now')
    vi.advanceTimersByTime(65000)
    picker.state.toggle()
    picker.state.confirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenNthCalledWith(2, 'now')
    expect(picker.state.displayText.value).toBe('保存时完成')
  })

  it('keeps an empty completion relative when its opened draft is confirmed unchanged', async () => {
    const picker = await mount()
    picker.state.toggle()
    vi.advanceTimersByTime(65000)
    picker.state.confirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('now')
    expect(picker.onChange).toHaveBeenLastCalledWith('now')
  })

  it('changes relative completion to the explicit historical date and time selected', async () => {
    const picker = await mount({ modelValue: 'now' })
    picker.state.toggle()
    picker.state.selectDateCell({
      day: 13,
      month: 9,
      year: 2026,
      type: 'curr',
      isDisabled: false
    })
    picker.state.hour.value = 9
    picker.state.minute.value = 30
    picker.state.second.value = 20
    picker.state.confirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('2026-10-13 09:30:20')
    expect(picker.onChange).toHaveBeenLastCalledWith('2026-10-13 09:30:20')
    expect(picker.state.displayText.value).toBe('2026-10-13 09:30:20')
  })

  it('treats a time-only change as an explicit completion time', async () => {
    const picker = await mount({ modelValue: 'now' })
    picker.state.toggle()
    picker.state.hour.value = 9
    picker.state.minute.value = 59
    picker.state.second.value = 50
    picker.state.confirm()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('2026-10-14 09:59:50')
  })

  it('preserves an existing explicit completion when confirmed without a change', async () => {
    const picker = await mount({ modelValue: '2026-10-13 09:30:20' })
    picker.state.toggle()
    vi.advanceTimersByTime(65000)
    picker.state.confirm()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('2026-10-13 09:30:20')
  })

  it('keeps the ordinary picker now button as an absolute click time', async () => {
    const picker = await mount({ relativeNow: false })
    picker.state.toggle()
    vi.advanceTimersByTime(65000)
    picker.state.applyNowAndConfirm()
    await flush()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('2026-10-14 10:01:05')
    expect(picker.onChange).toHaveBeenLastCalledWith('2026-10-14 10:01:05')
    expect(picker.state.displayText.value).toBe('2026-10-14 10:01:05')
  })

  it('keeps an unchanged ordinary empty picker draft as an absolute selected time', async () => {
    const picker = await mount({ relativeNow: false })
    picker.state.toggle()
    vi.advanceTimersByTime(65000)
    picker.state.confirm()
    expect(picker.onUpdate).toHaveBeenLastCalledWith('2026-10-14 10:00:00')
  })

  it.each([false, true])(
    'does not emit while disabled, with relative mode %s',
    async (relativeNow) => {
      const picker = await mount({ disabled: true, relativeNow })
      picker.state.toggle()
      picker.state.applyNowAndConfirm()
      picker.state.confirm()
      expect(picker.state.open.value).toBe(false)
      expect(picker.onUpdate).not.toHaveBeenCalled()
      expect(picker.onChange).not.toHaveBeenCalled()
    }
  )
})
