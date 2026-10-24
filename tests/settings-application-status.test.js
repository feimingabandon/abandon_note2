import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const componentUrl = new URL(
  '../src/renderer/src/components/system/settings/SettingsApplicationStatus.vue',
  import.meta.url
)

async function component() {
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'))
  let code = compileScript(descriptor, {
    id: 'settings-application-status',
    inlineTemplate: true
  }).content
  const imports = babelParse(code, { sourceType: 'module' }).program.body.filter(
    (node) => node.type === 'ImportDeclaration'
  )
  const dependencies = [],
    declarations = []
  for (const [index, entry] of imports.entries()) {
    const path = entry.source.value
    const dependency =
      path === 'vue'
        ? vue
        : path.endsWith('.vue')
          ? {
              default: {
                props: ['disabled', 'loading'],
                emits: ['click'],
                setup(props, { emit, slots }) {
                  return () =>
                    vue.h(
                      'button',
                      {
                        disabled: props.disabled || props.loading,
                        onClick: () => {
                          if (!props.disabled && !props.loading) emit('click')
                        }
                      },
                      slots.default?.()
                    )
                }
              }
            }
          : await import(new URL(path, componentUrl).href)
    dependencies.push(dependency)
    for (const specifier of entry.specifiers) {
      const imported =
        specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name
      declarations.push(
        `const ${specifier.local.name} = dependencies[${index}][${JSON.stringify(imported)}];`
      )
    }
  }
  for (const entry of [...imports].reverse())
    code = code.slice(0, entry.start) + code.slice(entry.end)
  return new Function(
    'dependencies',
    declarations.join('\n') + code.replace('export default', 'return')
  )(dependencies)
}

function detach(child) {
  const siblings = child.parent?.children
  if (!siblings) return
  const index = siblings.indexOf(child)
  if (index !== -1) siblings.splice(index, 1)
}
const renderer = vue.createRenderer({
  createElement: (type) => ({ type, props: {}, children: [], text: '' }),
  createText: (text) => ({ type: '#text', text }),
  createComment: () => ({ type: '#comment', text: '' }),
  insert(child, parent, anchor) {
    detach(child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
  },
  remove: detach,
  setText: (node, text) => {
    node.text = text
  },
  setElementText(node, text) {
    node.text = text
    node.children = []
  },
  patchProp: (node, key, _previous, value) => {
    node.props[key] = value
  },
  parentNode: (node) => node.parent || null,
  nextSibling(node) {
    const siblings = node.parent?.children || []
    return siblings[siblings.indexOf(node) + 1] || null
  }
})
const apps = []
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
})
const text = (node) => (node.text || '') + (node.children || []).map(text).join('')
function find(node, attribute, value) {
  if (
    node.props &&
    Object.hasOwn(node.props, attribute) &&
    (value === undefined || node.props[attribute] === value)
  )
    return node
  for (const child of node.children || []) {
    const match = find(child, attribute, value)
    if (match) return match
  }
  return null
}
function envelope(status = 'unconfirmed', overrides = {}) {
  return {
    source: { token: 'status-document', scope: 'main' },
    ledgerRevision: 1,
    ledger: {
      scope: 'main',
      commitId: 'saved-once',
      current: {
        attempt: 1,
        reason: 'commit',
        phase: 'settled',
        targets: { domains: [], dependencies: ['theme'] },
        resolve: { status: 'applied', error: null },
        snapshot: { status: 'available', error: null },
        verification: { status: 'skipped', error: null },
        delivery: { status: 'completed', error: null, confirmation: 'invocation-only' },
        superseded: false
      },
      domains: {},
      dependencies: {
        theme: { status, error: 'theme observation', retryable: status !== 'applied' }
      },
      errors: [],
      ...overrides
    }
  }
}
async function mount(overrides = {}) {
  const props = vue.reactive({ availability: 'available', state: envelope(), ...overrides })
  const retry = vi.fn(),
    refresh = vi.fn(),
    readValues = vi.fn()
  const status = await component()
  const root = { children: [] }
  const app = renderer.createApp({
    setup() {
      return () =>
        vue.h(status, {
          ...props,
          onRetryApplication: retry,
          onReadState: refresh,
          onReadValues: readValues
        })
    }
  })
  app.mount(root)
  apps.push(app)
  await vue.nextTick()
  return { props, root, retry, refresh, readValues }
}

