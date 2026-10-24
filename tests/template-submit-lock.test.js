import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { ownPopover, releasePopover } from '../src/renderer/src/utils/anchoredPopover.js'

const formUrl = new URL('../src/renderer/src/components/template/TemplateForm.vue', import.meta.url)
async function formComponent() {
  const { descriptor } = parse(readFileSync(formUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'template-submit-lock' }).content
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
    else if (name.endsWith('/useDraftProtection.js'))
      dependency = {
        editingDataGeneration: vue.ref(0),
        useDraftProtection: () => ({
          clear: vi.fn(async () => true),
          resume: vi.fn(async () => true),
          flush: vi.fn(async () => ({ persisted: true, blocked: false, dirty: true }))
        })
      }
    else if (name.endsWith('/useTemplatePreviewClock.js'))
      dependency = { useTemplatePreviewClock: () => ({ sync: vi.fn() }) }
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
    else dependency = await import(new URL(name, formUrl).href)
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
const registeredPanels = []
let frames
let frameId
let listeners

function element(children = []) {
  let inert = false
  const node = {
    children,
    isConnected: true,
    disabled: false,
    contains(target) {
      return target === node || children.some((child) => child.contains(target))
    },
    matches: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
    focus: vi.fn(() => {
      if (!node.inert) document.activeElement = node
    }),
    get inert() {
      return inert
    },
    set inert(value) {
      inert = value
      if (value && node.contains(document.activeElement)) document.activeElement = document.body
    }
  }
  return node
}
async function flush() {
  for (let i = 0; i < 4; i += 1) await vue.nextTick()
}
function nextFrame() {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback()
}
function registerPanel(panel, trigger) {
  ownPopover(panel, trigger)
  registeredPanels.push(panel)
}
async function mount(editorMode = false) {
  const component = await formComponent()
  const props = vue.reactive({ active: false, submitting: false, editorMode })
  let state
  const onSubmit = vi.fn(() => {
    props.submitting = true
  })
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
      return () => vue.h(wrapped, { ...props, onSubmit })
    }
  })
  app.mount({})
  apps.push(app)
  await flush()
  const textarea = element(),
    trigger = element(),
    submitButton = element()
  const fields = element([textarea, trigger])
  const root = element([fields, submitButton])
  root.querySelector = (selector) =>
    selector === '.tf-fields' ? fields : selector === 'textarea' ? textarea : null
  state.formRootRef.value = root
  state.content.value = '本次提交的正文'
  state.previewAt.value = Date.now() + 86_400_000
  props.active = true
  await flush()
  return { app, state, props, onSubmit, textarea, fields, root, trigger, submitButton }
}

beforeEach(() => {
  frames = new Map()
  frameId = 0
  listeners = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
  vi.stubGlobal('document', {
    body: {},
    activeElement: null,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => {
      if (listeners.get(name) === handler) listeners.delete(name)
    }
  })
  document.activeElement = document.body
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: () => '',
    fontSize: '14px',
    fontFamily: 'sans-serif'
  }))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('window', {
    api: {
      runtimeCapabilities: { editingDraftSessionId: 'template-submit-lock' },
      listTags: async () => [],
      previewTemplateNextRun: async () => Date.now() + 86_400_000
    }
  })
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  for (const panel of registeredPanels.splice(0)) releasePopover(panel)
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('actual recurring-template form submission lock', () => {
  it.each([false, true])(
    'locks fields and owned Teleport panels immediately in editor mode %s, preserving a failed draft',
    async (editorMode) => {
      const form = await mount(editorMode)
      const popupInput = element(),
        panel = element([popupInput])
      registerPanel(panel, form.trigger)
      popupInput.focus()
      const submission = form.state.submit()
      expect(form.onSubmit).not.toHaveBeenCalled()
      expect(form.fields.inert).toBe(true)
      expect(panel.inert).toBe(true)
      expect(form.state.canSubmit.value).toBe(false)
      await submission
      await form.state.submit()
      expect(form.onSubmit).toHaveBeenCalledTimes(1)
      await flush()
      form.props.submitting = false
      await flush()
      expect(form.fields.inert).toBe(false)
      expect(panel.inert).toBe(false)
      expect(form.state.content.value).toBe('本次提交的正文')
      expect(document.activeElement).toBe(popupInput)
    }
  )

  it('locks late registered and leaving panels, and restores their original inert states', async () => {
    const form = await mount()
    form.submitButton.focus()
    await form.state.submit()
    await flush()
    const late = element(),
      alreadyInert = element()
    alreadyInert.inert = true
    registerPanel(late, form.trigger)
    registerPanel(alreadyInert, form.trigger)
    nextFrame()
    expect(late.inert).toBe(true)
    releasePopover(late)
    form.props.submitting = false
    await flush()
    expect(late.inert).toBe(false)
    expect(alreadyInert.inert).toBe(true)
    expect(listeners.has('pointerdown')).toBe(false)
  })

  it('waits until saving ends before restoring new-content focus after a successful reset', async () => {
    const form = await mount()
    form.submitButton.focus()
    await form.state.submit()
    await flush()
    await form.state.reset()
    await flush()
    expect(form.state.content.value).toBe('')
    expect(form.textarea.focus).not.toHaveBeenCalled()
    form.props.submitting = false
    await flush()
    expect(form.textarea.focus).toHaveBeenCalledTimes(1)
    expect(form.fields.inert).toBe(false)
  })

  it('does not steal focus after an outside interaction or an inactive form', async () => {
    const form = await mount()
    form.submitButton.focus()
    await form.state.submit()
    await flush()
    listeners.get('pointerdown')({ target: element() })
    await form.state.reset()
    form.props.submitting = false
    await flush()
    expect(form.textarea.focus).not.toHaveBeenCalled()
    form.submitButton.focus()
    form.state.content.value = '第二条'
    form.state.previewAt.value = Date.now() + 86_400_000
    await form.state.submit()
    await flush()
    form.props.active = false
    await form.state.reset()
    form.props.submitting = false
    await flush()
    expect(form.textarea.focus).not.toHaveBeenCalled()
  })

  it('releases detached Teleport surfaces on unmount without restoring focus', async () => {
    const form = await mount(true)
    const panel = element()
    registerPanel(panel, form.trigger)
    form.submitButton.focus()
    await form.state.submit()
    await flush()
    panel.isConnected = false
    form.app.unmount()
    await flush()
    expect(panel.inert).toBe(false)
    expect(form.fields.inert).toBe(false)
    expect(listeners.has('pointerdown')).toBe(false)
    expect(form.textarea.focus).not.toHaveBeenCalled()
  })
})
