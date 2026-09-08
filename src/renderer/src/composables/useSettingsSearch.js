import { nextTick, ref, watch } from 'vue'
import { stopScrollInertia } from '../utils/smoothScroll.js'

export function useSettingsSearch(panelRef) {
  const query = ref('')
  const results = ref([])
  watch(query, async () => {
    await nextTick()
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    results.value = words.length
      ? [...(panelRef.value?.querySelectorAll('.settings-section') || [])]
          .filter((section) =>
            words.every((word) => section.textContent.toLocaleLowerCase().includes(word))
          )
          .map((section) => ({ title: section.querySelector('h3')?.textContent.trim(), section }))
      : []
  })
  function navigate(result) {
    const container = panelRef.value?.querySelector('.panel-body')
    if (!container) return
    stopScrollInertia(container)
    container.scrollTop +=
      result.section.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
    const control = result.section.querySelector(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)'
    )
    control?.focus({ preventScroll: true })
  }
  return { query, results, navigate }
}
