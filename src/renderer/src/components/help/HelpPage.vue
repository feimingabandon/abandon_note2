<script setup>
/**
 * HelpPage.vue — 帮助中心（从右滑入的整页面板）
 *
 * 布局：悬浮多级目录（模块 → 子标题，scroll-spy 高亮 + 点击平滑滚动） + 右侧滚动讲解区。
 * 信息架构按用户任务组织：快速开始 → 窗口与托盘 → 创建与整理 → 常用工具 → 设置 → 数据与隐私。
 * 讲解范式：稳定结构使用 HTML 仿造图，状态变化使用连续帧图，危险操作使用完整结果链路。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import HelpMock from './HelpMock.vue'
import HelpFigureBlock from './HelpFigureBlock.vue'
import MockNoteCard from './mock/MockNoteCard.vue'
import MockStatusRing from './mock/MockStatusRing.vue'
import MockTemplatePage from './mock/MockTemplatePage.vue'
import MockTemplateCard from './mock/MockTemplateCard.vue'
import MockNewNotePanel from './mock/MockNewNotePanel.vue'
import MockWindowGuide from './mock/MockWindowGuide.vue'
import MockTrayMenu from './mock/MockTrayMenu.vue'
import MockSearchFlow from './mock/MockSearchFlow.vue'
import MockModeComparison from './mock/MockModeComparison.vue'
import MockDockFlow from './mock/MockDockFlow.vue'
import MockStickyWindow from './mock/MockStickyWindow.vue'
import MockCalendarToolbar from './mock/MockCalendarToolbar.vue'
import MockCalendarStrip from './mock/MockCalendarStrip.vue'
import MockCalendarDayPanel from './mock/MockCalendarDayPanel.vue'
import wechatAppreciationQr from '../../resources/help/wechat-appreciation-qr.png'
import alipayAppreciationQr from '../../resources/help/alipay-appreciation-qr.jpg'

const props = defineProps({
  viewMode: {
    type: String,
    default: 'list',
    validator: (value) => ['list', 'month', 'week'].includes(value)
  }
})

const isListView = computed(() => props.viewMode === 'list')
const isWeekView = computed(() => props.viewMode === 'week')
const viewLabel = computed(() => {
  if (isWeekView.value) return '周视图'
  return isListView.value ? '便签列表' : '月视图'
})

/**
 * 多级目录：每个模块对应一个「页面 / 功能域」，items 为该模块内的功能子标题（锚点）。
 * items 为空的模块（首页）自身即为锚点。
 */
const listSections = [
  {
    id: 'notes',
    title: '创建与整理',
    hint: '新建 · 状态 · 排序',
    items: [
      { id: 'notes-create', title: '新建便签' },
      { id: 'notes-status', title: '状态流转' },
      { id: 'notes-search', title: '搜索便签' },
      { id: 'notes-edit', title: '卡片与右键操作' },
      { id: 'notes-list', title: '筛选与排序' }
    ]
  },
  {
    id: 'tools',
    title: '常用工具',
    hint: '便利贴 · 日报 · 模板',
    items: [
      { id: 'tools-sticky', title: '贴到桌面' },
      { id: 'tools-report', title: '日报导出' },
      { id: 'tools-template', title: '循环模板' }
    ]
  }
]

const calendarSections = [
  {
    id: 'calendar',
    title: isWeekView.value ? '周视图' : '月视图',
    hint: isWeekView.value ? '周导航 · 七天 · 侧栏' : '月份 · 日期格 · 侧栏',
    items: [
      { id: 'calendar-navigation', title: '日期导航' },
      { id: 'calendar-grid', title: isWeekView.value ? '一周七天' : '月历日期格' },
      { id: 'calendar-day-panel', title: '日期侧栏' },
      { id: 'calendar-notes', title: '新建与管理便签' },
      { id: 'calendar-weather', title: '天气与节假日' }
    ]
  },
  {
    id: 'calendar-tools',
    title: '常用工具',
    hint: '日报 · 便利贴 · 模板',
    items: [
      { id: 'calendar-report', title: '日报导出' },
      { id: 'calendar-sticky', title: '贴到桌面' },
      { id: 'calendar-template', title: '循环模板' }
    ]
  }
]

const settingsItems = [
  { id: 'settings-scope', title: '设置作用域' },
  { id: 'settings-appearance', title: '外观与字体' },
  ...(isListView.value ? [{ id: 'settings-sticky', title: '便利贴默认样式' }] : []),
  { id: 'settings-blur', title: '毛玻璃与壁纸' },
  { id: 'settings-common', title: '公共服务' },
  { id: 'settings-tools', title: '恢复与诊断' }
]

const sections = [
  { id: 'home', title: '首页', hint: '关于与支持', items: [] },
  {
    id: 'window',
    title: '窗口与托盘',
    hint: '关闭 · 置顶 · 贴边',
    items: [
      { id: 'window-titlebar', title: '导航栏' },
      { id: 'window-tray', title: '托盘菜单' },
      { id: 'window-dock', title: '贴边隐藏' }
    ]
  },
  ...(isListView.value ? listSections : calendarSections),
  {
    id: 'settings',
    title: '设置',
    hint: '作用域 · 外观 · 数据',
    items: settingsItems
  },
  {
    id: 'safety',
    title: '数据与隐私',
    hint: '找回 · 清理 · 排障',
    items: [
      { id: 'safety-delete', title: '删除与找回' },
      { id: 'safety-privacy', title: '远程服务与隐私' },
      { id: 'safety-platform', title: '平台差异' },
      { id: 'safety-troubleshoot', title: '故障排查' },
      { id: 'safety-support', title: '项目与支持' }
    ]
  }
]

/** 扁平化所有锚点并附带所属模块，供 scroll-spy 联动高亮使用。 */
const anchors = sections.flatMap((s) =>
  s.items.length
    ? s.items.map((it) => ({ ...it, moduleId: s.id }))
    : [{ id: s.id, title: s.title, moduleId: s.id }]
)

/** 项目与支持信息。 */
const profile = reactive({
  greeting:
    '这是一个常驻桌面的便签工具，希望它能帮你把「要做的事」安静地放在看得见的地方。感谢试用 —— 有想法或问题都欢迎反馈。',
  gitcode: 'https://gitcode.com/zou-feiming/abandon_note2',
  github: 'https://github.com/feimingabandon/abandon_note2',
  blog: 'https://blog.csdn.net/qq_43483251',
  email: '1160653906@qq.com',
  donate: wechatAppreciationQr,
  donateAlt: alipayAppreciationQr
})

// 悬浮目录的折叠状态：true = 已收起（仅保留唤出按钮），不占用文档流。打开帮助中心时默认收起。
const navCollapsed = ref(true)
const navRef = ref(null)
const navFabRef = ref(null)

/** 点击目录以外的区域时自动收起（唤出按钮除外）。 */
function onDocClick(e) {
  if (navCollapsed.value) return
  if (navRef.value?.contains(e.target)) return
  if (navFabRef.value?.contains(e.target)) return
  navCollapsed.value = true
}

// ---- scroll-spy：右侧滚动时高亮左侧对应锚点，并联动高亮其所属模块 ----
const activeAnchor = ref('home')
const activeModule = computed(() => {
  const hit = anchors.find((a) => a.id === activeAnchor.value)
  return hit ? hit.moduleId : 'home'
})
const contentRef = ref(null)
const anchorEls = new Map()
let observer = null

function registerAnchor(id, el) {
  if (el) anchorEls.set(id, el)
  else anchorEls.delete(id)
}

