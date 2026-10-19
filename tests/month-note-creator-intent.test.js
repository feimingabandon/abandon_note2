import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  babelParse as parseJavaScript,
  compileScript,
  parse as parseComponent
} from '@vue/compiler-sfc'
import * as vue from 'vue'
import { combineLocalDateAndTime } from '../src/shared/calendar/calendar-date-rules.js'

// Run the component's actual setup, time/status resolver and draft persistence.
// Only the child controls and shared preference transport are isolated.
const creatorUrl = new URL(
  '../src/renderer/src/components/month/MonthNoteCreator.vue',
  import.meta.url
)
const storage = {}
Object.defineProperties(storage, {
  getItem: { value: (key) => storage[key] ?? null },
  setItem: { value: (key, value) => (storage[key] = String(value)) },
  removeItem: { value: (key) => delete storage[key] }
})
const browserWindow = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
}
const apps = []
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

async function creatorComponent() {
  const { descriptor } = parseComponent(readFileSync(creatorUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'calendar-create-intent' }).content
  const imports = parseJavaScript(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = []
  const declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/useNewNotePreferences.js'))
      dependency = {
        useNewNotePreferences: () => ({
          durationKind: vue.ref('single_day'),
          durationDays: vue.ref(1),
          reminderChannels: vue.ref(2),
          isPinned: vue.ref(false),
          tagIds: vue.ref([]),
          statusChoice: vue.ref('in_progress')
        })
      }
    else if (name.endsWith('/useMessage.js'))
      dependency = { useMessage: () => ({ showMessage: vi.fn() }) }
    else dependency = await import(new URL(name, creatorUrl).href)
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
  code = code.replace('export default', 'return')
  return new Function('dependencies', declarations.join('\n') + code)(dependencies)
}

async function flush() {
  for (let index = 0; index < 8; index++) await vue.nextTick()
}
async function mount(dateKey) {
  const component = await creatorComponent()
  let state
  const app = renderer.createApp(
    {
      ...component,
      setup(props, context) {
        state = component.setup(props, context)
        return state
      },
      render: () => vue.h('div')
    },
    { dateKey }
  )
  app.mount({})
  apps.push(app)
  await flush()
  return { app, state }
}
async function crossMidnight(milliseconds) {
  vi.advanceTimersByTime(milliseconds)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-14T23:58:00'))
  for (const key of Object.keys(storage)) delete storage[key]
  browserWindow.api = {
    runtimeCapabilities: { editingDraftSessionId: 'calendar-intent-test' },
    createNoteWithAssets: vi.fn(async () => ({ id: 1 }))
  }
  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('localStorage', storage)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('calendar detailed creation keeps the entry time intention', () => {
  it('keeps tomorrow at 00:01 as an appointment when tomorrow becomes today', async () => {
    const { state } = await mount('2026-10-15')
    const appointment = combineLocalDateAndTime('2026-10-15', '00:01')
    expect(state.effectiveTimestamp.value).toBe(appointment)
    expect(state.status.value).toBe('initialized')
    await crossMidnight(130_000)
    expect(state.isImmediateDefault.value).toBe(false)
    expect(state.effectiveTimestamp.value).toBe(appointment)
    expect(state.status.value).toBe('initialized')
    expect(() => state.submissionFields()).toThrow('2 分钟')
    await crossMidnight(60_000)
    expect(state.status.value).toBe('in_progress')
    expect(state.submissionFields().effectiveAt).toBe(appointment)
  })

  it('keeps immediate creation immediate after its entry date becomes yesterday', async () => {
    const { state } = await mount('2026-10-14')
    state.content.value = '跨午夜仍立即生效'
    await crossMidnight(130_000)
    expect(state.isImmediateDefault.value).toBe(true)
    expect(state.effectiveTimestamp.value).toBeNull()
    expect(state.isHistoricalBackfill.value).toBe(false)
    await state.create()
    expect(browserWindow.api.createNoteWithAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          effectiveAt: null,
          status: 'in_progress',
          reminderChannels: 0
        })
      })
    )
  })

  it('keeps an explicitly selected time on the fixed date after midnight', async () => {
    const { state } = await mount('2026-10-14')
    state.time.value = '23:59'
    state.onTimeChange()
    await crossMidnight(130_000)
    const effectiveAt = combineLocalDateAndTime('2026-10-14', '23:59')
    expect(state.effectiveTimestamp.value).toBe(effectiveAt)
    expect(state.isHistoricalBackfill.value).toBe(true)
    expect(state.submissionFields()).toEqual({ status: 'in_progress', effectiveAt })
  })

  it('keeps historical entry at its recorded date and time', async () => {
    const { state } = await mount('2026-10-13')
    await crossMidnight(130_000)
    expect(state.isImmediateDefault.value).toBe(false)
    expect(state.submissionFields()).toEqual({
      status: 'in_progress',
      effectiveAt: combineLocalDateAndTime('2026-10-13', '00:01')
    })
  })

  it('restores a future draft as explicit time when reopened on its scheduled day', async () => {
    const first = await mount('2026-10-15')
    first.state.content.value = '预约草稿'
    await flush()
    first.app.unmount()
    await crossMidnight(130_000)
    const { state } = await mount('2026-10-15')
    expect(state.content.value).toBe('预约草稿')
    expect(state.isImmediateDefault.value).toBe(false)
    expect(state.effectiveTimestamp.value).toBe(combineLocalDateAndTime('2026-10-15', '00:01'))
    expect(state.status.value).toBe('initialized')
  })

  it('restores an immediate draft as immediate when reopened the following day', async () => {
    const first = await mount('2026-10-14')
    first.state.content.value = '立即草稿'
    await flush()
    first.app.unmount()
    await crossMidnight(130_000)
    const { state } = await mount('2026-10-14')
    expect(state.content.value).toBe('立即草稿')
    expect(state.isImmediateDefault.value).toBe(true)
    expect(state.submissionFields()).toEqual({ status: 'in_progress', effectiveAt: null })
  })

  it('restores explicit time changes without reactivating the default immediate intention', async () => {
    const first = await mount('2026-10-14')
    first.state.content.value = '明确时间草稿'
    first.state.time.value = '23:59'
    first.state.onTimeChange()
    await flush()
    first.app.unmount()
    await crossMidnight(130_000)
    const { state } = await mount('2026-10-14')
    expect(state.isImmediateDefault.value).toBe(false)
    expect(state.submissionFields().effectiveAt).toBe(
      combineLocalDateAndTime('2026-10-14', '23:59')
    )
  })

  it('keeps legacy draft date/time instead of guessing a newly immediate appointment', async () => {
    vi.setSystemTime(new Date('2026-10-15T00:00:10'))
    storage.setItem(
      'abandon:editing-draft:v2:calendar-intent-test:new:calendar:2026-10-15',
      JSON.stringify({
        data: { content: '旧预约草稿', time: '00:01', timeDirty: false }
      })
    )
    const { state } = await mount('2026-10-15')
    expect(state.isImmediateDefault.value).toBe(false)
    expect(state.effectiveTimestamp.value).toBe(combineLocalDateAndTime('2026-10-15', '00:01'))
    expect(state.remark.value).toBe('')
  })
})

