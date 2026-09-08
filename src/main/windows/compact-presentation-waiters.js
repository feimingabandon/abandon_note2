import { PRESENTATION_STAGES } from './compact-window-controller.js'

const stages = new Set(Object.values(PRESENTATION_STAGES))
const valid = (generation, stage) =>
  Number.isInteger(generation) && generation > 0 && stages.has(stage)

/** 确认可能先于等待到达；只有当前窗口、当前代次及当前阶段的确认由调用方传入。 */
export class CompactPresentationWaiters {
  constructor(timeoutMs = 2000) {
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.completed = new Map()
  }

  wait(generation, stage) {
    if (!valid(generation, stage)) return Promise.reject(new Error('无效的胶囊呈现阶段'))
    const key = `${generation}:${stage}`
    if (this.completed.has(key)) return Promise.resolve()
    if (this.pending.has(key))
      return Promise.reject(new Error(`胶囊呈现阶段存在重复等待器：${stage}`))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`Renderer 未及时完成胶囊呈现阶段：${stage}`))
      }, this.timeoutMs)
      this.pending.set(key, { generation, timer, resolve })
    })
  }

  acknowledge(generation, stage) {
    if (!valid(generation, stage)) return false
    const key = `${generation}:${stage}`
    this.completed.set(key, generation)
    const waiter = this.pending.get(key)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.pending.delete(key)
      waiter.resolve()
    }
    return true
  }

  clear(generation) {
    for (const [key, waiter] of this.pending) {
      if (waiter.generation !== generation) continue
      clearTimeout(waiter.timer)
      this.pending.delete(key)
      waiter.resolve()
    }
    for (const [key, completedGeneration] of this.completed) {
      if (completedGeneration === generation) this.completed.delete(key)
    }
  }
}