/** 目标锚点相对滚动容器的偏移（不依赖 offsetParent，嵌套多深都准确）。 */
function scrollTo(anchorId) {
  const el = anchorEls.get(anchorId)
  const container = contentRef.value
  if (!el || !container) return
  activeAnchor.value = anchorId
  const top =
    el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8
  container.scrollTo({ top, behavior: 'smooth' })
}

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      // 取当前与顶部参考线相交、且最靠上的锚点作为高亮项。
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible.length) activeAnchor.value = visible[0].target.dataset.anchorId
    },
    { root: contentRef.value, rootMargin: '0px 0px -62% 0px', threshold: 0 }
  )
  anchorEls.forEach((el) => observer.observe(el))
  document.addEventListener('click', onDocClick, true)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  document.removeEventListener('click', onDocClick, true)
})
</script>

<template>
  <section class="help-page">
    <header class="help-page-header"><span>帮助中心</span></header>

    <div class="help-body">
      <!-- 悬浮多级目录：绝对定位，不占用文档流，可折叠收起 -->
      <nav
        ref="navRef"
        class="help-nav"
        :class="{ 'is-collapsed': navCollapsed }"
        :inert="navCollapsed"
        :aria-hidden="navCollapsed"
        aria-label="帮助模块导航"
      >
        <div class="help-nav-head">
          <span class="help-nav-caption">目录</span>
          <button
            class="help-nav-collapse"
            title="收起目录"
            aria-label="收起目录"
            @click="navCollapsed = true"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 5 7.5 10l5 5" />
            </svg>
          </button>
        </div>
        <div class="help-nav-list">
          <div
            v-for="section in sections"
            :key="section.id"
            class="help-nav-group"
            :class="{ 'is-active': activeModule === section.id }"
          >
            <button
              class="help-nav-item"
              :class="{ 'is-active': activeModule === section.id }"
              @click="scrollTo(section.items.length ? section.items[0].id : section.id)"
            >
              <span class="help-nav-title">{{ section.title }}</span>
              <span class="help-nav-hint">{{ section.hint }}</span>
            </button>
            <div v-if="section.items.length" class="help-nav-sub">
              <button
                v-for="item in section.items"
                :key="item.id"
                class="help-nav-subitem"
                :class="{ 'is-active': activeAnchor === item.id }"
                @click="scrollTo(item.id)"
              >
                {{ item.title }}
              </button>
            </div>
          </div>
        </div>
      </nav>

      <!-- 收起后的悬浮唤出按钮 -->
      <button
        ref="navFabRef"
        class="help-nav-fab"
        :class="{ 'is-visible': navCollapsed }"
        :inert="!navCollapsed"
        title="展开目录"
        aria-label="展开目录"
        @click="navCollapsed = false"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 6h12M4 10h12M4 14h12" />
        </svg>
      </button>

      <!-- 右侧滚动讲解区 -->
      <div ref="contentRef" class="help-content scroll-y">
        <!-- 首页：作者信息、支持入口与快速开始 -->
        <section
          :ref="(el) => registerAnchor('home', el)"
          data-anchor-id="home"
          class="help-section help-home"
        >
          <div class="help-home-hero">
            <h1 class="help-home-title">便利贴 · 帮助中心</h1>
            <p class="help-home-greeting">{{ profile.greeting }}</p>
          </div>

          <div class="help-home-grid">
            <div class="help-home-card">
              <h3>请作者喝杯咖啡</h3>
              <p class="help-donate-lead">0.01 也是对作者最大的肯定。</p>
              <div class="help-donate-row">
                <figure class="help-donate-item">
                  <div class="help-donate-slot">
                    <img :src="profile.donate" alt="小邹的微信赞赏码" />
                  </div>
                  <figcaption>微信赞赏码</figcaption>
                </figure>
                <figure class="help-donate-item">
                  <div class="help-donate-slot">
                    <img :src="profile.donateAlt" alt="小邹的支付宝收款码" />
                  </div>
                  <figcaption>支付宝</figcaption>
                </figure>
              </div>
              <p class="help-home-note">支持是持续更新的动力 ☕</p>
            </div>

            <div class="help-home-card">
              <h3>项目与支持</h3>
              <ul class="help-link-list">
                <li>
                  <span class="help-link-label">GitCode 仓库</span>
                  <a
                    class="help-link-value"
                    :href="profile.gitcode"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ profile.gitcode }}
                  </a>
                </li>
                <li>
                  <span class="help-link-label">GitHub 仓库</span>
                  <a
                    class="help-link-value"
                    :href="profile.github"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ profile.github }}
                  </a>
                </li>
                <li>
                  <span class="help-link-label">作者博客</span>
                  <a
                    class="help-link-value"
                    :href="profile.blog"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ profile.blog }}
                  </a>
                </li>
                <li>
                  <span class="help-link-label">联系邮箱</span>
                  <span class="help-link-value">{{ profile.email }}</span>
                </li>
              </ul>
              <p class="help-home-note">问题反馈、版本信息和后续内容会在这里持续补充。</p>
            </div>
          </div>

          <h2 class="help-home-subtitle">快速开始</h2>
          <p v-if="isListView" class="help-home-greeting">
            先创建一条便签，再用状态、标签和排序整理它；需要单独展示时，把它贴到桌面。关闭主窗口只会隐藏到托盘，只有从托盘选择“退出应用”才会真正结束程序。
          </p>
          <p v-else class="help-home-greeting">
            {{
              viewLabel
            }}用于按日期查看便签。先定位日期，点击日期格打开当天侧栏；可从日期格或侧栏新建便签，也能在侧栏直接修改、完成、删除或贴到桌面。
          </p>
          <div class="help-quick-steps" aria-label="快速开始步骤">
            <template v-if="isListView">
              <div><strong>点击＋</strong><small>输入正文并创建</small></div>
              <div><strong>推进状态</strong><small>点击左侧状态圆环</small></div>
              <div><strong>整理便签</strong><small>筛选、排序或分组</small></div>
              <div><strong>贴到桌面</strong><small>生成只读便利贴</small></div>
            </template>
            <template v-else>
              <div>
                <strong>定位日期</strong
                ><small>{{ isWeekView ? '选择周次或日期' : '选择年份和月份' }}</small>
              </div>
              <div><strong>点击日期</strong><small>展开当天侧栏</small></div>
              <div><strong>新建便签</strong><small>自动使用所选日期</small></div>
              <div><strong>管理便签</strong><small>修改、完成或贴桌面</small></div>
            </template>
          </div>

          <div class="help-term-grid">
            <div class="help-term-card">
              <strong>便签</strong>
              <span>保存在便签列表中的正文、时间、状态、标签和图片。</span>
            </div>
            <div class="help-term-card">
              <strong>便利贴</strong>
              <span>由某条便签生成的桌面临时展示窗口，关闭它不会删除来源便签。</span>
            </div>
            <div class="help-term-card">
              <strong>当前视图</strong>
              <span>当前是{{ viewLabel }}。便签列表、月视图和周视图各自保存窗口配置。</span>
            </div>
          </div>
        </section>

        <!-- 模块一：窗口与托盘 -->
        <section data-section-id="window" class="help-section">
          <div class="help-section-head">
            <h2>窗口与托盘</h2>
            <p class="help-summary">
              导航栏管理<strong>当前主窗口</strong>，托盘负责恢复窗口、切换视图和管理桌面便利贴。便签列表、月视图和周视图使用各自独立的窗口外观、位置、尺寸与贴边设置。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('window-titlebar', el)"
            data-anchor-id="window-titlebar"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">导航栏</h3>
            <p class="help-anchor-desc">
              Apple 与 Windows 风格只改变按钮排布和外观，不改变功能。下面是{{
                viewLabel
              }}中完整的按钮组成。
            </p>
            <HelpMock caption="导航栏结构示意；窗口置顶与便签置顶是两个不同功能">
              <MockWindowGuide :view-mode="viewMode" />
            </HelpMock>
            <ul class="help-points">
              <li><strong>关闭：</strong>隐藏当前窗口，可从托盘恢复；不会退出程序。</li>
              <li><strong>窗口置顶：</strong>默认开启；关闭后窗口回到普通系统层级。</li>
              <li><strong>锁定：</strong>禁止移动和缩放，并停用贴边自动隐藏。</li>
              <li>
                <strong>业务按钮：</strong
                >日报、循环模板、设置和帮助；三个视图使用同一套循环模板数据。
              </li>
            </ul>
          </div>

          <div
            :ref="(el) => registerAnchor('window-tray', el)"
            data-anchor-id="window-tray"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">托盘菜单</h3>
            <div class="help-wide-figure"><MockTrayMenu /></div>
            <ul class="help-points">
              <li><strong>打开主窗口：</strong>显示当前选择的主视图。</li>
              <li>
                <strong>当前视图：</strong
                >在便签列表、月视图、周视图之间切换；切换时加载目标视图自己的设置。
              </li>
              <li><strong>显示全部便利贴：</strong>一次显示所有已创建的桌面便利贴。</li>
              <li><strong>便利贴总览：</strong>选择某张便利贴后可显示并聚焦，也可只关闭这一张。</li>
              <li class="help-point-danger">
                <strong>关闭全部便利贴：</strong>只结束桌面临时展示，不删除便签列表中的来源内容。
              </li>
              <li><strong>退出应用：</strong>真正结束程序与后台调度。</li>
            </ul>
          </div>

          <div
            :ref="(el) => registerAnchor('window-dock', el)"
            data-anchor-id="window-dock"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">贴边隐藏</h3>
            <div class="help-wide-figure"><MockDockFlow /></div>
            <p class="help-anchor-desc">
              设置支持为列表、月和周视图分别多选上、左、右边缘。把窗口拖到当前视图已启用且真实可触达的屏幕边缘，鼠标离开后窗口会自动收起；未选择任何边缘时关闭该视图的贴边隐藏。开启“贴边隐藏小黑条”后，触边只显示确认条，只有点击小黑条后才展开完整窗口；关闭该选项时则会触边直接展开。锁定窗口时不会自动隐藏。
            </p>
          </div>
        </section>

        <!-- 模块二：创建与整理 -->
        <section v-if="isListView" data-section-id="notes" class="help-section">
          <div class="help-section-head">
            <h2>便签列表</h2>
            <p class="help-summary">
              便签列表负责<strong>创建、状态流转、筛选、排序、修改与删除</strong>。上方标签和状态条件对三种排序模式共同生效，切换模式不会清空当前筛选。
            </p>
          </div>

          <div class="help-figures">
            <div :ref="(el) => registerAnchor('notes-create', el)" data-anchor-id="notes-create">
              <HelpFigureBlock title="新建便签">
                <template #figure><MockNewNotePanel /></template>
                <p>点击顶部操作栏的「＋」按钮展开面板。下面是各字段说明：</p>
                <ol class="help-anno-list">
                  <li>
                    <strong>正文输入框</strong> —— 唯一必填项，支持多行（Enter
                    换行），无字数上限。正文为空时创建按钮不可点。
                  </li>
                  <li>
                    <strong>生效时间</strong> ——
                    默认「立即生效」，创建后直接进入「进行中」。也可选择未来时间，到点前保持「初始化」，到点后由后台调度器自动切为「进行中」。
                  </li>
                  <li>
                    <strong>持续天数</strong> —— 选择生效时间后显示，默认 1
                    天。只决定便签在日历视图中连续占用的日期格数，不会自动完成便签，也不改变列表状态。
                  </li>
                  <li>
                    <strong>系统提醒</strong> ——
                    生效时间到达时弹出操作系统通知。仅在选择了未来生效时间后可开启；「立即生效」时此项不可用。<br />
                    <em class="help-anno-warn"
                      >⚠️ macOS 平台暂时无法开启系统通知（受限于 Electron 平台约束）。</em
                    >
                  </li>
                  <li>
                    <strong>置顶</strong> ——
                    开启后便签进入列表的置顶区域。它只影响便签排序，不等于把整个应用窗口置顶。
                  </li>
                  <li>
                    <strong>标签</strong> ——
                    每条便签最多添加一个分类标签，用于分类管理和搜索筛选。外层优先显示当前选中的标签，其余标签遵循标签分组中的手动顺序；「更多」后的数字是标签总数。打开更多面板可搜索和选择标签，进入「管理标签」后可新建、修改和删除。标签全局共享，所有便签和模板复用同一套。
                  </li>
                  <li><strong>图片附件</strong> —— 支持截图、点击选择、拖入或粘贴图片。</li>
                  <li>
                    <strong>创建便签</strong> —— 正文非空后可点击。创建成功后显示绿色
                    ✔，面板自动收起并重置字段。
                  </li>
                </ol>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-status', el)" data-anchor-id="notes-status">
              <HelpFigureBlock title="状态流转">
                <template #figure>
                  <div class="help-fig-rings">
                    <span><MockStatusRing status="initialized" /><em>初始化</em></span>
                    <span><MockStatusRing status="in_progress" /><em>进行中</em></span>
                    <span><MockStatusRing status="completed" /><em>已完成</em></span>
                  </div>
                </template>
                <p>
                  卡片左侧圆环既显示状态又是主操作按钮：<strong>初始化</strong>表示尚未到生效时间，<strong>进行中</strong>表示已经生效，<strong>已完成</strong>表示用户已完成。到点后初始化会自动变为进行中；点击圆环可以手动提前执行、标记完成或重新进行。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-search', el)" data-anchor-id="notes-search">
              <h3 class="help-anchor-title">搜索便签</h3>
              <div class="help-wide-figure"><MockSearchFlow /></div>
              <p class="help-anchor-desc">
                第一次点击放大镜进入搜索模式，第二次点击展开完整搜索面板。正文关键词与高级筛选可以叠加；高级筛选支持状态、标签、时间范围、仅看置顶、仅看含附件和“包含已删除”。搜索结果分批加载，每批
                5
                条。已删除便签可在这里<strong>恢复</strong>，也可经过危险确认后<strong>彻底删除</strong>。
              </p>
            </div>

            <div :ref="(el) => registerAnchor('notes-edit', el)" data-anchor-id="notes-edit">
              <HelpFigureBlock title="便签卡片与右键操作">
                <template #figure>
                  <div class="help-card-and-menu">
                    <MockNoteCard
                      status="in_progress"
                      content="下午 3 点和设计团队确认交互稿。"
                      time-text="今天 15:00"
                      :tags="[{ name: '工作' }]"
                      :attachments="2"
                      disclosure
                    />
                    <div class="help-fig-menu">
                      <span>置顶</span>
                      <span>修改</span>
                      <span>贴到桌面</span>
                      <span>新建标签分组</span>
                      <span class="is-danger">删除</span>
                    </div>
                  </div>
                </template>
                <p>
                  正文超过显示高度时可展开或收起；信息行提供标签、复制正文和图片附件。右键菜单可执行<strong>置顶、修改、删除、贴到桌面</strong>；只有标签分组模式还会显示<strong>新建标签分组</strong>，在分组空白处右键也能创建。普通删除是逻辑删除，可在搜索中找回。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-list', el)" data-anchor-id="notes-list">
              <HelpFigureBlock title="筛选与三种排序">
                <template #figure><MockModeComparison /></template>
                <p>
                  上方<strong>标签</strong>和<strong>状态</strong>均可多选；未选择条件表示查询全部。太极按钮用于收起筛选面板并刷新列表。<strong>时间线</strong>依次显示置顶、未来、今天、昨天、前天和更早；更早首次加载
                  10 条，继续滚动每次加载 20
                  条。<strong>自定义</strong>把置顶与日常分开拖动排序，日常首次 10 条、滚动后每批 20
                  条。<strong>标签分组</strong>默认折叠，每组首次 10 条，点击“显示更多”再加载 20
                  条；点击“便签”标题旁的排序按钮会先收起全部分组，再进入整行拖动模式，完成后点击勾号保存；“未分类”固定在最后。
                </p>
              </HelpFigureBlock>
            </div>
          </div>
        </section>

        <!-- 模块三：常用工具 -->
        <section v-if="isListView" data-section-id="tools" class="help-section">
          <div class="help-section-head">
            <h2>常用工具</h2>
            <p class="help-summary">
              把单条便签<strong>临时贴到桌面</strong>、把指定日期内容<strong>导出为日报</strong>，或用<strong>循环模板</strong>按周期自动生成新便签。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('tools-sticky', el)"
            data-anchor-id="tools-sticky"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">贴到桌面</h3>
            <div class="help-wide-figure help-sticky-preview"><MockStickyWindow /></div>
            <ul class="help-points">
              <li>桌面便利贴是<strong>只读临时展示</strong>，不在其中编辑或删除来源便签。</li>
              <li>便利贴可临时调整背景、字号和窗口置顶，这些展示设置不会写回来源便签。</li>
              <li>关闭一张或全部便利贴，只结束桌面展示；来源便签仍保留在列表中。</li>
              <li>可从托盘的“便利贴总览”重新显示并聚焦指定便利贴。</li>
            </ul>
          </div>

          <div
            :ref="(el) => registerAnchor('tools-report', el)"
            data-anchor-id="tools-report"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">日报导出</h3>
            <div class="help-process-row">
              <span>选择日期</span><i>→</i><span>筛选并勾选便签</span><i>→</i><span>保存 TXT</span>
            </div>
            <p class="help-anchor-desc">
              点击导航栏日报按钮，先选择日期和状态范围，再勾选要导出的便签。确认后通过系统保存对话框生成
              TXT 文件；导出成功后可以直接打开文件所在位置。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('tools-template', el)"
            data-anchor-id="tools-template"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">循环模板</h3>
            <p class="help-anchor-desc">
              循环模板按钮位于便签列表、月视图和周视图导航栏。模板不会反复修改同一条便签，而是在每个命中的时间点<strong>生成一条新的便签</strong>。
            </p>
            <HelpMock caption="循环模板页示意；新建、规则预览和模板卡片集中在同一工作区">
              <MockTemplatePage />
            </HelpMock>
            <div class="help-figures">
              <HelpFigureBlock title="创建与频率">
                <template #figure>
                  <div class="help-fig-seg help-fig-seg--wrap">
                    <span>每天</span><span class="is-active">每周</span><span>每月</span
                    ><span>每年</span>
                  </div>
                </template>
                <p>
                  填写正文，选择每天、每周、每月或每年的生成规则，并预设生成时刻、系统提醒、便签置顶和标签。下次生成时间会实时预览，保存前先确认是否符合预期。
                </p>
              </HelpFigureBlock>
              <HelpFigureBlock title="暂停、恢复与删除">
                <template #figure>
                  <MockTemplateCard
                    state="running"
                    state-label="运行中"
                    rule="每周 一 09:00"
                    content="整理本周工作计划。"
                    context-text="下次 周一 09:00"
                    :tags="[{ name: '工作' }]"
                    notify
                  />
                </template>
                <p>
                  右键模板可以暂停、恢复或删除。暂停期间不再生成，恢复后从下一周期继续；普通删除可恢复，彻底删除永久移除。应用未运行时错过的旧周期不会在下次启动时批量补齐；连续生成失败
                  3 次会自动暂停。
                </p>
              </HelpFigureBlock>
            </div>
          </div>
        </section>

        <!-- 月视图 / 周视图：共用日历能力，按视图粒度显示差异 -->
        <template v-if="!isListView">
          <section data-section-id="calendar" class="help-section">
            <div class="help-section-head">
              <h2>{{ viewLabel }}</h2>
              <p class="help-summary">
                {{
                  isWeekView ? '周视图一次聚焦周一至周日七天' : '月视图固定展示七列六行'
                }}，便签按生效日期和持续天数形成日期横条。点击日期格可打开当天侧栏，再进行新建、修改、状态切换或删除。
              </p>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-navigation', el)"
              data-anchor-id="calendar-navigation"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">日期导航</h3>
              <div class="help-wide-figure"><MockCalendarToolbar :view-mode="viewMode" /></div>
              <ul class="help-points">
                <li>
                  左右箭头切换<strong>{{
                    isWeekView ? '上一周 / 下一周' : '上个月 / 下个月'
                  }}</strong
                  >；“今天”返回当前日期，刷新只更新内容，不改变当前范围。
                </li>
                <li v-if="isWeekView">
                  点击中间日期范围打开日期选择器；选中任意一天后，视图跳转到该日期所在的完整周。
                </li>
                <li v-else>点击中间年月打开年份与月份面板；选中后月历按时间方向切换。</li>
                <li>左侧天气位置与数据来源仅在天气已启用并成功获取数据时显示。</li>
              </ul>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-grid', el)"
              data-anchor-id="calendar-grid"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">{{ isWeekView ? '一周七天' : '月历日期格' }}</h3>
              <div class="help-wide-figure"><MockCalendarStrip :view-mode="viewMode" /></div>
              <div class="help-setting-table">
                <div>
                  <strong>顶部信息</strong
                  ><span>公历日期、农历或节日，以及“今 / 休 / 班”状态徽标。</span>
                </div>
                <div>
                  <strong>便签横条</strong
                  ><span
                    >按生效时间与持续天数跨日期显示；同一天内容过多时保留可见横条并显示三个圆点。</span
                  >
                </div>
                <div>
                  <strong>底部信息</strong
                  ><span
                    >左侧＋新建当天便签，中间圆点表示仍有未展示内容，右侧数字是当天便签总数。</span
                  >
                </div>
                <div>
                  <strong>点击日期</strong
                  ><span
                    >第一次展开当天侧栏；再次点击同一日期收起；点击其他日期则保持侧栏展开并切换内容。</span
                  >
                </div>
              </div>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-day-panel', el)"
              data-anchor-id="calendar-day-panel"
              class="help-anchor"
            >
              <HelpFigureBlock title="日期侧栏">
                <template #figure><MockCalendarDayPanel /></template>
                <p>
                  日期侧栏展示所选日期、农历、天气和当天便签。侧栏复用便签列表的完整卡片，因此可以点击状态圆环、复制正文、查看附件、修改、置顶、贴到桌面或逻辑删除。
                </p>
                <p>
                  点击左上角箭头收起侧栏；拖动侧栏与日历之间的边界可调整宽度，月视图和周视图分别保存自己的侧栏尺寸。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-notes', el)"
              data-anchor-id="calendar-notes"
              class="help-anchor"
            >
              <HelpFigureBlock title="新建与管理便签">
                <template #figure><MockNewNotePanel /></template>
                <p>
                  点击日期格左下角＋，或日期侧栏右上角＋，打开与便签列表一致的新建表单。选择今天且不调整时间时立即生效；选择未来日期时默认使用当天
                  00:01，仍可手动修改。
                </p>
                <p>
                  过去日期不能新建便签。创建或修改成功后，日期横条、当天数量和侧栏卡片会自动同步，不需要手动刷新。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-weather', el)"
              data-anchor-id="calendar-weather"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">天气与节假日</h3>
              <div class="help-effect-grid">
                <div>
                  <strong>天气</strong
                  ><span
                    >宽日期格显示图标和温度；空间不足时逐步缩减，完整数据仍保留在日期侧栏。</span
                  >
                </div>
                <div>
                  <strong>农历与节日</strong
                  ><span>节日优先于节气，节气优先于普通农历日期；同日内容过长时会省略显示。</span>
                </div>
                <div>
                  <strong>休 / 班</strong
                  ><span
                    >绿色“休”表示法定休息日，橙色“班”表示调班工作日；年度数据缺失时自动隐藏。</span
                  >
                </div>
              </div>
            </div>
          </section>

          <section data-section-id="calendar-tools" class="help-section">
            <div class="help-section-head">
              <h2>常用工具</h2>
              <p class="help-summary">
                从导航栏导出日报、管理循环模板，或从日期侧栏的便签卡片生成只读桌面便利贴。
              </p>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-report', el)"
              data-anchor-id="calendar-report"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">日报导出</h3>
              <div class="help-process-row">
                <span>选择日期</span><i>→</i><span>筛选并勾选便签</span><i>→</i
                ><span>保存 TXT</span>
              </div>
              <p class="help-anchor-desc">
                日报按钮位于导航栏。导出使用你在弹窗中选择的日期和便签，不会因为当前日历正显示某个月或某一周而限制范围。
              </p>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-sticky', el)"
              data-anchor-id="calendar-sticky"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">贴到桌面</h3>
              <div class="help-wide-figure help-sticky-preview"><MockStickyWindow /></div>
              <p class="help-anchor-desc">
                在日期侧栏的便签卡片上打开右键菜单并选择“贴到桌面”。便利贴只读展示来源正文，可临时调整字号、背景和置顶；关闭便利贴不会删除日历中的来源便签。
              </p>
            </div>

            <div
              :ref="(el) => registerAnchor('calendar-template', el)"
              data-anchor-id="calendar-template"
              class="help-anchor"
            >
              <h3 class="help-anchor-title">循环模板</h3>
              <p class="help-anchor-desc">
                点击导航栏循环模板按钮可打开与便签列表相同的工作区，在任意视图中创建、编辑、暂停、恢复或删除循环模板；三个视图读取同一份模板数据。
              </p>
              <HelpMock caption="循环模板工作区；新建规则和模板管理在三个视图中保持一致">
                <MockTemplatePage />
              </HelpMock>
            </div>
          </section>
        </template>

        <!-- 模块四：设置 -->
        <section data-section-id="settings" class="help-section">
          <div class="help-section-head">
            <h2>设置</h2>
            <p class="help-summary">
              设置面板同时包含<strong>当前视图独立设置</strong>和<strong>整个应用公共设置</strong>。外观数值通常即时预览并自动保存，危险操作会再次确认。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-scope', el)"
            data-anchor-id="settings-scope"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">先看设置作用域</h3>
            <div class="help-scope-grid">
              <div>
                <span class="help-scope-chip">仅当前{{ viewLabel }}</span>
                <p>
                  导航栏风格、背景与文字、字体、毛玻璃、壁纸、窗口圆角、贴边边缘、窗口位置和尺寸。
                </p>
              </div>
              <div>
                <span class="help-scope-chip help-scope-chip--shared">所有视图</span>
                <p>开机自启、天气位置、节假日数据、远程通知与设备信息开关。</p>
              </div>
              <div v-if="isListView">
                <span class="help-scope-chip help-scope-chip--list">仅便签列表</span>
                <p>便利贴初始字号、背景颜色、圆角和默认置顶。</p>
              </div>
              <div v-if="!isListView">
                <span class="help-scope-chip help-scope-chip--calendar">当前日历视图</span>
                <p>日期侧栏宽度由{{ viewLabel }}独立保存，不会改变另一个日历视图。</p>
              </div>
              <div>
                <span class="help-scope-chip help-scope-chip--calendar">月/周视图</span>
                <p>天气展示、日历与节假日内容；其数据源属于应用公共资源。</p>
              </div>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-appearance', el)"
            data-anchor-id="settings-appearance"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">外观与字体</h3>
            <div class="help-setting-table">
              <div>
                <strong>导航栏风格</strong><span>切换 Apple / Windows 排布，不改变按钮功能。</span>
              </div>
              <div>
                <strong>背景颜色</strong
                ><span>当前视图的基础背景色，也是毛玻璃着色和透明回退的基色。</span>
              </div>
              <div>
                <strong>字体大小</strong
                ><span>当前视图的全局基础字号；正文、标题和辅助文字按统一比例联动。</span>
              </div>
              <div>
                <strong>文字颜色</strong
                ><span>当前视图的主文字颜色，次要文字与中性边线由它自动派生。</span>
              </div>
            </div>
          </div>

          <div
            v-if="isListView"
            :ref="(el) => registerAnchor('settings-sticky', el)"
            data-anchor-id="settings-sticky"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">便利贴默认样式</h3>
            <p class="help-anchor-desc">
              默认字号、背景颜色、圆角和默认置顶只决定<strong>以后新建便利贴</strong>的初始外观，不会批量修改已经显示的便利贴，也不会改变来源便签正文。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-blur', el)"
            data-anchor-id="settings-blur"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">毛玻璃与壁纸</h3>
            <div class="help-effect-grid">
              <div>
                <strong>玻璃浓度</strong><span>背景色覆盖强度；0 更通透，1 更接近不透明纯色。</span>
              </div>
              <div><strong>模糊半径</strong><span>背景被打散的程度，不等于透明度。</span></div>
              <div><strong>饱和度</strong><span>模糊背景的色彩鲜艳程度。</span></div>
              <div><strong>窗口圆角</strong><span>0 为直角，数值越大越圆润。</span></div>
            </div>
            <ul class="help-points">
              <li>
                Windows 支持原生模糊半径与饱和度调节；macOS 使用系统 Vibrancy，主要支持开启或关闭。
              </li>
              <li>
                启动时会检查原生毛玻璃是否可用；不可用时自动回退到背景颜色、玻璃浓度和圆角，不阻断应用使用。
              </li>
              <li>
                关闭毛玻璃后可以启用壁纸。壁纸支持截图、导入、历史壁纸、裁切和额外模糊；启用壁纸会关闭原生毛玻璃。
              </li>
            </ul>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-common', el)"
            data-anchor-id="settings-common"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">公共服务</h3>
            <div class="help-setting-table">
              <div>
                <strong>开机自启</strong><span>直接读写操作系统登录项，不保存在便签数据库中。</span>
              </div>
              <div>
                <strong>天气</strong
                ><span
                  >只在月视图和周视图展示，可手动选择城市或请求系统定位；越远期的预报不确定性越高。</span
                >
              </div>
              <div>
                <strong>日历与节假日</strong
                ><span
                  >缺少当前年度数据时不显示“休 / 班”，但不影响日历、农历和便签；可下载或导入
                  JSON。</span
                >
              </div>
              <div>
                <strong>远程服务</strong
                ><span>分别控制软件通知和后续设备统计；修改后的选择从下次启动按新设置执行。</span>
              </div>
              <div>
                <strong>通知历史</strong
                ><span>查看已经保存的软件通知，即使关闭后续接收也不会删除历史记录。</span>
              </div>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-tools', el)"
            data-anchor-id="settings-tools"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">恢复与诊断</h3>
            <div class="help-action-grid">
              <div><strong>检查更新</strong><span>手动查询新版本。</span></div>
              <div><strong>查看日志</strong><span>排查窗口、数据库和后台任务问题。</span></div>
              <div>
                <strong>恢复默认设置</strong
                ><span>只恢复当前视图独立设置；不修改其他视图、公共开关或便签数据。</span>
              </div>
              <div class="is-danger">
                <strong>清空便签数据</strong
                ><span>永久清除便签、模板、标签和附件；设置不受影响且无法恢复。</span>
              </div>
              <div>
                <strong>调度器诊断</strong
                ><span>检查便签生效、系统提醒和循环模板等定时任务是否正常运行。</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 模块五：数据与隐私 -->
        <section data-section-id="safety" class="help-section help-section--last">
          <div class="help-section-head">
            <h2>数据与隐私</h2>
            <p class="help-summary">
              先确认操作影响的是<strong>主窗口、桌面便利贴还是来源便签</strong>。普通删除尽量可恢复，只有明确标记为永久操作的入口才会物理清理数据。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('safety-delete', el)"
            data-anchor-id="safety-delete"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">删除与找回</h3>
            <div class="help-delete-flow">
              <div>
                <span>{{ isListView ? '首页右键删除' : '日期侧栏右键删除' }}</span
                ><strong>逻辑删除</strong><small>正文与图片仍保留</small>
              </div>
              <i>→</i>
              <div>
                <span>{{ isListView ? '搜索“包含已删除”' : '切换便签列表并搜索已删除' }}</span
                ><strong>查看已删除便签</strong><small>仍可阅读内容</small>
              </div>
              <i>→</i>
              <div>
                <span>选择后续操作</span><strong>恢复 / 彻底删除</strong
                ><small>彻底删除不可恢复</small>
              </div>
            </div>
            <div class="help-warning-card">
              <strong>不要混淆三个操作</strong>
              <span
                >关闭主窗口只隐藏到托盘；关闭便利贴只结束临时桌面展示；删除便签才会改变来源数据。</span
              >
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('safety-privacy', el)"
            data-anchor-id="safety-privacy"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">远程服务与隐私</h3>
            <div class="help-privacy-grid">
              <div class="is-local">
                <strong>始终保存在本地</strong
                ><span>便签正文、标签、循环模板内容、图片附件、壁纸。</span>
              </div>
              <div>
                <strong>软件通知请求</strong
                ><span>系统类型、应用版本和通知游标，用于获取适用的软件通知。</span>
              </div>
              <div>
                <strong>可选设备信息</strong
                ><span
                  >安装标识、应用版本、系统版本与架构、CPU、GPU、内存、语言和启动/退出时间。</span
                >
              </div>
            </div>
            <p class="help-anchor-desc">
              首次启动会发送一次匿名基础设备统计，用于估算实际启动的安装数量。“接收软件通知”和“后续设备统计”可以分别关闭，修改后从下次启动起停止对应的后续请求，但不会撤回首次已经发送的统计。程序不会通过这些远程服务上传便签正文、标签、模板内容、附件或壁纸。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('safety-platform', el)"
            data-anchor-id="safety-platform"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">平台差异</h3>
            <div class="help-platform-grid">
              <div>
                <strong>Windows 10 / 11</strong
                ><span>支持系统通知及点击通知定位便签；受支持版本可调原生毛玻璃半径与饱和度。</span>
              </div>
              <div>
                <strong>macOS</strong
                ><span>使用系统 Vibrancy；当前版本未开放系统通知，因此相关通知开关会被禁用。</span>
              </div>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('safety-troubleshoot', el)"
            data-anchor-id="safety-troubleshoot"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">故障排查</h3>
            <div class="help-setting-table">
              <div>
                <strong>提醒或状态未按时变化</strong
                ><span>打开“调度器诊断”查看最近执行时间；异常时先完全退出并重新启动应用。</span>
              </div>
              <div>
                <strong>毛玻璃不可用</strong
                ><span>查看运行诊断；应用会自动回退，仍可继续使用背景颜色、透明度和壁纸。</span>
              </div>
              <div>
                <strong>新年度没有休/班</strong
                ><span
                  >在“日历与节假日数据”中下载；下载失败时使用导入 JSON，不影响其他日历功能。</span
                >
              </div>
              <div>
                <strong>需要提交问题</strong
                ><span>先打开“查看日志”确认问题时间，再随问题描述一起提供必要日志。</span>
              </div>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('safety-support', el)"
            data-anchor-id="safety-support"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">项目与支持</h3>
            <p class="help-anchor-desc">{{ profile.greeting }}</p>
            <div class="help-support-card">
              <div class="help-support-item">
                <span>GitCode 仓库</span>
                <a :href="profile.gitcode" target="_blank" rel="noopener noreferrer">
                  {{ profile.gitcode }}
                </a>
              </div>
              <div class="help-support-item">
                <span>GitHub 仓库</span>
                <a :href="profile.github" target="_blank" rel="noopener noreferrer">
                  {{ profile.github }}
                </a>
              </div>
              <div class="help-support-item">
                <span>联系邮箱</span><strong>{{ profile.email }}</strong>
              </div>
            </div>
          </div>
        </section>
      </div>
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
  background: transparent;
}
.help-page-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 47rem;
  flex-shrink: 0;
  padding: 0 16rem;
  border-bottom: 1px solid var(--ui-border-divider);
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* ---- 悬浮多级目录（绝对定位，不占用文档流） ---- */
.help-nav {
  position: absolute;
  z-index: var(--z-local-top);
  /* 上移穿过 47rem 高的「帮助中心」子标题，使展开态目录与标题行平齐 */
  top: -40rem;
  left: 12rem;
  display: flex;
  flex-direction: column;
  max-height: calc(100% - 24rem);
  width: 190rem;
  padding: 6rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 14rem;
  background: var(--surface-float);
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.16);
  transform-origin: top left;
  transition:
    opacity 200ms var(--ease-standard),
    transform 240ms var(--ease-standard);
}
.help-nav.is-collapsed {
  opacity: 0;
  transform: translateX(-110%);
  pointer-events: none;
}
.help-nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4rem 4rem 6rem 10rem;
}
.help-nav-caption {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.86);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.help-nav-collapse {
  display: grid;
  place-items: center;
  width: 24rem;
  height: 24rem;
  padding: 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.help-nav-collapse:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.help-nav-collapse:active {
  transform: scale(0.98);
}
.help-nav-collapse svg {
  width: 15rem;
  height: 15rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.help-nav-list {
  display: flex;
  flex-direction: column;
  gap: 4rem;
  min-height: 0;
  overflow-y: auto;
}
.help-nav-group {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.help-nav-item {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding: 7rem 11rem;
  border: 0;
  border-radius: 10rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.help-nav-item:hover {
  color: var(--text-color);
}
.help-nav-item:active {
  transform: scale(0.98);
}
.help-nav-item.is-active {
  background: color-mix(in srgb, #0071e3 14%, transparent);
  color: var(--text-color);
}
.help-nav-title {
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-nav-hint {
  font-size: calc(var(--fs-secondary) * 0.82);
  opacity: 0.7;
}
/* ---- 二级子标题 ---- */
.help-nav-sub {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin: 1rem 0 3rem 12rem;
  padding-left: 10rem;
  border-left: 1px solid var(--ui-border-divider);
}
.help-nav-subitem {
  padding: 4rem 9rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}
.help-nav-subitem:hover {
  color: var(--text-color);
}
.help-nav-subitem.is-active {
  color: var(--text-color);
  font-weight: 600;
  background: color-mix(in srgb, #0071e3 10%, transparent);
}

/* ---- 收起后的悬浮唤出按钮 ---- */
.help-nav-fab {
  position: absolute;
  z-index: var(--z-local-top);
  /* 与展开态目录同基线：上移 40rem 让唤出按钮与「帮助中心」标题行平齐 */
  top: -40rem;
  left: 12rem;
  display: grid;
  place-items: center;
  width: 34rem;
  height: 34rem;
  padding: 0;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 8rem 22rem rgba(0, 0, 0, 0.14);
  color: var(--text-color-secondary);
  cursor: pointer;
  opacity: 0;
  transform: translateX(-14rem);
  pointer-events: none;
  transition:
    opacity 200ms var(--ease-standard),
    transform 240ms var(--ease-standard),
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease;
}
.help-nav-fab.is-visible {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}
.help-nav-fab:hover {
  background: var(--surface-float);
  color: var(--text-color);
}
.help-nav-fab:active {
  transform: scale(0.98);
}
.help-nav-fab svg {
  width: 17rem;
  height: 17rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ---- 右侧内容（占满宽度，目录悬浮在上方） ---- */
.help-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 20rem 22rem 40rem;
  color: var(--text-color);
  container-type: inline-size;
  /* 帮助中心为阅读页，正文可选中复制（覆盖全局 body 的 user-select:none）。 */
  user-select: text;
}
.help-section {
  scroll-margin-top: 8rem;
  padding-bottom: 26rem;
  margin-bottom: 26rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.help-section--last {
  border-bottom: 0;
}
.help-section-head h2 {
  margin: 0 0 8rem;
  font-size: calc(var(--fs-body) * 1.24);
  font-weight: 700;
}
.help-summary {
  margin: 0 0 16rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.7;
}
.help-summary strong {
  color: var(--text-color);
  font-weight: 600;
}

/* ---- 功能子标题锚点 ---- */
.help-anchor {
  scroll-margin-top: 8rem;
  padding-top: 8rem;
  margin-top: 18rem;
}
.help-anchor:first-of-type {
  margin-top: 4rem;
}
.help-anchor-title {
  margin: 0 0 8rem;
  font-size: calc(var(--fs-body) * 1.06);
  font-weight: 700;
}
.help-anchor-title::before {
  content: '';
  display: inline-block;
  width: 4rem;
  height: 14rem;
  margin-right: 8rem;
  border-radius: 2rem;
  background: #0071e3;
  vertical-align: -2rem;
}
.help-anchor-desc {
  margin: 0 0 12rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.7;
}
.help-anchor-desc strong {
  color: var(--text-color);
  font-weight: 600;
}
.help-anchor-desc code,
.help-sub-text code {
  padding: 1rem 5rem;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  font-family: var(--font-mono, monospace);
  font-size: 0.92em;
}

/* ---- 要点列表 ---- */
.help-points {
  display: flex;
  flex-direction: column;
  gap: 7rem;
  margin: 0 0 4rem;
  padding-left: 18rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.65;
}
.help-points li::marker {
  color: color-mix(in srgb, #0071e3 70%, var(--text-color));
}
.help-points strong {
  color: var(--text-color);
  font-weight: 600;
}

/* ---- 杂项多级子标题 ---- */
.help-sub {
  display: flex;
  flex-direction: column;
  gap: 4rem;
  padding-left: 12rem;
  border-left: 2px solid var(--ui-border-divider);
}
.help-subhead {
  margin: 8rem 0 2rem;
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-subhead:first-child {
  margin-top: 0;
}
.help-sub-text {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.7;
}

/* ---- 图解式：图块列与块内小控件仿造 ---- */
.help-figures {
  display: flex;
  flex-direction: column;
  gap: 10rem;
  margin-top: 14rem;
  container-type: inline-size;
}
.help-fig-rings {
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  gap: 8rem;
  width: 100%;
}
.help-fig-rings span {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.84);
}
.help-fig-rings em {
  font-style: normal;
}
.help-fig-menu {
  display: flex;
  flex-direction: column;
  min-width: 96rem;
  padding: 4rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 9rem;
  background: var(--surface-float);
  box-shadow: 0 6rem 18rem rgba(0, 0, 0, 0.16);
}
.help-fig-menu span {
  padding: 6rem 10rem;
  border-radius: 6rem;
  color: var(--text-color);
  font-size: var(--fs-secondary);
}
.help-fig-menu .is-danger {
  color: #ff453a;
}
.help-fig-seg {
  display: inline-flex;
  padding: 2rem;
  border-radius: 9rem;
  background: var(--ui-fill-pressed);
}
.help-fig-seg--wrap {
  flex-wrap: wrap;
  gap: 2rem;
}
.help-fig-seg span {
  padding: 4rem 10rem;
  border-radius: 7rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.help-fig-seg .is-active {
  background: rgb(var(--bg-color) / 0.6);
  color: var(--text-color);
  font-weight: 600;
}
.help-fig-createbox {
  display: flex;
  align-items: center;
  gap: 8rem;
  width: 100%;
  height: 36rem;
  padding: 0 10rem;
  border: 1px dashed var(--ui-border-hover);
  border-radius: 10rem;
  background: var(--ui-fill-hover);
}
.help-fig-plus {
  display: grid;
  place-items: center;
  width: 20rem;
  height: 20rem;
  color: var(--text-color);
  font-size: calc(var(--fs-body) * 1.2);
  line-height: 1;
}
.help-fig-createbox em {
  color: var(--text-color-secondary);
  font-style: normal;
  font-size: var(--fs-secondary);
  opacity: 0.8;
}
.help-fig-appearance {
  display: flex;
  align-items: center;
  gap: 8rem;
}
.help-fig-dot {
  width: 18rem;
  height: 18rem;
  border-radius: 50%;
  border: 2rem solid transparent;
  box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.3);
}
.help-fig-dot--active {
  border-color: #0a84ff;
}
.help-fig-hex {
  padding: 3rem 8rem;
  border: 1px solid var(--ui-border-hover);
  border-radius: 7rem;
  color: var(--text-color-secondary);
  font-family: var(--font-family-mono, monospace);
  font-size: var(--fs-secondary);
}
.help-fig-stack {
  display: flex;
  align-items: center;
  gap: 12rem;
  flex-wrap: wrap;
}
.help-fig-toggle {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  width: 34rem;
  height: 20rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-color) 22%, transparent);
}
.help-fig-toggle i {
  position: absolute;
  top: 2rem;
  left: 2rem;
  width: 16rem;
  height: 16rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.25);
}
.help-fig-toggle--on {
  background: #30d158;
}
.help-fig-toggle--on i {
  left: auto;
  right: 2rem;
}
.help-fig-slider {
  position: relative;
  flex: 1;
  min-width: 90rem;
  height: 4rem;
  border-radius: 2rem;
  background: color-mix(in srgb, var(--text-color) 16%, transparent);
}
.help-fig-slider i {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 2rem;
  background: #0a84ff;
}
.help-fig-slider b {
  position: absolute;
  top: 50%;
  width: 12rem;
  height: 12rem;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 4rem rgba(0, 0, 0, 0.3);
}
.help-fig-imgbox {
  display: grid;
  place-items: center;
  width: 100%;
  height: 60rem;
  border-radius: 10rem;
  background: var(--ui-fill-pressed);
  color: var(--text-color-secondary);
}
.help-fig-imgbox svg {
  width: 48rem;
  height: 32rem;
}
.help-fig-btn {
  padding: 5rem 10rem;
  border: 1px solid var(--ui-border-hover);
  border-radius: 8rem;
  color: var(--text-color);
  font-size: var(--fs-secondary);
}

/* ---- 首页个人区 ---- */
.help-home-hero {
  padding: 6rem 0 8rem;
}
.help-home-title {
  margin: 0 0 12rem;
  font-size: calc(var(--fs-body) * 1.5);
  font-weight: 700;
}
.help-home-greeting {
  margin: 0;
  max-width: 640rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.8;
}
.help-home-subtitle {
  margin: 24rem 0 8rem;
  font-size: calc(var(--fs-body) * 1.12);
  font-weight: 650;
}
.help-home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220rem, 1fr));
  gap: 14rem;
  margin-top: 18rem;
}
.help-home-card {
  display: flex;
  flex-direction: column;
  gap: 10rem;
  padding: 16rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 14rem;
  background: rgb(var(--bg-color) / 0.04);
}
.help-home-card h3 {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}
.help-donate-lead {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-donate-row {
  display: flex;
  gap: 12rem;
}
.help-donate-item {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6rem;
  min-width: 0;
  margin: 0;
}
.help-donate-slot {
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 0;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border: 1px dashed var(--ui-border-hover);
  border-radius: 12rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.help-donate-slot img {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 12rem;
}
.help-donate-item figcaption {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.88);
  text-align: center;
}
.help-home-note {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-link-list {
  display: flex;
  flex-direction: column;
  gap: 8rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.help-link-list li {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
.help-link-label {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.84);
}
.help-link-value {
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
}
.help-link-list a {
  color: var(--ui-accent);
  text-decoration: none;
}
.help-link-list a:hover {
  text-decoration: underline;
}

/* ---- 可折叠字段列表（备用） ---- */
.help-field-list {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  margin-top: 16rem;
}
.help-field {
  border: 1px solid var(--ui-border-divider);
  border-radius: 10rem;
  background: rgb(var(--bg-color) / 0.03);
  overflow: hidden;
}
.help-field-title {
  display: flex;
  align-items: center;
  padding: 10rem 14rem;
  font-size: var(--fs-secondary);
  font-weight: 600;
  color: var(--text-color);
  cursor: pointer;
  list-style: none;
}
.help-field-title::-webkit-details-marker {
  display: none;
}
.help-field-title::before {
  content: '';
  display: inline-block;
  width: 6rem;
  height: 6rem;
  margin-right: 8rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
}
.help-field[open] > .help-field-title::before {
  transform: rotate(45deg);
}
.help-field-body {
  padding: 0 14rem 12rem;
}
.help-field-body p {
  margin: 0 0 6rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.92);
  line-height: 1.7;
}
.help-field-body p:last-child {
  margin-bottom: 0;
}
.help-field-warn {
  color: #e6a700 !important;
  font-size: calc(var(--fs-secondary) * 0.88) !important;
}

/* ---- 编号注解列表（新建便签等图文对照） ---- */
.help-anno-list {
  margin: 10rem 0 0;
  padding-left: 22rem;
  list-style: decimal;
}
.help-anno-list li {
  margin-bottom: 8rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.94);
  line-height: 1.7;
}
.help-anno-list li strong {
  color: var(--text-color);
}
.help-anno-warn {
  display: inline-block;
  margin-top: 4rem;
  color: #e6a700;
  font-style: normal;
  font-size: calc(var(--fs-secondary) * 0.88);
}

/* ---- 任务导向帮助页：步骤、作用域和状态流程 ---- */
.help-scope-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22rem;
  padding: 3rem 8rem;
  border-radius: 999px;
  background: var(--ui-accent-subtle);
  color: var(--ui-accent);
  font-size: calc(var(--fs-secondary) * 0.82);
  font-weight: 600;
}
.help-scope-chip--shared {
  background: color-mix(in srgb, #30d158 16%, transparent);
  color: color-mix(in srgb, #30d158 78%, var(--text-color));
}
.help-scope-chip--list {
  background: color-mix(in srgb, #bf5af2 16%, transparent);
  color: color-mix(in srgb, #bf5af2 78%, var(--text-color));
}
.help-scope-chip--calendar {
  background: color-mix(in srgb, #ff9f0a 16%, transparent);
  color: color-mix(in srgb, #ff9f0a 78%, var(--text-color));
}
.help-quick-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8rem;
  margin-top: 18rem;
}
.help-quick-steps > div {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4rem;
  min-width: 0;
  min-height: 68rem;
  padding: 10rem 7rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 12rem;
  background: var(--ui-surface-subtle);
  text-align: center;
}
.help-quick-steps strong {
  font-size: calc(var(--fs-secondary) * 0.9);
}
.help-quick-steps small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.74);
  line-height: 1.4;
}
.help-term-grid,
.help-scope-grid,
.help-effect-grid,
.help-action-grid,
.help-privacy-grid,
.help-platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180rem, 1fr));
  gap: 10rem;
  margin-top: 14rem;
}
.help-term-card,
.help-scope-grid > div,
.help-effect-grid > div,
.help-action-grid > div,
.help-privacy-grid > div,
.help-platform-grid > div {
  display: flex;
  flex-direction: column;
  gap: 7rem;
  min-width: 0;
  padding: 13rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 12rem;
  background: var(--ui-surface-subtle);
}
.help-term-card strong,
.help-effect-grid strong,
.help-action-grid strong,
.help-privacy-grid strong,
.help-platform-grid strong {
  font-size: var(--fs-secondary);
  font-weight: 650;
}
.help-term-card span,
.help-scope-grid p,
.help-effect-grid span,
.help-action-grid span,
.help-privacy-grid span,
.help-platform-grid span {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.65;
}
.help-wide-figure {
  margin: 12rem 0;
  padding: 14rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 14rem;
  background: var(--ui-surface-subtle);
  container-type: inline-size;
}
.help-wide-figure > * {
  margin-inline: auto;
}
.help-point-danger {
  color: #ff453a;
}
.help-point-danger strong {
  color: inherit;
}
.help-card-and-menu {
  display: flex;
  flex-direction: column;
  gap: 8rem;
  width: 100%;
}
.help-card-and-menu .help-fig-menu {
  align-self: flex-end;
}
.help-process-row,
.help-delete-flow {
  display: grid;
  align-items: center;
  gap: 9rem;
  margin: 12rem 0 16rem;
}
.help-process-row > i,
.help-delete-flow > i {
  color: var(--text-color-secondary);
  font-style: normal;
  text-align: center;
}
.help-process-row {
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
}
.help-process-row span {
  padding: 10rem;
  border-radius: 10rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.help-setting-table {
  display: flex;
  flex-direction: column;
  margin: 10rem 0;
  border-top: 1px solid var(--ui-border-divider);
}
.help-setting-table > div {
  display: grid;
  grid-template-columns: minmax(120rem, 0.34fr) minmax(0, 1fr);
  gap: 12rem;
  padding: 11rem 4rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.help-setting-table strong {
  font-size: var(--fs-secondary);
  font-weight: 600;
}
.help-setting-table span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.92);
  line-height: 1.65;
}
.help-action-grid .is-danger {
  border-color: color-mix(in srgb, #ff453a 42%, var(--ui-border-divider));
}
.help-action-grid .is-danger strong {
  color: #ff453a;
}
.help-delete-flow {
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
}
.help-delete-flow > div {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  min-width: 0;
  min-height: 94rem;
  padding: 12rem;
  border-radius: 11rem;
  background: var(--ui-surface-subtle);
  text-align: center;
}
.help-delete-flow span,
.help-delete-flow small {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.45;
}
.help-delete-flow strong {
  font-size: calc(var(--fs-secondary) * 0.94);
}
.help-delete-flow > div:last-of-type strong {
  color: #ff453a;
}
.help-warning-card {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  padding: 12rem 14rem;
  border-left: 3rem solid var(--ui-warning);
  border-radius: 0 10rem 10rem 0;
  background: color-mix(in srgb, var(--ui-warning) 11%, transparent);
}
.help-warning-card strong {
  font-size: var(--fs-secondary);
}
.help-warning-card span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  line-height: 1.6;
}
.help-privacy-grid .is-local {
  border-color: color-mix(in srgb, #30d158 38%, var(--ui-border-divider));
}
.help-support-card {
  display: flex;
  flex-direction: column;
  gap: 12rem;
  padding: 12rem 14rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 10rem;
  background: var(--ui-surface-subtle);
}
.help-support-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4rem;
}
.help-support-card span {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.help-support-card strong,
.help-support-card a {
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
}
.help-support-card a {
  color: var(--ui-accent);
  text-decoration: none;
}
.help-support-card a:hover {
  text-decoration: underline;
}

@container (max-width: 560px) {
  .help-process-row,
  .help-delete-flow {
    grid-template-columns: 1fr;
  }
  .help-process-row > i,
  .help-delete-flow > i {
    transform: rotate(90deg);
  }
}

@container (max-width: 430px) {
  .help-setting-table > div {
    grid-template-columns: 1fr;
    gap: 5rem;
  }
}
</style>
