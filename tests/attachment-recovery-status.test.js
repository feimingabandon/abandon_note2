import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'

const componentUrl = new URL(
  '../src/renderer/src/components/system/settings/AttachmentRecoveryStatus.vue',
  import.meta.url
)

async function component() {
  const { descriptor } = parse(readFileSync(componentUrl, 'utf8'))
  let code = compileScript(descriptor, {
    id: 'attachment-recovery-status',
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
        : {
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
  vi.unstubAllGlobals()
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
function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: 'pending-attachment-recovery-round',
    phase: 'finished',
    status: 'completed',
    partial: false,
    counts: {
      completed: 1,
      cleanupPending: 0,
      referenceMissing: 0,
      preservedConflict: 0,
      undetermined: 0
    },
    operations: [{ operationId: 'fixture', reason: 'private SQL path', decision: 'committed' }],
    ...overrides
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function settle() {
  await Promise.resolve()
  await vue.nextTick()
}
async function mount(
  getter = vi.fn().mockResolvedValue(snapshot()),
  active = true,
  retry = vi.fn().mockResolvedValue({ outcome: 'finished', report: snapshot() })
) {
  vi.stubGlobal('window', {
    api: { getAttachmentRecoveryReport: getter, retryAttachmentRecovery: retry }
  })
  const props = vue.reactive({ active })
  const logs = vi.fn()
  const status = await component()
  const root = { children: [] }
  const app = renderer.createApp({
    setup() {
      return () => vue.h(status, { ...props, onShowLogs: logs })
    }
  })
  app.mount(root)
  apps.push(app)
  await settle()
  return { props, root, app, getter, retry, logs }
}

describe('attachment recovery report UI', () => {
  it('reads only when active, once per opening, with no recovery arguments', async () => {
    const f = await mount(undefined, false)
    expect(f.getter).not.toHaveBeenCalled()
    expect(text(f.root)).toContain('不是全部附件完整性检查')
    expect(find(f.root, 'data-search-text').props['data-search-text']).toContain('引用缺失')
    f.props.active = true
    await vue.nextTick()
    await settle()
    expect(f.getter).toHaveBeenCalledExactlyOnceWith()
    await vue.nextTick()
    expect(f.getter).toHaveBeenCalledTimes(1)
    f.props.active = false
    await vue.nextTick()
    f.props.active = true
    await vue.nextTick()
    await settle()
    expect(f.getter.mock.calls).toEqual([[], []])
  })

  it.each([
    ['completed', '本轮附件恢复已完成'],
    ['cleanupPending', '本轮附件恢复仅待清理'],
    ['referenceMissing', '本轮发现附件引用缺失'],
    ['preservedConflict', '本轮附件恢复保留了冲突'],
    ['undetermined', '本轮附件恢复仍有无法判定的操作']
  ])(
    'shows the %s outcome without exposing storage implementation details',
    async (status, title) => {
      const f = await mount(vi.fn().mockResolvedValue(snapshot({ status })))
      expect(text(f.root)).toContain(title)
      expect(find(f.root, 'data-attachment-recovery').props['data-state']).toBe(status)
      expect(text(f.root)).not.toContain('private SQL path')
      expect(text(f.root)).not.toContain('committed')
      expect(text(f.root)).not.toContain('重试恢复')
    }
  )

  it('describes an empty successful round without claiming full attachment health', async () => {
    const value = snapshot({
      operations: [],
      counts: {
        completed: 0,
        cleanupPending: 0,
        referenceMissing: 0,
        preservedConflict: 0,
        undetermined: 0
      }
    })
    const f = await mount(vi.fn().mockResolvedValue(value))
    expect(text(f.root)).toContain('本轮未发现待恢复操作')
    expect(text(f.root)).toContain('仅反映本轮待恢复操作，不是全部附件完整性检查')
    expect(text(f.root)).not.toContain('全部附件正常')
  })

  it.each([
    ['not-started', '尚未运行本轮附件恢复'],
    ['running', '本轮附件恢复进行中'],
    ['failed', '本轮附件恢复未完成']
  ])('distinguishes the %s phase from a completed round', async (phase, title) => {
    const f = await mount(
      vi
        .fn()
        .mockResolvedValue(
          snapshot({ phase, status: 'undetermined', partial: true, operations: [] })
        )
    )
    expect(text(f.root)).toContain(title)
    expect(text(f.root)).not.toContain('本轮未发现待恢复操作')
    expect(find(f.root, 'data-attachment-recovery').props['data-phase']).toBe(phase)
    if (phase === 'not-started') expect(find(f.root, 'data-recovery-count')).toBeNull()
    else expect(text(f.root)).toContain('报告尚不完整')
  })

  it('keeps overlapping counts separate with their explicit limitation', async () => {
    const value = snapshot({
      status: 'referenceMissing',
      counts: {
        completed: 0,
        cleanupPending: 1,
        referenceMissing: 1,
        preservedConflict: 0,
        undetermined: 0
      }
    })
    const f = await mount(vi.fn().mockResolvedValue(value))
    expect(text(find(f.root, 'data-recovery-count', 'cleanupPending'))).toContain('仅待清理：1')
    expect(text(find(f.root, 'data-recovery-count', 'referenceMissing'))).toContain('引用缺失：1')
    expect(text(f.root)).toContain('各项数量不能相加作为操作总数')
    expect(text(f.root)).not.toContain('共 2')
  })

  it('shows query failure as unavailable and can read again without triggering recovery', async () => {
    const getter = vi
      .fn()
      .mockRejectedValueOnce(new Error('private database path'))
      .mockResolvedValueOnce(snapshot())
    const f = await mount(getter)
    expect(text(f.root)).toContain('报告暂不可用')
    expect(find(f.root, 'data-attachment-recovery').props['data-state']).toBe('unavailable')
    expect(text(f.root)).not.toContain('private database path')
    expect(find(f.root, 'data-recovery-count')).toBeNull()
    find(f.root, 'data-attachment-recovery-read').props.onClick()
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复已完成')
    expect(getter.mock.calls).toEqual([[], []])
    find(f.root, 'data-attachment-recovery-logs').props.onClick()
    expect(f.logs).toHaveBeenCalledOnce()
  })

  it('does not turn a malformed response into an empty successful round', async () => {
    const f = await mount(vi.fn().mockResolvedValue({}))
    expect(text(f.root)).toContain('报告暂不可用')
    expect(text(f.root)).not.toContain('本轮未发现待恢复操作')
  })

  it('ignores an older opening result after close and a new read', async () => {
    const old = deferred(),
      current = deferred()
    const f = await mount(
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    )
    expect(text(f.root)).toContain('正在读取')
    expect(find(f.root, 'data-attachment-recovery-read').props.disabled).toBe(true)
    f.props.active = false
    await vue.nextTick()
    f.props.active = true
    await vue.nextTick()
    current.resolve(snapshot({ status: 'preservedConflict' }))
    await settle()
    old.resolve(snapshot())
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复保留了冲突')
    expect(text(f.root)).not.toContain('本轮附件恢复已完成')
  })

  it('keeps a closed report unread when its pending request completes', async () => {
    const pending = deferred()
    const f = await mount(vi.fn().mockReturnValue(pending.promise))
    f.props.active = false
    await vue.nextTick()
    pending.resolve(snapshot())
    await settle()
    expect(find(f.root, 'data-attachment-recovery').props['data-state']).toBe('unread')
    expect(find(f.root, 'data-recovery-count')).toBeNull()
    expect(text(f.root)).not.toContain('本轮附件恢复已完成')
    expect(find(f.root, 'data-attachment-recovery-read').props.disabled).toBe(true)
  })

  it('ignores a rejection from an obsolete read', async () => {
    const old = deferred()
    const f = await mount(
      vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot())
    )
    f.props.active = false
    await vue.nextTick()
    f.props.active = true
    await vue.nextTick()
    await settle()
    old.reject(new Error('late failure'))
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复已完成')
    expect(text(f.root)).not.toContain('报告暂不可用')
  })

  it('does not render a late report after unmount', async () => {
    const pending = deferred()
    const f = await mount(vi.fn().mockReturnValue(pending.promise))
    f.app.unmount()
    apps.splice(apps.indexOf(f.app), 1)
    pending.resolve(snapshot())
    await settle()
    expect(f.root.children).toEqual([])
    expect(f.logs).not.toHaveBeenCalled()
  })

  it('shows a finished recovery round without promising every attachment issue is fixed', async () => {
    const value = snapshot({
      status: 'referenceMissing',
      counts: {
        completed: 0,
        cleanupPending: 0,
        referenceMissing: 1,
        preservedConflict: 0,
        undetermined: 0
      }
    })
    const retry = vi.fn().mockResolvedValue({ outcome: 'finished', report: value })
    const f = await mount(undefined, true, retry)
    expect(retry).not.toHaveBeenCalled()
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(retry).toHaveBeenCalledExactlyOnceWith()
    expect(text(f.root)).toContain('本轮附件恢复已结束')
    expect(text(f.root)).toContain('请查看报告中的各项结果')
    expect(text(find(f.root, 'data-recovery-count', 'referenceMissing'))).toContain('引用缺失：1')
    expect(text(f.root)).not.toContain('全部修复')
    expect(text(f.root)).not.toContain('private SQL path')
    expect(find(f.root, 'data-attachment-recovery-read').props.disabled).toBe(false)
    find(f.root, 'data-attachment-recovery-read').props.onClick()
    await settle()
    expect(f.getter.mock.calls).toEqual([[], []])
    expect(text(f.root)).not.toContain('本轮附件恢复已结束')
  })

  it('keeps a failed round partial and permits a subsequent attempt', async () => {
    const value = snapshot({
      status: 'undetermined',
      phase: 'failed',
      partial: true,
      failure: { phase: 'read-decision', reason: 'private SQL path' }
    })
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'failed', report: value })
      .mockResolvedValueOnce({ outcome: 'finished', report: snapshot() })
    const f = await mount(undefined, true, retry)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复未完成')
    expect(text(f.root)).toContain('报告尚不完整')
    expect(find(f.root, 'data-attachment-recovery').props['data-phase']).toBe('failed')
    expect(text(f.root)).not.toContain('private SQL path')
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(false)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(retry.mock.calls).toEqual([[], []])
    expect(text(f.root)).toContain('本轮附件恢复已结束')
  })

  it('reports IPC rejection generically and keeps both later reads and attempts available', async () => {
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error('private SQL path'))
      .mockResolvedValueOnce({ outcome: 'finished', report: snapshot() })
    const f = await mount(undefined, true, retry)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(text(f.root)).toContain('恢复未开始或未完成')
    expect(text(f.root)).toContain('请重新读取报告，或查看日志了解详情')
    expect(text(f.root)).not.toContain('private SQL path')
    expect(find(f.root, 'data-recovery-count')).toBeNull()
    find(f.root, 'data-attachment-recovery-read').props.onClick()
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复已完成')
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复已结束')
    find(f.root, 'data-attachment-recovery-logs').props.onClick()
    expect(f.logs).toHaveBeenCalledOnce()
  })

  it.each([
    {},
    { outcome: 'finished', report: {} },
    { outcome: 'finished', report: snapshot({ phase: 'failed', partial: true }) },
    { outcome: 'failed', report: snapshot() }
  ])('does not claim a completed recovery for a malformed result %#', async (result) => {
    const f = await mount(undefined, true, vi.fn().mockResolvedValue(result))
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    await settle()
    expect(text(f.root)).toContain('恢复未开始或未完成')
    expect(text(f.root)).not.toContain('本轮附件恢复已结束')
    expect(find(f.root, 'data-recovery-count')).toBeNull()
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(false)
  })

  it('blocks recovery during a read and blocks duplicate recovery and manual reads until settling', async () => {
    const initial = deferred(),
      pending = deferred()
    const retry = vi.fn().mockReturnValue(pending.promise)
    const f = await mount(vi.fn().mockReturnValue(initial.promise), true, retry)
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(true)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    expect(retry).not.toHaveBeenCalled()
    initial.resolve(snapshot())
    await settle()
    const button = find(f.root, 'data-attachment-recovery-retry')
    const read = find(f.root, 'data-attachment-recovery-read')
    button.props.onClick()
    button.props.onClick()
    read.props.onClick()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(f.getter).toHaveBeenCalledTimes(1)
    await vue.nextTick()
    expect(text(f.root)).toContain('正在尝试恢复附件')
    expect(button.props.disabled).toBe(true)
    expect(read.props.disabled).toBe(true)
    find(f.root, 'data-attachment-recovery-logs').props.onClick()
    expect(f.logs).toHaveBeenCalledOnce()
    pending.resolve({ outcome: 'finished', report: snapshot() })
    await settle()
    expect(button.props.disabled).toBe(false)
    expect(read.props.disabled).toBe(false)
  })

  it('retains the in-flight admission across closing while a reopened snapshot supersedes the old result', async () => {
    const pending = deferred()
    const getter = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ phase: 'running', status: 'undetermined', partial: true }))
      .mockResolvedValueOnce(snapshot({ status: 'preservedConflict' }))
    const retry = vi.fn().mockReturnValue(pending.promise)
    const f = await mount(getter, true, retry)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    f.props.active = false
    await vue.nextTick()
    f.props.active = true
    await vue.nextTick()
    await settle()
    expect(getter).toHaveBeenCalledTimes(2)
    expect(text(f.root)).toContain('本轮附件恢复进行中')
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(true)
    expect(find(f.root, 'data-attachment-recovery-read').props.disabled).toBe(true)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    expect(retry).toHaveBeenCalledTimes(1)
    pending.resolve({ outcome: 'finished', report: snapshot() })
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复进行中')
    expect(text(f.root)).not.toContain('本轮附件恢复已结束')
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(false)
    find(f.root, 'data-attachment-recovery-read').props.onClick()
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复保留了冲突')
  })

  it('ignores an obsolete recovery rejection after reopening and leaves the new read usable', async () => {
    const pending = deferred()
    const f = await mount(undefined, true, vi.fn().mockReturnValue(pending.promise))
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    f.props.active = false
    await vue.nextTick()
    f.props.active = true
    await vue.nextTick()
    await settle()
    pending.reject(new Error('private SQL path'))
    await settle()
    expect(text(f.root)).toContain('本轮附件恢复已完成')
    expect(text(f.root)).not.toContain('恢复未开始或未完成')
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(false)
  })

  it('keeps a closed recovery result out of the display and reads fresh on reopening', async () => {
    const pending = deferred()
    const f = await mount(undefined, true, vi.fn().mockReturnValue(pending.promise))
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    f.props.active = false
    await vue.nextTick()
    pending.resolve({ outcome: 'finished', report: snapshot() })
    await settle()
    expect(text(f.root)).not.toContain('本轮附件恢复已结束')
    expect(find(f.root, 'data-recovery-count')).toBeNull()
    f.props.active = true
    await vue.nextTick()
    await settle()
    expect(f.getter).toHaveBeenCalledTimes(2)
    expect(find(f.root, 'data-attachment-recovery-retry').props.disabled).toBe(false)
  })

  it('does not publish a recovery response after unmount', async () => {
    const pending = deferred()
    const retry = vi.fn().mockReturnValue(pending.promise)
    const f = await mount(undefined, true, retry)
    find(f.root, 'data-attachment-recovery-retry').props.onClick()
    f.app.unmount()
    apps.splice(apps.indexOf(f.app), 1)
    pending.resolve({ outcome: 'finished', report: snapshot() })
    await settle()
    expect(f.root.children).toEqual([])
    expect(retry).toHaveBeenCalledExactlyOnceWith()
    expect(f.logs).not.toHaveBeenCalled()
  })
})
