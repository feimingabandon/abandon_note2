export class CompactPresentationCompletion {
  constructor() {
    this.pending = new Map()
  }

  wait(generation, timeoutMs) {
    this.clear(generation)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(generation)
        resolve({ status: 'timeout', generation })
      }, timeoutMs)
      this.pending.set(generation, {
        finish: (status) => {
          clearTimeout(timer)
          this.pending.delete(generation)
          resolve({ status, generation })
        }
      })
    })
  }

  acknowledge(generation) {
    const entry = this.pending.get(generation)
    if (!entry) return false
    entry.finish('completed')
    return true
  }

  clear(generation) {
    const entry = this.pending.get(generation)
    if (!entry) return false
    entry.finish('cancelled')
    return true
  }

  clearAll() {
    for (const generation of [...this.pending.keys()]) this.clear(generation)
  }
}
