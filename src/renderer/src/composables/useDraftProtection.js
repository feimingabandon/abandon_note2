import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useMessage } from './useMessage.js'

const PREFIX = 'abandon:editing-draft:v1:'
const active = new Set()

// A fixed main-process query uses this function before replacing the renderer.
// Failed persistence is blocking: never report an in-memory draft as durable.
window.__prepareEditingDrafts = () => {
  const entries = [...active].map((entry) => entry.flush())
  return {
    dirty: entries.some((entry) => entry.dirty),
    blocked: entries.some((entry) => entry.blocked)
  }
}

export function listEditingDrafts() {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(PREFIX))
    .flatMap((key) => {
      try {
        return [{ key, ...JSON.parse(localStorage.getItem(key)) }]
      } catch {
        return []
      }
    })
}

/** Rehydrate only the form; saving remains an explicit, version-checked business action. */
export function useDraftProtection({
  key,
  fields,
  dirty,
  busy = () => false,
  extra = () => ({}),
  restoreExtra = () => {}
}) {
  const { showMessage } = useMessage()
  const storageKey = PREFIX + key
  let ready = false
  let discarded = false
  let warned = false
  let disposed = false
  const snapshot = () => ({
    ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value.value])),
    ...extra()
  })
  const entry = {
    flush() {
      if (!ready) return { dirty: dirty(), blocked: dirty() || busy() }
      if (discarded) return { dirty: false, blocked: busy() }
      const changed = dirty()
      try {
        if (changed)
          localStorage.setItem(
            storageKey,
            JSON.stringify({ updatedAt: Date.now(), data: snapshot() })
          )
        else localStorage.removeItem(storageKey)
        return { dirty: changed, blocked: busy() }
      } catch (error) {
        if (!warned) showMessage('error', '草稿暂存失败，请先保存便签再切换视图或退出。')
        warned = true
        console.error('[editing-draft] 暂存失败', error)
        return { dirty: changed, blocked: true }
      }
    }
  }
  active.add(entry)
  onMounted(async () => {
    await nextTick()
    if (disposed) return
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (saved?.data) {
        for (const [name, value] of Object.entries(fields)) {
          if (Object.hasOwn(saved.data, name)) value.value = saved.data[name]
        }
        await restoreExtra(saved.data)
        showMessage('info', '已恢复上次未保存的草稿，请核对后保存。')
      }
    } catch (error) {
      showMessage('error', '草稿恢复失败，原始草稿仍保留，请从设置导出检查。')
      console.error('[editing-draft] 恢复失败', error)
      return
    }
    if (!disposed) ready = true
  })
  watch(
    () => [snapshot(), dirty()],
    () => {
      if (ready && !discarded) entry.flush()
    },
    { deep: true, flush: 'post' }
  )
  onBeforeUnmount(() => {
    entry.flush()
    disposed = true
    active.delete(entry)
  })
  return {
    clear() {
      discarded = true
      try {
        localStorage.removeItem(storageKey)
      } catch (error) {
        console.error('[editing-draft] 清除草稿失败', error)
        showMessage('warning', '操作已完成，但旧草稿未能清除。重新打开编辑器时请核对正文。')
      }
    },
    resume() {
      discarded = false
    },
    flush: () => entry.flush()
  }
}
