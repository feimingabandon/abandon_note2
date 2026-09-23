<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { helpArticles, helpGroups } from './help-content.js'
import { resolveHelpQuickLinks } from './help-quick-links.js'
import { highlightHelp, searchHelp } from './help-search.js'
import { createHelpScrollMotion } from './help-scroll-motion.js'
import { stopScrollInertia } from '../../utils/smoothScroll.js'
import HelpMock from './HelpMock.vue'
import MockNewNotePanel from './mock/MockNewNotePanel.vue'
import MockTemplatePage from './mock/MockTemplatePage.vue'
import MockModeComparison from './mock/MockModeComparison.vue'
import MockStickyWindow from './mock/MockStickyWindow.vue'
import wechatAppreciationQr from '../../resources/help/wechat-appreciation-qr.png'
import alipayAppreciationQr from '../../resources/help/alipay-appreciation-qr.jpg'

const props = defineProps({ viewMode: { type: String, default: 'list' } })
const emit = defineEmits(['close'])
const profile = {
  github: 'https://github.com/feimingabandon/abandon_note2',
  gitcode: 'https://gitcode.com/zou-feiming/abandon_note2',
  blog: 'https://blog.csdn.net/qq_43483251',
  email: '1160653906@qq.com'
}
const figures = {
  create: MockNewNotePanel,
  template: MockTemplatePage,
  sort: MockModeComparison,
  sticky: MockStickyWindow
}
const sections = helpGroups.map((group) => ({
  ...group,
  articles: helpArticles.filter(
    (article) => article.group === group.id && article.id !== 'safety-support'
  )
}))
const quickLinks = resolveHelpQuickLinks()
const query = ref('')
const hasQuery = computed(() => Boolean(query.value.trim()))
const results = computed(() => searchHelp(helpArticles, query.value))
const activeAnchor = ref('safety-support')
const activeModule = computed(
  () => helpArticles.find((article) => article.id === activeAnchor.value)?.group
)
const navCollapsed = ref(true)
const contentRef = ref(null)
const searchInput = ref(null)
const navRef = ref(null)
const navFabRef = ref(null)
const anchorEls = new Map()
const showBackToTop = ref(false)
const HELP_SCROLL_STORAGE_PREFIX = 'abandon-note:help-scroll:'
const scrollStorageKey = computed(() => `${HELP_SCROLL_STORAGE_PREFIX}${props.viewMode}`)
let scrollSaveFrame = null
let restoreFrame = null
let readingTop = 0
const scrollMotion = createHelpScrollMotion()
let navigationRevision = 0
let pendingAnchor = null

function cancelNavigation() {
  navigationRevision += 1
  pendingAnchor = null
  scrollMotion.cancel()
}

function animateScroll(top) {
  const container = contentRef.value
  if (!container) return Promise.resolve(false)
  stopScrollInertia(container)
  return scrollMotion.scroll(container, top)
}

