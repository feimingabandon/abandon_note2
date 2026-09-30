import { afterEach, describe, expect, it } from 'vitest'
import { createRenderer, h, nextTick, ref } from 'vue'
import { useQueuedModal, useModalRequest } from '../src/renderer/src/composables/useQueuedModal.js'

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
function mount(requested, options) {
  let modal
  const app = renderer.createApp({
    setup() {
      modal = useQueuedModal(requested, options)
      return () => h('div', modal.visible.value ? 'shown' : 'waiting')
    }
  })
  app.mount({})
  apps.push(app)
  return modal
}
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await nextTick()
})

describe('queued modal lifecycle', () => {
  it('ignores a cancelled generation when handoff and reopen share a tick', async () => {
    const a = ref(true),
      b = ref(true),
      c = ref(true)
    const first = mount(a),
      second = mount(b),
      third = mount(c)
    await nextTick()
    a.value = false
    first.finishLeave()
    b.value = false
    b.value = true
    await nextTick()
    await nextTick()
    expect([second.visible.value, third.visible.value]).toEqual([false, true])
    c.value = false
    third.finishLeave()
    await nextTick()
    expect(second.visible.value).toBe(true)
  })

  it('preserves source request order through batched wrapper props', async () => {
    let controllers
    const displayed = []
    const Child = {
      props: ['queue', 'requested', 'index'],
      setup(props) {
        return () => {
          displayed[props.index] = props.requested && props.queue.visible.value
          if (displayed[props.index]) props.queue.markPresented()
          return h('div')
        }
      }
    }
    const Wrapper = {
      props: ['queue', 'requested', 'index'],
      setup: (props) => () => h(Child, props)
    }
    const app = renderer.createApp({
      setup() {
        controllers = [useModalRequest(), useModalRequest(), useModalRequest()]
        return () =>
          h(
            'div',
            controllers.map((queue, index) =>
              h(Wrapper, {
                key: index,
                index,
                queue,
                requested: queue.requested.value
              })
            )
          )
      }
    })
    app.mount({})
    apps.push(app)
    controllers[2].requested.value = true
    controllers[1].requested.value = true
    controllers[0].requested.value = true
    await nextTick()
    expect(displayed).toEqual([false, false, true])
    controllers[2].requested.value = false
    controllers[2].finishLeave()
    await nextTick()
    await nextTick()
    expect(displayed).toEqual([false, true, false])
  })

  it('cancels an external request before its conditional component mounts', async () => {
    const a = ref(false),
      b = ref(false)
    mount(a, { external: true })
    const second = mount(b)
    a.value = true
    await nextTick()
    a.value = false
    b.value = true
    await nextTick()
    await nextTick()
    expect(second.visible.value).toBe(true)
  })

  it('shows only the oldest request and waits for actual leave completion', async () => {
    const a = ref(false),
      b = ref(false),
      c = ref(false)
    const first = mount(a),
      second = mount(b),
      third = mount(c)
    b.value = true
    c.value = true
    a.value = true
    await nextTick()
    expect([first.visible.value, second.visible.value, third.visible.value]).toEqual([
      false,
      true,
      false
    ])
    b.value = false
    await nextTick()
    expect(third.visible.value).toBe(false)
    second.finishLeave()
    await nextTick()
    expect(third.visible.value).toBe(true)
    expect(first.visible.value).toBe(false)
  })

  it('coalesces repeated opens and cancels a pending unmount without leaking a ticket', async () => {
    const a = ref(true),
      b = ref(true),
      c = ref(true)
    const first = mount(a)
    mount(b)
    const last = mount(c)
    b.value = true
    apps[1].unmount()
    apps.splice(1, 1)
    await nextTick()
    a.value = false
    first.finishLeave()
    await nextTick()
    expect(last.visible.value).toBe(true)
  })

  it('releases an open cancelled before it ever rendered', async () => {
    const a = ref(false),
      b = ref(false)
    mount(a)
    const second = mount(b)
    a.value = true
    a.value = false
    b.value = true
    await nextTick()
    await nextTick()
    expect(second.visible.value).toBe(true)
  })

  it('keeps its position if a closing transition reverses', async () => {
    const a = ref(true),
      b = ref(true)
    const first = mount(a),
      second = mount(b)
    await nextTick()
    a.value = false
    a.value = true
    first.finishLeave()
    await nextTick()
    expect(first.visible.value).toBe(true)
    expect(second.visible.value).toBe(false)
  })
})
