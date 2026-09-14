import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { stopScrollInertia } from '../utils/smoothScroll.js'
import { createScrollMotion } from '../utils/scrollMotion.js'

const KEYWORD_GROUPS = [
  ['字号', '字体大小'],
  ['提醒', '通知']
]

function matchesSection(section, words) {
  const text = [
    section.textContent,
    ...[...section.querySelectorAll('[data-search-text]')].map(
      (element) => element.dataset.searchText
    )
  ]
    .join(' ')
    .toLocaleLowerCase()
  return words.every((word) => {
    const alternatives = KEYWORD_GROUPS.find((group) => group.includes(word)) || [word]
    return alternatives.some((term) => text.includes(term))
  })
}

export function useSettingsSearch(panelRef) {
  const motion = createScrollMotion()
  const cancel = () => motion.cancel()
  onBeforeUnmount(cancel)
  watch(panelRef, cancel)
  const query = ref('')
  const results = ref([])
  watch(query, async () => {
    await nextTick()
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    results.value = words.length
      ? [...(panelRef.value?.querySelectorAll('.settings-section') || [])]
          .filter((section) => matchesSection(section, words))
          .map((section) => ({ title: section.querySelector('h3')?.textContent.trim(), section }))
      : []
  })
  async function navigate(result) {
    const container = panelRef.value?.querySelector('.panel-body')
    if (!container) return
    stopScrollInertia(container)
    const completed = await motion.scroll(
      container,
      container.scrollTop +
        result.section.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        12
    )
    if (!completed || !result.section.isConnected) return
    const control = result.section.querySelector(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)'
    )
    control?.focus({ preventScroll: true })
  }
  return { query, results, navigate, cancel }
}