function readSavedScrollTop() {
  try {
    const saved = Number.parseFloat(localStorage.getItem(scrollStorageKey.value) || '')
    return Number.isFinite(saved) && saved > 0 ? saved : 0
  } catch {
    return 0
  }
}
function saveScrollTop() {
  // 搜索结果的滚动位置不能覆盖正文的阅读进度。
  const top = hasQuery.value ? readingTop : (contentRef.value?.scrollTop ?? 0)
  try {
    localStorage.setItem(scrollStorageKey.value, String(Math.round(top)))
  } catch {
    /* 存储不可用时仍可阅读。 */
  }
}
function updateScrollState() {
  showBackToTop.value = (contentRef.value?.scrollTop ?? 0) > 240
  if (hasQuery.value) return
  const container = contentRef.value
  if (!container) return
  const referenceTop = container.getBoundingClientRect().top + 80
  let current = 'safety-support'
  for (const [id, element] of anchorEls) {
    if (element.getBoundingClientRect().top <= referenceTop) current = id
    else break
  }
  activeAnchor.value = current
}
function onContentScroll() {
  if (scrollSaveFrame !== null) return
  scrollSaveFrame = requestAnimationFrame(() => {
    scrollSaveFrame = null
    updateScrollState()
    saveScrollTop()
  })
}
function scrollToTop() {
  cancelNavigation()
  void animateScroll(0)
}
async function restoreScrollTop() {
  const savedTop = readSavedScrollTop()
  await nextTick()
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = null
    const container = contentRef.value
    if (!container) return
    container.scrollTop = Math.min(
      savedTop,
      Math.max(0, container.scrollHeight - container.clientHeight)
    )
    updateScrollState()
  })
}
function registerAnchor(id, element) {
  if (element) anchorEls.set(id, element)
  else anchorEls.delete(id)
}
async function scrollTo(id) {
  cancelNavigation()
  const revision = navigationRevision
  pendingAnchor = id
  query.value = ''
  navCollapsed.value = true
  await nextTick()
  if (revision !== navigationRevision) return
  pendingAnchor = null
  const element = anchorEls.get(id)
  const container = contentRef.value
  if (!element || !container) return
  activeAnchor.value = id
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    16
  const completed = await animateScroll(top)
  if (completed && revision === navigationRevision) {
    element.querySelector('h2')?.focus({ preventScroll: true })
  }
}
watch(
  query,
  (value, previous) => {
    if (value.trim()) {
      cancelNavigation()
      if (!previous.trim()) readingTop = contentRef.value?.scrollTop || 0
    }
  },
  { flush: 'sync' }
)
watch(
  query,
  (value) => {
    // 正文重新显示后再恢复滚动，避免在隐藏内容的零高度上被浏览器截断到顶部。
    if (contentRef.value) {
      stopScrollInertia(contentRef.value)
      if (value.trim()) contentRef.value.scrollTop = 0
      else if (pendingAnchor) contentRef.value.scrollTop = readingTop
      else void animateScroll(readingTop)
    }
    updateScrollState()
  },
  { flush: 'post' }
)
function onSearchEnter(event) {
  if (event.isComposing || event.keyCode === 229) return
  if (results.value[0]) void scrollTo(results.value[0].id)
}
function clearSearch() {
  query.value = ''
  searchInput.value?.focus({ preventScroll: true })
}
function onKeydown(event) {
  if (
    ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'].includes(event.key)
  )
    cancelNavigation()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    event.stopPropagation()
    searchInput.value?.focus()
    searchInput.value?.select()
  } else if (event.key === 'Escape' && (hasQuery.value || !navCollapsed.value)) {
    event.preventDefault()
    event.stopPropagation()
    if (hasQuery.value) clearSearch()
    navCollapsed.value = true
  }
}
function onDocClick(event) {
  if (navRef.value?.contains(event.target) || navFabRef.value?.contains(event.target)) return
  navCollapsed.value = true
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('pointerdown', onDocClick, true)
  void restoreScrollTop()
})
onBeforeUnmount(() => {
  cancelNavigation()
  saveScrollTop()
  if (scrollSaveFrame !== null) cancelAnimationFrame(scrollSaveFrame)
  if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('pointerdown', onDocClick, true)
})
</script>

