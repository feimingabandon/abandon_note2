/** Small, byte-bounded LRU; promises deduplicate concurrent requests. */
export function createThumbnailCache({ maxBytes = 16 * 1024 * 1024, maxEntries = 128 } = {}) {
  const values = new Map()
  let bytes = 0
  return {
    get(key) {
      const value = values.get(key)
      if (value === undefined) return undefined
      values.delete(key)
      values.set(key, value)
      return value
    },
    set(key, value) {
      if (values.has(key)) {
        bytes -= values.get(key).length * 2
        values.delete(key)
      }
      if (value.length * 2 > maxBytes) return
      values.set(key, value)
      bytes += value.length * 2
      while (values.size > maxEntries || bytes > maxBytes) {
        const first = values.keys().next().value
        bytes -= values.get(first).length * 2
        values.delete(first)
      }
    }
  }
}
