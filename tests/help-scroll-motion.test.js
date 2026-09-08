import { describe, expect, it } from 'vitest'
import { createHelpScrollMotion } from '../src/renderer/src/components/help/help-scroll-motion.js'

function fixture() {
  let time = 0
  let nextId = 0
  const frames = new Map()
  const motion = createHelpScrollMotion({
    now: () => time,
    requestFrame: (callback) => {
      frames.set(++nextId, callback)
      return nextId
    },
    cancelFrame: (id) => frames.delete(id)
  })
  const container = { scrollTop: 0, scrollHeight: 6000, clientHeight: 600 }
  function advance(delta) {
    time += delta
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(time))
  }
  return { motion, container, advance, frames }
}

describe('帮助导航滚动动效', () => {
  it('经过连续中间位置到达目标，并约束到容器实际范围', async () => {
    const { motion, container, advance } = fixture()
    const done = motion.scroll(container, 9000)
    expect(container.scrollTop).toBe(0)
    const samples = []
    for (let i = 0; i < 60; i++) {
      advance(16)
      samples.push(container.scrollTop)
    }
    expect(await done).toBe(true)
    expect(container.scrollTop).toBe(5400)
    expect(new Set(samples.filter((top) => top > 1 && top < 5399)).size).toBeGreaterThan(20)
    expect(samples.every((value, i) => i === 0 || value >= samples[i - 1])).toBe(true)
  })
  it('连续导航从当前帧转向最新目标，不回到旧起点或继续旧动画', async () => {
    const { motion, container, advance } = fixture()
    const old = motion.scroll(container, 5000)
    advance(300)
    const current = container.scrollTop
    const latest = motion.scroll(container, 0)
    expect(await old).toBe(false)
    expect(container.scrollTop).toBe(current)
    advance(100)
    expect(container.scrollTop).toBeLessThan(current)
    advance(900)
    expect(await latest).toBe(true)
    expect(container.scrollTop).toBe(0)
  })
  it('用户滚动或卸载时可取消动画且不再覆盖位置', async () => {
    const { motion, container, advance, frames } = fixture()
    const done = motion.scroll(container, 3000)
    advance(150)
    motion.cancel()
    container.scrollTop = 400
    advance(1000)
    expect(await done).toBe(false)
    expect(frames.size).toBe(0)
    expect(container.scrollTop).toBe(400)
  })
})
