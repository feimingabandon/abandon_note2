import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { createDefaultSettings } from '../src/shared/settings-schema.js'

const componentUrl = new URL(
  '../src/renderer/src/components/weather/WeatherSettings.vue',
  import.meta.url
)
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

async function componentAt() {
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'))
  let code = compileScript(descriptor, { id: 'weather-settings-receipt' }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = [],
    declarations = []
  for (const [index, node] of imports.entries()) {
    const name = node.source.value
    dependencies.push(
      name === 'vue'
        ? vue
        : name.endsWith('.vue')
          ? { default: {} }
          : await import(new URL(name, componentUrl).href)
    )
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
  for (let index = 0; index < 16; index += 1) await vue.nextTick()
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
const candidate = {
  id: 440104,
  name: '越秀区',
  admin1: '广东省',
  admin2: '广州市',
  countryCode: 'CN',
  latitude: 23.13,
  longitude: 113.27,
  timezone: 'Asia/Shanghai'
}
function fixture() {
  const values = createDefaultSettings()
  const source = { token: 'weather-settings-document', scope: 'main' }
  values.weather.enabled = false
  const snapshot = () => ({ source, revision: 1, values: structuredClone(values) })
  const receipt = () => ({
    kind: 'settings-saved',
    source,
    persistence: { status: 'saved', commitId: 'weather-save' },
    snapshot: null,
    application: { status: 'failed' },
    snapshotError: { message: 'readback unavailable' }
  })
  const api = {
    getSettingsSnapshot: vi.fn(async () => snapshot()),
    onSettingsChanged: vi.fn(() => () => {}),
    getWeatherDivisionTree: vi.fn(async () => []),
    setSettingValue: vi.fn(async () => receipt())
  }
  vi.stubGlobal('window', { api })
  return { api, source, receipt, snapshot, values }
}
async function mount() {
  const component = await componentAt()
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

describe('WeatherSettings save receipt consumption', () => {
  it('keeps the saved location pending and enables weather only after a fresh matching canonical read', async () => {
    const f = fixture(),
      state = await mount()
    const reading = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const saving = state.choose(candidate)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.location.value.id).toBe(440104)
    expect(state.enabled.value).toBe(false)
    const actual = f.snapshot()
    actual.revision = 2
    actual.values.weather.location = candidate
    reading.resolve(actual)
    await expect(saving).resolves.toBe(true)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual([
      'weather.location',
      'weather.enabled'
    ])
    expect(state.location.value.id).toBe(440104)
    expect(state.enabled.value).toBe(true)
    expect(state.error.value).toBe('')
    expect(state.settingsSnapshots.protectedCount).toBe(0)
    expect(state.settingsSnapshots.status().awaitingCanonical).toBe(true)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('retains the saved location after raw read failure without enabling weather or rewriting the region', async () => {
    const f = fixture(),
      state = await mount()
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('raw location read unavailable'))
    await expect(state.choose(candidate)).resolves.toBe(false)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.location.value.id).toBe(440104)
    expect(state.enabled.value).toBe(false)
    expect(state.error.value).toContain('地区已保存')
    expect(state.error.value).toContain('尚待确认')
    expect(state.settingsSnapshots.protectedCount).toBe(0)
    expect(state.settingsSnapshots.status().savedCount).toBe(1)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not let a manual enable bypass the saved-region readback failure', async () => {
    const f = fixture(),
      state = await mount()
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('first raw read unavailable'))
    await state.choose(candidate)
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('manual raw read unavailable'))
    state.enabled.value = true
    await state.persistEnabled(true)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.enabled.value).toBe(false)
    expect(state.location.value.id).toBe(440104)
    expect(state.error.value).toContain('当前地区尚待确认')
    expect(state.settingsSnapshots.status().savedCount).toBe(1)
    expect(state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(3)
  })

  it('restores the manual toggle from actual state when the fresh region no longer matches', async () => {
    const f = fixture(),
      state = await mount()
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('first raw read unavailable'))
    await state.choose(candidate)
    const actual = f.snapshot()
    actual.revision = 2
    actual.values.weather.location = { ...candidate, id: 440106, name: '天河区' }
    f.api.getSettingsSnapshot.mockResolvedValueOnce(actual)
    state.enabled.value = true
    await state.persistEnabled(true)
    expect(state.enabled.value).toBe(false)
    expect(state.location.value.id).toBe(440106)
    expect(state.settingsSnapshots.protectedCount).toBe(0)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
  })

  it('does not repeat an enabled SQL after fresh canonical state already confirms it is enabled', async () => {
    const f = fixture(),
      state = await mount()
    f.api.getSettingsSnapshot.mockRejectedValueOnce(new Error('first raw read unavailable'))
    await state.choose(candidate)
    const actual = f.snapshot()
    actual.revision = 2
    actual.values.weather.location = candidate
    actual.values.weather.enabled = true
    f.api.getSettingsSnapshot.mockResolvedValueOnce(actual)
    state.enabled.value = true
    await state.persistEnabled(true)
    expect(state.enabled.value).toBe(true)
    expect(state.settingsSnapshots.protectedCount).toBe(0)
    expect(state.settingsSnapshots.status().awaitingCanonical).toBe(false)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
  })

  it('does not use a retained current snapshot when a superseded read leaves the location shadow unsettled', async () => {
    const f = fixture(),
      state = await mount(),
      reading = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const saving = state.choose(candidate)
    await flush()
    const broadcast = f.snapshot()
    broadcast.revision = 3
    broadcast.values.weather.location = candidate
    state.settingsSnapshots.acceptCommitted(broadcast)
    const older = structuredClone(broadcast)
    older.revision = 2
    reading.resolve(older)
    await expect(saving).resolves.toBe(false)
    expect(state.settingsSnapshots.status().awaitingCanonical).toBe(true)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.enabled.value).toBe(false)
  })

  it('enables only after a post-ack raw read confirms the matching broadcast and preserves newer runtime', async () => {
    const f = fixture(),
      state = await mount(),
      reading = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const saving = state.choose(candidate)
    await flush()
    const broadcast = f.snapshot()
    broadcast.revision = 2
    broadcast.values.weather.location = candidate
    broadcast.runtime = { observation: 'newer-broadcast' }
    state.settingsSnapshots.acceptCommitted(broadcast)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.enabled.value).toBe(false)
    expect(state.settingsSnapshots.status().awaitingCanonical).toBe(true)
    const raw = structuredClone(broadcast)
    raw.runtime = { observation: 'older-raw' }
    reading.resolve(raw)
    await expect(saving).resolves.toBe(true)
    await flush()
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual([
      'weather.location',
      'weather.enabled'
    ])
    expect(state.enabled.value).toBe(true)
    expect(state.location.value.id).toBe(candidate.id)
    expect(state.settingsSnapshots.latest().runtime.observation).toBe('newer-broadcast')
    expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(2)
  })

  it('stops dependent enabling when reset revokes the request during the real-region read', async () => {
    const f = fixture(),
      state = await mount(),
      reading = deferred()
    f.api.getSettingsSnapshot.mockReturnValueOnce(reading.promise)
    const saving = state.choose(candidate)
    await flush()
    const reset = f.snapshot()
    reset.revision = 3
    state.settingsSnapshots.settleReset(reset, {
      checkpoint: state.settingsSnapshots.captureIntentCheckpoint()
    })
    const old = f.snapshot()
    old.revision = 2
    old.values.weather.location = candidate
    reading.resolve(old)
    await expect(saving).resolves.toBe(false)
    expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
    expect(state.enabled.value).toBe(false)
    expect(state.location.value).toBeNull()
  })

  it.each(['source', 'region'])(
    'does not enable against a fresh read with a different %s',
    async (mismatch) => {
      const f = fixture(),
        state = await mount()
      const actual = f.snapshot()
      actual.revision = 2
      actual.values.weather.location = candidate
      if (mismatch === 'source') actual.source = { token: 'foreign-document', scope: 'main' }
      else actual.values.weather.location = { ...candidate, id: 440106, name: '天河区' }
      f.api.getSettingsSnapshot.mockResolvedValueOnce(actual)
      await expect(state.choose(candidate)).resolves.toBe(false)
      expect(f.api.setSettingValue.mock.calls.map(([id]) => id)).toEqual(['weather.location'])
      expect(state.enabled.value).toBe(false)
      expect(f.api.getSettingsSnapshot).toHaveBeenCalledTimes(2)
    }
  )

  it('treats a reset without values as unavailable without converting the old region into empty defaults', async () => {
    const f = fixture()
    f.values.weather.enabled = true
    f.values.weather.location = {
      id: 440104,
      name: '越秀区',
      admin1: '广东省',
      admin2: '广州市',
      countryCode: 'CN',
      latitude: 23.13,
      longitude: 113.27,
      timezone: 'Asia/Shanghai'
    }
    const state = await mount()
    const before = { enabled: state.enabled.value, location: state.location.value }
    state.settingsSnapshots.settleReset(f.receipt(), {
      checkpoint: state.settingsSnapshots.captureIntentCheckpoint()
    })
    await flush()
    expect(state.settingsUnavailable.value).toBe(true)
    expect({ enabled: state.enabled.value, location: state.location.value }).toEqual(before)
    await state.persistEnabled(true)
    expect(f.api.setSettingValue).not.toHaveBeenCalled()
  })
})