<template>
  <section class="help-page">
    <header class="help-page-header">
      <button
        ref="navFabRef"
        type="button"
        class="help-nav-fab"
        aria-label="展开功能目录"
        aria-controls="help-navigation"
        :aria-expanded="!navCollapsed"
        @click="navCollapsed = !navCollapsed"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12" /></svg>
      </button>
      <span>帮助中心</span>
      <button
        type="button"
        class="help-page-close"
        title="关闭"
        aria-label="关闭帮助中心"
        @click="emit('close')"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M1 1L13 13M1 13L13 1"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>
    <div class="help-search-bar" role="search" aria-label="搜索全部帮助内容">
      <div class="help-search-field">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          maxlength="200"
          aria-label="搜索全部帮助内容"
          placeholder="搜索功能或问题，如：新建、持续方式"
          @keydown.enter="onSearchEnter"
        />
        <button
          v-if="hasQuery"
          type="button"
          class="help-search-clear"
          aria-label="清除帮助搜索"
          @click="clearSearch"
        >
          清除
        </button>
        <kbd v-else>Ctrl / ⌘ F</kbd>
      </div>
      <span class="help-search-hint">搜索所有视图的功能说明 · 多个关键词用空格分隔</span>
    </div>
    <div class="help-body">
      <nav
        id="help-navigation"
        ref="navRef"
        class="help-nav"
        :class="{ 'is-collapsed': navCollapsed }"
        aria-label="帮助功能导航"
      >
        <div class="help-nav-head">
          <strong>功能目录</strong
          ><button type="button" aria-label="收起功能目录" @click="navCollapsed = true">
            收起
          </button>
        </div>
        <div class="help-nav-list scroll-y">
          <button
            type="button"
            class="help-nav-item"
            :class="{ 'is-active': activeAnchor === 'safety-support' && !hasQuery }"
            @click="scrollTo('safety-support')"
          >
            首页 · 项目与支持
          </button>
          <div v-for="section in sections" :key="section.id" class="help-nav-group">
            <p :class="{ 'is-active': activeModule === section.id }">{{ section.title }}</p>
            <button
              v-for="article in section.articles"
              :key="article.id"
              type="button"
              class="help-nav-item"
              :class="{ 'is-active': activeAnchor === article.id && !hasQuery }"
              :aria-current="activeAnchor === article.id && !hasQuery ? 'location' : undefined"
              @click="scrollTo(article.id)"
            >
              {{ article.title }}
            </button>
          </div>
        </div>
      </nav>
      <div
        ref="contentRef"
        class="help-content scroll-y"
        @scroll.passive="onContentScroll"
        @wheel.passive="cancelNavigation"
        @pointerdown="cancelNavigation"
        @touchstart.passive="cancelNavigation"
      >
        <div v-if="hasQuery" class="help-results">
          <p class="help-result-count" role="status" aria-live="polite">
            找到 {{ results.length }} 项相关功能
          </p>
          <div v-if="!results.length" class="help-empty">
            <h2>没有找到相关说明</h2>
            <p>试试更短的关键词，例如「便签」「窗口」或「日志」。</p>
            <button type="button" @click="clearSearch">清除搜索，查看全部功能</button>
          </div>
          <button
            v-for="result in results"
            :key="result.id"
            type="button"
            class="help-search-result"
            :data-help-result="result.id"
            @click="scrollTo(result.id)"
          >
            <span class="help-result-group">{{
              helpGroups.find((group) => group.id === result.group)?.title
            }}</span>
            <strong
              ><template v-for="(part, index) in highlightHelp(result.title, query)" :key="index"
                ><mark v-if="part.match">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></strong
            >
            <span class="help-result-excerpt"
              ><template v-for="(part, index) in highlightHelp(result.excerpt, query)" :key="index"
                ><mark v-if="part.match">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></span
            >
            <span class="help-result-open">查看完整说明 →</span>
          </button>
        </div>
        <div :hidden="hasQuery" class="help-reading">
          <article
            :ref="(element) => registerAnchor('safety-support', element)"
            data-anchor-id="safety-support"
            class="help-article help-home-support"
          >
            <header>
              <h2 tabindex="-1">便利贴 · 帮助中心</h2>
              <p class="help-summary">
                这是一个常驻桌面的便签工具，希望它能帮你把「要做的事」安静地放在看得见的地方。感谢试用
                —— 有想法或问题都欢迎反馈。
              </p>
            </header>
            <div class="help-home-grid">
              <div class="help-home-card help-donate-card">
                <h3>请作者喝杯咖啡</h3>
                <p class="help-donate-lead">0.01 也是对作者最大的肯定。</p>
                <div class="help-donate-row">
                  <figure>
                    <img :src="wechatAppreciationQr" alt="微信赞赏码" />
                    <figcaption>微信赞赏码</figcaption>
                  </figure>
                  <figure>
                    <img :src="alipayAppreciationQr" alt="支付宝收款码" />
                    <figcaption>支付宝</figcaption>
                  </figure>
                </div>
                <p class="help-home-note">支持是持续更新的动力 ☕</p>
              </div>
              <div class="help-home-card">
                <h3>项目与支持</h3>
                <ul class="help-link-list">
                  <li>
                    <span>GitCode 仓库</span
                    ><a :href="profile.gitcode" target="_blank" rel="noopener noreferrer">{{
                      profile.gitcode
                    }}</a>
                  </li>
                  <li>
                    <span>GitHub 仓库</span
                    ><a :href="profile.github" target="_blank" rel="noopener noreferrer">{{
                      profile.github
                    }}</a>
                  </li>
                  <li>
                    <span>作者博客</span
                    ><a :href="profile.blog" target="_blank" rel="noopener noreferrer">{{
                      profile.blog
                    }}</a>
                  </li>
                  <li>
                    <span>联系邮箱</span><span>{{ profile.email }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </article>
          <div class="help-home">
            <span class="help-eyebrow">ABANDON NOTE · 功能指南</span>
            <h1>从你想做的事开始</h1>
            <p>
              同一功能的各种入口集中说明。无论当前使用列表、月视图还是周视图，都能查看全部帮助。
            </p>
            <div class="help-quick-links">
              <button
                v-for="article in quickLinks"
                :key="article.id"
                type="button"
                @click="scrollTo(article.id)"
              >
                {{ article.title }}<span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
          <section
            v-for="section in sections"
            :key="section.id"
            class="help-section"
            :data-section-id="section.id"
          >
            <div class="help-section-heading">
              <span>{{ section.title }}</span>
              <p>{{ section.description }}</p>
            </div>
            <article
              v-for="article in section.articles"
              :key="article.id"
              :ref="(element) => registerAnchor(article.id, element)"
              :data-anchor-id="article.id"
              class="help-article"
            >
              <header>
                <h2 tabindex="-1">{{ article.title }}</h2>
                <p class="help-summary">{{ article.summary }}</p>
              </header>
              <section v-for="(block, index) in article.blocks" :key="index" class="help-block">
                <h3 v-if="block.title">{{ block.title }}</h3>
                <p v-for="paragraph in block.paragraphs" :key="paragraph">{{ paragraph }}</p>
                <dl v-if="block.rows" class="help-methods">
                  <div v-for="[label, text] in block.rows" :key="label">
                    <dt>{{ label }}</dt>
                    <dd>{{ text }}</dd>
                  </div>
                </dl>
              </section>
              <details v-if="article.figure" class="help-illustration">
                <summary>查看界面示意</summary>
                <HelpMock caption="功能示意，具体样式以当前界面为准"
                  ><component :is="figures[article.figure]"
                /></HelpMock>
              </details>
            </article>
          </section>
        </div>
      </div>
      <Transition name="help-back-to-top"
        ><button
          v-if="showBackToTop"
          type="button"
          class="help-back-to-top"
          aria-label="回到帮助中心顶部"
          @click="scrollToTop"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 11 5-5 5 5M10 6v9" />
          </svg></button
      ></Transition>
    </div>
  </section>
</template>

<style scoped>
.help-page {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-radius: inherit;
  color: var(--text-color);
  container: help / inline-size;
}
.help-page-header {
  display: flex;
  position: relative;
  align-items: center;
  justify-content: center;
  min-height: 47rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ui-border-divider);
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-page-close {
  position: absolute;
  right: 16rem;
  width: 28rem;
  height: 28rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--text-color-secondary);
  background: transparent;
  cursor: pointer;
}
.help-page-close:hover,
.help-nav-fab:hover {
  background: var(--ui-fill-hover);
}
.help-page button {
  font: inherit;
  cursor: pointer;
}
.help-page button:active {
  transform: scale(0.98);
}
.help-page :is(button, summary, input, h2):focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 3px;
}
.help-page :is(h1, h2, h3, p) {
  margin: 0;
}
.help-page svg {
  width: 18rem;
  height: 18rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.help-search-bar {
  padding: 16rem 24rem 12rem;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ui-border-divider);
}
.help-search-field {
  display: flex;
  align-items: center;
  gap: 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 10rem;
  padding: 9rem 12rem;
  background: var(--ui-surface-control);
  color: var(--text-color-secondary);
}
.help-search-field:hover {
  border-color: var(--ui-border-hover);
}
.help-search-field:focus-within {
  border-color: var(--ui-accent);
}
.help-search-field input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-body);
  outline: none !important;
}
.help-search-field input::-webkit-search-cancel-button {
  display: none;
}
.help-search-field input::placeholder {
  color: var(--text-color-secondary);
}
.help-search-field kbd {
  font-size: calc(var(--fs-secondary) * 0.9);
  white-space: nowrap;
}
.help-search-clear {
  padding: 2rem 0 2rem 10rem;
  border: 0;
  border-left: 1px solid var(--ui-border-divider);
  background: transparent;
  color: var(--ui-accent);
  white-space: nowrap;
}
.help-search-hint {
  display: block;
  margin-top: 7rem;
  font-size: calc(var(--fs-secondary) * 0.9);
  color: var(--text-color-secondary);
}
.help-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.help-nav {
  display: flex;
  flex-direction: column;
  width: 204rem;
  flex-shrink: 0;
  padding: 16rem 10rem;
  border-right: 1px solid var(--ui-border-divider);
}
.help-nav-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 8rem 12rem;
  font-size: var(--fs-secondary);
}
.help-nav-head button {
  display: none;
}
.help-nav-list {
  overflow-y: auto;
  min-height: 0;
}
.help-nav-group + .help-nav-group {
  margin-top: 20rem;
}
.help-nav-group p {
  padding: 0 8rem 5rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-nav-group p.is-active {
  color: var(--ui-accent);
}
.help-nav-item {
  display: block;
  width: 100%;
  padding: 8rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  text-align: left;
  font-size: var(--fs-secondary) !important;
}
.help-nav-item:hover {
  color: var(--ui-accent);
}
.help-nav-item.is-active {
  color: var(--ui-accent);
  background: var(--ui-accent-subtle);
}
.help-nav-fab {
  display: none;
  position: absolute;
  left: 12rem;
  border: 0;
  border-radius: 8rem;
  padding: 7rem;
  background: transparent;
  color: var(--text-color);
}
.help-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  padding: 28rem 32rem 72rem;
}
.help-reading,
.help-results {
  max-width: 860rem;
  margin: auto;
  user-select: text;
}
.help-home {
  margin-bottom: 36rem;
}
.help-eyebrow {
  color: var(--ui-accent);
  font-size: calc(var(--fs-secondary) * 0.9);
  letter-spacing: 0.05em;
}
.help-home h1 {
  margin: 10rem 0;
  font-size: calc(var(--fs-body) * 1.9);
  font-weight: 650;
  line-height: 1.3;
}
.help-home p,
.help-summary {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.7;
}
.help-quick-links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8rem;
  margin-top: 18rem;
}
.help-quick-links button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8rem;
  padding: 12rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 9rem;
  background: transparent;
  color: var(--text-color);
  text-align: left;
  font-size: var(--fs-secondary);
}
.help-quick-links button:hover {
  border-color: var(--ui-border-control);
}
.help-quick-links span {
  color: var(--ui-accent);
}
.help-section-heading {
  padding: 12rem 0;
  border-bottom: 1px solid var(--ui-border-divider);
}
.help-section-heading span {
  color: var(--ui-accent);
  font-size: var(--fs-secondary);
  font-weight: 600;
}
.help-section-heading p {
  margin-top: 5rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-article {
  padding: 28rem 0;
  border-bottom: 1px solid var(--ui-border-divider);
  overflow-wrap: anywhere;
}
.help-section {
  margin-bottom: 24rem;
}
.help-article h2 {
  font-size: calc(var(--fs-body) * 1.45);
  line-height: 1.4;
  font-weight: 650;
}
.help-summary {
  margin-top: 8rem !important;
}
.help-block {
  margin-top: 20rem;
  font-size: var(--fs-secondary);
  line-height: 1.8;
}
.help-block h3,
.help-home-card h3 {
  font-size: var(--fs-body);
  font-weight: 600;
  margin-bottom: 10rem;
}
.help-block p + p {
  margin-top: 10rem;
}
.help-methods {
  margin: 0;
}
.help-methods > div {
  display: grid;
  grid-template-columns: 128rem minmax(0, 1fr);
  gap: 16rem;
  padding: 12rem 0;
}
.help-methods > div + div {
  border-top: 1px solid var(--ui-border-divider);
}
.help-methods dt {
  font-weight: 600;
}
.help-methods dd {
  margin: 0;
}
.help-illustration {
  margin-top: 18rem;
  border-radius: 10rem;
  padding: 12rem;
  background: var(--ui-surface-subtle);
}
.help-illustration summary {
  cursor: pointer;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}
.help-illustration[open] summary {
  margin-bottom: 14rem;
}
.help-result-count {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  margin-bottom: 16rem !important;
}
.help-search-result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  gap: 9rem;
  padding: 20rem 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color);
  text-align: left;
  overflow-wrap: anywhere;
}
.help-search-result:hover .help-result-open {
  text-decoration: underline;
}
.help-search-result strong {
  font-size: calc(var(--fs-body) * 1.15);
}
.help-result-group {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-result-excerpt {
  font-size: var(--fs-secondary);
  line-height: 1.75;
}
.help-result-open {
  color: var(--ui-accent);
  font-size: calc(var(--fs-secondary) * 0.9);
}
mark {
  border-radius: 3rem;
  color: var(--text-color);
  background: var(--ui-accent-subtle);
}
.help-empty {
  padding: 32rem 0;
  line-height: 1.8;
}
.help-empty h2 {
  font-size: var(--fs-body);
}
.help-empty p {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.help-empty button {
  margin-top: 18rem;
  padding: 8rem 12rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  color: var(--ui-accent);
  background: var(--ui-surface-control);
}
.help-home-card {
  min-width: 0;
  padding: 16rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 12rem;
  font-size: var(--fs-secondary);
}
.help-home-support {
  padding-top: 0;
  margin-bottom: 28rem;
}
.help-home-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rem;
  margin-top: 20rem;
}
.help-home-note,
.help-donate-lead {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.6;
}
.help-home-note {
  margin-top: 12rem !important;
}
.help-link-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 12rem;
}
.help-link-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 5rem 14rem;
}
.help-link-list li > span:first-child {
  color: var(--text-color-secondary);
}
.help-link-list a {
  color: var(--ui-accent);
}
.help-donate-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rem;
  margin-top: 12rem;
}
.help-donate-row figure {
  margin: 0;
}
.help-donate-row img {
  display: block;
  width: 100%;
  height: 180rem;
  object-fit: contain;
}
.help-donate-row figcaption {
  text-align: center;
  font-size: var(--fs-secondary);
}
.help-back-to-top {
  position: absolute;
  right: 20rem;
  bottom: 18rem;
  display: grid;
  place-items: center;
  width: 36rem;
  height: 36rem;
  padding: 0;
  border: 1px solid var(--surface-float-border);
  border-radius: 50%;
  background: var(--surface-float);
  color: var(--text-color);
  z-index: var(--z-local-top);
}
.help-back-to-top:hover {
  border-color: var(--ui-border-hover);
}
.help-back-to-top-enter-active,
.help-back-to-top-leave-active {
  transition:
    opacity 180ms var(--ease-standard),
    transform 180ms var(--ease-standard);
}
.help-back-to-top-enter-from,
.help-back-to-top-leave-to {
  opacity: 0;
  transform: translateY(6rem);
}
@container help (max-width: 720px) {
  .help-home-grid {
    grid-template-columns: 1fr;
  }
  .help-nav-fab {
    display: grid;
  }
  .help-nav {
    position: absolute;
    inset: 8rem auto 12rem 12rem;
    width: min(240rem, calc(100% - 24rem));
    z-index: var(--z-local-top);
    border: 1px solid var(--surface-float-border);
    border-radius: 12rem;
    background: var(--surface-float);
    box-shadow: 0 12rem 32rem rgb(0 0 0 / 0.16);
    transition:
      opacity 180ms var(--ease-standard),
      transform 220ms var(--ease-standard),
      visibility 220ms;
  }
  .help-nav.is-collapsed {
    visibility: hidden;
    opacity: 0;
    transform: translateX(-12rem);
    pointer-events: none;
  }
  .help-nav-head button {
    display: block;
    border: 0;
    padding: 4rem;
    background: transparent;
    color: var(--ui-accent);
  }
  .help-content {
    padding: 22rem 20rem 64rem;
  }
  .help-search-bar {
    padding: 12rem 20rem;
  }
}
@container help (max-width: 440px) {
  .help-search-field kbd {
    display: none;
  }
  .help-content {
    padding-inline: 16rem;
  }
  .help-search-bar {
    padding-inline: 16rem;
  }
  .help-methods > div {
    grid-template-columns: 1fr;
    gap: 4rem;
  }
  .help-quick-links {
    grid-template-columns: 1fr;
  }
  .help-home h1 {
    font-size: calc(var(--fs-body) * 1.6);
  }
}
</style>