describe('calendar detailed creation remark draft', () => {
  it('submits the optional remark with normalized line endings and keeps its spacing', async () => {
    const { state } = await mount('2026-10-14')
    state.content.value = '正文'
    state.remark.value = '  第一行\r\n第二行\r第三行  '
    await state.create()
    expect(browserWindow.api.createNoteWithAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          content: '正文',
          remark: '  第一行\n第二行\n第三行  '
        })
      })
    )
  })

  it('protects a remark-only draft without allowing creation without body or images', async () => {
    const { state } = await mount('2026-10-14')
    state.remark.value = '尚未填写正文的备注'
    await flush()
    expect(state.canCreate.value).toBe(false)
    expect(window.__prepareEditingDrafts().dirty).toBe(true)
    state.requestClose()
    expect(state.discardVisible.value).toBe(true)
    await state.create()
    expect(browserWindow.api.createNoteWithAssets).not.toHaveBeenCalled()
  })

  it('restores a remark-only draft when the same date creator is reopened', async () => {
    const first = await mount('2026-10-14')
    first.state.remark.value = '仅备注\n下一行'
    await flush()
    first.app.unmount()
    const { state } = await mount('2026-10-14')
    expect(state.content.value).toBe('')
    expect(state.remark.value).toBe('仅备注\n下一行')
    expect(state.dirty.value).toBe(true)
    expect(state.canCreate.value).toBe(false)
  })

  it('retains the remark after a rejected creation and restores it on reopen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindow.api.createNoteWithAssets.mockRejectedValueOnce(new Error('create rejected'))
    const first = await mount('2026-10-14')
    first.state.content.value = '失败后保留正文'
    first.state.remark.value = '失败后保留备注'
    await first.state.create()
    expect(first.state.remark.value).toBe('失败后保留备注')
    expect(first.state.saving.value).toBe(false)
    await flush()
    first.app.unmount()
    const { state } = await mount('2026-10-14')
    expect(state.content.value).toBe('失败后保留正文')
    expect(state.remark.value).toBe('失败后保留备注')
  })

  it('does not carry a saved remark into the next creator', async () => {
    const first = await mount('2026-10-14')
    first.state.content.value = '已保存正文'
    first.state.remark.value = '已保存备注'
    await flush()
    await first.state.create()
    first.app.unmount()
    const { state } = await mount('2026-10-14')
    expect(state.content.value).toBe('')
    expect(state.remark.value).toBe('')
    expect(state.dirty.value).toBe(false)
  })
})
