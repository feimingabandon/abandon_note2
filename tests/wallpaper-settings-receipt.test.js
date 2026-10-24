import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { createDefaultSettings } from '../src/shared/settings-schema.js'

const apps = new Set()
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
async function componentAt(componentPath, showMessage) {
  const componentUrl = new URL(`../src/renderer/src/components/${componentPath}`, import.meta.url)
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'wallpaper-settings-receipt' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = [],
    declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    let dependency
    if (name === 'vue') dependency = vue
    else if (name.endsWith('.vue')) dependency = { default: {} }
    else if (name.endsWith('/useMessage.js')) dependency = { useMessage: () => ({ showMessage }) }
    else if (name.endsWith('/useScreenCapture.js'))
      dependency = { useScreenCapture: () => vi.fn(), identifiers: (value) => value }
    else if (name.endsWith('/useQueuedModal.js'))
      dependency = {
        useModalRequest: () => ({ requested: vue.ref(false) }),
        useQueuedModal: (source) => ({
          visible: vue.computed(() => Boolean(source.value)),
          finishLeave: vi.fn()
        })
      }
    else if (name.endsWith('/useDraftProtection.js'))
      dependency = {
        editingDataGeneration: vue.ref(0),
        useDraftProtection: () => ({ resume: vi.fn(), flush: () => ({}), clear: vi.fn() })
      }
    else dependency = await import(new URL(name, componentUrl).href)
    dependencies.push(dependency)
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name}=dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const node of [...imports].reverse()) code = code.slice(0, node.start) + code.slice(node.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}
async function flush() {
  for (let index = 0; index < 12; index += 1) await vue.nextTick()
}
function fixture() {
  const source = { token: 'wallpaper-settings-document', scope: 'main' }
  const values = createDefaultSettings()
  const canonical = { source, revision: 1, values }
  const pending = {
    kind: 'settings-saved',
    source,
    persistence: { status: 'saved', commitId: 'wallpaper-save' },
    snapshot: null,
    application: { status: 'failed' },
    snapshotError: { message: 'readback unavailable' }
  }
  const api = {
    getSettingsSnapshot: vi.fn(async () => canonical),
    onSettingsChanged: vi.fn(() => () => {}),
    listWallpapers: vi.fn(async () => []),
    activateWallpaper: vi.fn(async () => ({ record: { id: 9 }, snapshot: pending })),
    disableWallpaper: vi.fn(async () => pending),
    setSettingValue: vi.fn(async () => pending),
    onScreenshotDelivery: vi.fn(() => () => {})
  }
  const showMessage = vi.fn()
  vi.stubGlobal('window', { api })
  return { api, showMessage, canonical, pending }
}
async function mount(componentPath, showMessage) {
  const component = await componentAt(componentPath, showMessage)
  let state
  const app = renderer.createApp({
    ...component,
    setup(props, context) {
      state = component.setup(props, context)
      return state
    },
    render: () => vue.h('div')
  })
  apps.add(app)
  app.mount({})
  await flush()
  return state
}
afterEach(async () => {
  for (const app of apps) app.unmount()
  apps.clear()
  await flush()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wallpaper activation receipt consumers', () => {
  it('keeps activation pending without inventing enabled/activeId or another SQL request', async () => {
    const f = fixture(),
      state = await mount('wallpaper/WallpaperSettings.vue', f.showMessage)
    await state.activate({ id: 9 })
    expect(state.activeId.value).toBeNull()
    expect(state.enabled.value).toBe(false)
    expect(f.api.activateWallpaper).toHaveBeenCalledExactlyOnceWith(9)
    expect(f.showMessage).toHaveBeenCalledExactlyOnceWith(
      'warning',
      '壁纸设置已保存，当前效果尚待确认',
      4000
    )
  })

  it('assigns wallpaper selection from the actual canonical reply', async () => {
    const f = fixture(),
      state = await mount('wallpaper/WallpaperSettings.vue', f.showMessage)
    const actual = structuredClone(f.canonical)
    actual.revision = 2
    actual.values.wallpaper = { ...actual.values.wallpaper, enabled: true, activeId: 7 }
    f.api.activateWallpaper.mockResolvedValueOnce({ record: { id: 9 }, snapshot: actual })
    await state.activate({ id: 9 })
    expect(state.activeId.value).toBe(7)
    expect(state.enabled.value).toBe(true)
    expect(f.showMessage).toHaveBeenCalledExactlyOnceWith('success', '已切换主页面壁纸')
  })

  it('does not claim a saved disable is already applied without canonical values', async () => {
    const f = fixture()
    f.canonical.values.wallpaper.enabled = true
    f.canonical.values.wallpaper.activeId = 9
    const state = await mount('wallpaper/WallpaperSettings.vue', f.showMessage)
    await state.disable()
    expect(state.enabled.value).toBe(true)
    expect(f.api.disableWallpaper).toHaveBeenCalledOnce()
    expect(f.showMessage).toHaveBeenCalledExactlyOnceWith(
      'warning',
      '壁纸关闭设置已保存，当前效果尚待确认',
      4000
    )
  })

  it('keeps screenshot wallpaper activation saved-pending and clears the delivered crop only once', async () => {
    const f = fixture(),
      state = await mount('capture/CaptureDelivery.vue', f.showMessage)
    state.background.value = 'data:image/png;base64,staged'
    await state.backgroundSaved({ id: 9 })
    expect(state.background.value).toBe('')
    expect(f.api.activateWallpaper).toHaveBeenCalledExactlyOnceWith(9)
    expect(f.showMessage).toHaveBeenCalledExactlyOnceWith(
      'warning',
      '壁纸设置已保存，当前效果尚待确认',
      4000
    )
  })

  it('settles the final blur-radius save after unmount without issuing another SQL write', async () => {
    const f = fixture(),
      state = await mount('wallpaper/WallpaperSettings.vue', f.showMessage)
    state.blurRadius.value = 22
    const app = [...apps].at(-1)
    apps.delete(app)
    app.unmount()
    await flush()
    expect(f.api.setSettingValue).toHaveBeenCalledExactlyOnceWith('wallpaper.blurRadius', 22)
    expect(state.settingsSnapshots.latest().values.wallpaper.blurRadius).toBe(22)
    expect(state.settingsSnapshots.status().awaitingCanonical).toBe(true)
    expect(state.settingsSnapshots.protectedCount).toBe(0)
  })
})
