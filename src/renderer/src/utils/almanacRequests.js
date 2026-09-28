// 同日期的卡片、工具栏与浮层共用请求；节假日更新后旧请求不能回填新缓存。
export function createAlmanacRequests(load, capacity = 256) {
  const cache = new Map()
  const pending = new Map()
  let generation = 0
  return {
    get(key) {
      if (cache.has(key)) {
        const value = cache.get(key)
        cache.delete(key)
        cache.set(key, value)
        return Promise.resolve(value)
      }
      if (pending.has(key)) return pending.get(key)
      const version = generation
      const request = Promise.resolve()
        .then(() => load(key))
        .then((value) => {
          if (version === generation && value?.almanac?.status !== 'error') {
            cache.set(key, value)
            if (cache.size > capacity) cache.delete(cache.keys().next().value)
          }
          return value
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key)
        })
      pending.set(key, request)
      return request
    },
    clear() {
      generation += 1
      cache.clear()
      pending.clear()
    }
  }
}