describe('settings save and application status UI', () => {
  it('does not claim an initial empty ledger has applied settings', async () => {
    const f = await mount({
      state: envelope(null, { commitId: null, current: null, dependencies: {} })
    })
    expect(find(f.root, 'data-settings-application-status')).toBeNull()
    expect(text(f.root)).not.toContain('已保存，已应用')
  })

  it.each([
    ['failed', 'failed', '部分设置应用失败'],
    ['deferred', 'deferred', '部分设置应用暂缓'],
    ['unconfirmed', 'unconfirmed', '应用结果尚待确认']
  ])('distinguishes %s from other saved outcomes', async (status, state, title) => {
    const f = await mount({ state: envelope(status) })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe(state)
    expect(text(f.root)).toContain(`设置已保存，${title}`)
    expect(text(f.root)).not.toContain('部分设置尚未保存')
    expect(find(f.root, 'data-settings-save-retry')).toBeNull()
  })

  it('keeps invocation-only screenshot theme observations unconfirmed and readable', async () => {
    const f = await mount()
    expect(text(f.root)).toContain('截图主题已请求，尚待确认')
    expect(text(f.root)).not.toContain('已保存，已应用')
    expect(text(f.root)).not.toContain('应用失败')
    expect(find(f.root, 'data-application-target', 'dependency:theme')).not.toBeNull()
  })

  it('ignores historical errors when all current observations are applied', async () => {
    const f = await mount({
      state: envelope('applied', {
        errors: [{ attempt: 0, stage: 'dependency:theme', error: { message: 'old failure' } }]
      })
    })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('applied')
    expect(text(f.root)).toContain('设置已保存，已应用')
    expect(text(f.root)).not.toContain('old failure')
    expect(find(f.root, 'data-settings-application-retry')).toBeNull()
  })

  it.each([
    ['resolve', 'failed'],
    ['snapshot', 'unavailable'],
    ['delivery', 'failed']
  ])('offers exact readback recovery for a current %s-only failure', async (stage, status) => {
    const state = envelope('applied')
    state.ledger.domains = Object.fromEntries(
      ['window', 'blur', 'dock'].map((key) => [key, { status: 'applied', retryable: false }])
    )
    state.ledger.dependencies = Object.fromEntries(
      ['blurConfig', 'theme', 'remote', 'resetBindings', 'resetGeometry'].map((key) => [
        key,
        { status: 'applied', retryable: false }
      ])
    )
    state.ledger.current.reason = 'retry'
    state.ledger.current.targets = { domains: [], dependencies: [] }
    state.ledger.current[stage] = { status, error: `${stage} readback failed` }
    const f = await mount({ state, awaitingCanonical: false })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('unconfirmed')
    expect(text(f.root)).toContain('重新读取应用结果')
    expect(text(f.root)).not.toContain('重试应用会使用已保存的设置')
    find(f.root, 'data-settings-application-retry').props.onClick()
    expect(f.retry).toHaveBeenCalledExactlyOnceWith({ domains: [], dependencies: [] })
    expect(f.readValues).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('does not offer readback as a substitute for a failed verification', async () => {
    const state = envelope('applied')
    state.ledger.current.verification = { status: 'failed', error: 'verification failed' }
    const f = await mount({ state })
    expect(text(f.root)).toContain('应用后的检查未完成')
    expect(text(f.root)).not.toContain('设置已保存，已应用')
    expect(find(f.root, 'data-settings-application-retry')).toBeNull()
  })

  it('allows a failed delivery to be read again without promising another verification', async () => {
    const state = envelope('applied')
    state.ledger.current.verification = { status: 'failed', error: 'verification failed' }
    state.ledger.current.delivery = { status: 'failed', error: 'delivery failed' }
    const f = await mount({ state })
    expect(text(f.root)).toContain('应用后的检查未完成')
    expect(text(f.root)).toContain('重新读取应用结果')
    expect(text(f.root)).not.toContain('重新验证')
    find(f.root, 'data-settings-application-retry').props.onClick()
    expect(f.retry).toHaveBeenCalledExactlyOnceWith({ domains: [], dependencies: [] })
  })

  it('emits only the exact currently retryable targets', async () => {
    const f = await mount({
      state: envelope('unconfirmed', {
        domains: {
          window: { status: 'applied', retryable: false },
          blur: { status: 'failed', error: 'native refused', retryable: true },
          dock: { status: 'failed', error: 'unavailable here', retryable: false }
        },
        dependencies: {
          theme: { status: 'unconfirmed', retryable: true },
          remote: { status: 'applied', retryable: false },
          resetGeometry: { status: 'deferred', retryable: true }
        }
      })
    })
    find(f.root, 'data-settings-application-retry').props.onClick()
    expect(f.retry).toHaveBeenCalledExactlyOnceWith({
      domains: ['blur'],
      dependencies: ['theme', 'resetGeometry']
    })
  })

  it('keeps unsaved local intent ahead of an older saved application failure and blocks retry', async () => {
    const f = await mount({
      state: envelope('failed'),
      hasPendingWrites: true,
      hasSaveFailures: true
    })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('unsaved')
    expect(text(f.root)).toContain('部分设置尚未保存')
    const button = find(f.root, 'data-settings-application-retry')
    expect(button.props.disabled).toBe(true)
    button.props.onClick()
    expect(f.retry).not.toHaveBeenCalled()
  })

  it('offers canonical readback separately from retrying application', async () => {
    const f = await mount({ awaitingCanonical: true })
    expect(text(f.root)).toContain('设置已保存，当前值尚待确认')
    find(f.root, 'data-settings-canonical-read').props.onClick()
    expect(f.readValues).toHaveBeenCalledOnce()
    expect(f.retry).not.toHaveBeenCalled()
  })

  it('does not claim native writes with unknown persistence have been saved', async () => {
    const f = await mount({ hasPendingWrites: true, hasUnconfirmedWrites: true })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('unsaved')
    expect(text(f.root)).toContain('保存结果尚未确认')
    expect(text(f.root)).not.toContain('设置已保存，')
    expect(find(f.root, 'data-settings-application-retry').props.disabled).toBe(true)
  })

  it('reports an unavailable application query without losing the saved observations', async () => {
    const f = await mount({
      availability: 'unavailable',
      stateError: { message: 'status unavailable' }
    })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('unavailable')
    expect(text(f.root)).toContain('设置已保存，应用状态暂不可用')
    expect(find(f.root, 'data-application-target', 'dependency:theme')).not.toBeNull()
    find(f.root, 'data-settings-application-refresh').props.onClick()
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.retry).not.toHaveBeenCalled()
  })

  it('shows an in-flight application and disables duplicate retry during leave or reset', async () => {
    const f = await mount({ applying: true, disabled: true })
    expect(find(f.root, 'data-settings-application-status').props['data-state']).toBe('applying')
    expect(text(f.root)).toContain('正在应用')
    const button = find(f.root, 'data-settings-application-retry')
    expect(button.props.disabled).toBe(true)
    button.props.onClick()
    expect(f.retry).not.toHaveBeenCalled()
  })
})
