import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { stopScrollInertia } from '../utils/smoothScroll.js'
import { createScrollMotion } from '../utils/scrollMotion.js'

const KEYWORD_GROUPS = [
  ['字号', '字体大小'],
  ['提醒', '通知']
]

function matchesText(text, words) {
  text = text.toLocaleLowerCase()
  return words.every((word) => {
    const alternatives = KEYWORD_GROUPS.find((group) => group.includes(word)) || [word]
    return alternatives.some((term) => text.includes(term))
  })
}

function searchableText(element) {
  return [
    element.textContent,
    element.dataset.searchText,
    ...[...element.querySelectorAll('[data-search-text]')].map((node) => node.dataset.searchText)
  ].join(' ')
}

function itemTitle(element) {
  const label = element.querySelector('.setting-label, .sched-task-name, h4') || element
  const copy = label.cloneNode(true)
  copy.querySelectorAll('button, small, .remote-health-badge').forEach((node) => node.remove())
  return copy.textContent.replace(/\s+/g, ' ').trim()
}

function searchItems(panel, words) {
  if (!words.length || !panel) return []
  const results = []
  for (const [sectionIndex, section] of [
    ...panel.querySelectorAll('.settings-section')
  ].entries()) {
    const heading = section.querySelector('.section-title')
    const title = itemTitle(heading)
    const category = section.closest('.settings-category')?.querySelector('.category-title')
    const context = [category?.textContent, title, section.dataset.searchText].join(' ')
    const candidates = [
      ...section.querySelectorAll(
        '.setting-item:not(.setting-button-row), .setting-button-row button, [data-settings-search-item], .sched-task-card'
      )
    ]
    // 搜索分区名时只提供一个入口，避免把整个分区的每一行都列作结果。
    if (matchesText(context, words)) {
      results.push({ key: 'section-' + sectionIndex, title, target: section })
      continue
    }
    for (const [index, target] of candidates.entries()) {
      if (matchesText(context + ' ' + searchableText(target), words)) {
        results.push({ key: sectionIndex + '-' + index, title: itemTitle(target), target })
      }
    }
  }
  return results
}

export function useSettingsSearch(panelRef, { beforeNavigate } = {}) {
  const motion = createScrollMotion()
  let navigation = 0
  let highlighted = null
  let highlightTimer = null
  const clearHighlight = () => {
    clearTimeout(highlightTimer)
    highlighted?.classList.remove('settings-search-target')
    highlighted = null
  }
  const cancel = () => {
    navigation++
    motion.cancel()
    clearHighlight()
  }
  onBeforeUnmount(cancel)
  watch(panelRef, cancel)
  const query = ref('')
  const results = ref([])
  watch([query, panelRef], async () => {
    cancel()
    await nextTick()
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    results.value = searchItems(panelRef.value, words)
  })
  async function navigate(result) {
    cancel()
    const current = navigation
    const target = result.target
    await beforeNavigate?.(target)
    if (current !== navigation || !target.isConnected) return
    const container = panelRef.value?.querySelector('.panel-body')
    if (!container) return
    stopScrollInertia(container)
    const completed = await motion.scroll(
      container,
      container.scrollTop +
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        8
    )
    if (!completed || current !== navigation || !target.isConnected) return
    const selector =
      'button:not(:disabled):not(.setting-help-btn), input:not(:disabled), select:not(:disabled), [role="slider"]:not([aria-disabled="true"]), [role="switch"]:not([aria-disabled="true"])'
    const control = target.matches(selector) ? target : target.querySelector(selector)
    if (!control) target.tabIndex = -1
    ;(control || target).focus({ preventScroll: true })
    highlighted = target
    target.classList.add('settings-search-target')
    highlightTimer = setTimeout(clearHighlight, 1600)
  }
  return { query, results, navigate, cancel }
}
