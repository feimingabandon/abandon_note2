<script setup>
/**
 * HelpPage.vue — 帮助中心（从右滑入的整页面板）
 *
 * 布局：悬浮多级目录（模块 → 子标题，scroll-spy 高亮 + 点击平滑滚动） + 右侧滚动讲解区。
 * 信息架构按「页面」组织：便签列表 / 便签模板 / 设置 各为一个模块，模块下再拆分功能子标题；
 * 没有独立界面、藏在幕后的能力统一收进「杂项」，用多级标题精确定位。
 * 讲解范式：图解式 —— 每个有界面的模块先给一张整机仿造图（HelpMock + 编号标注），
 * 再逐条以「局部小图 + 解释」（HelpFigureBlock）拆解各子功能；幕后能力（杂项）无独立界面，保留文字讲解。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import HelpMock from './HelpMock.vue'
import HelpFigureBlock from './HelpFigureBlock.vue'
import MockNoteList from './mock/MockNoteList.vue'
import MockNoteCard from './mock/MockNoteCard.vue'
import MockStatusRing from './mock/MockStatusRing.vue'
import MockActionBar from './mock/MockActionBar.vue'
import MockTemplatePage from './mock/MockTemplatePage.vue'
import MockTemplateCard from './mock/MockTemplateCard.vue'
import MockSettings from './mock/MockSettings.vue'
import MockNewNotePanel from './mock/MockNewNotePanel.vue'

/**
 * 多级目录：每个模块对应一个「页面 / 功能域」，items 为该模块内的功能子标题（锚点）。
 * items 为空的模块（首页）自身即为锚点。
 */
const sections = [
  { id: 'home', title: '首页', hint: '关于与支持', items: [] },
  {
    id: 'notes',
    title: '便签列表',
    hint: '新建 · 卡片 · 搜索',
    items: [
      { id: 'notes-overview', title: '整体预览' },
      { id: 'notes-create', title: '新建便签' },
      { id: 'notes-card', title: '便签卡片' },
      { id: 'notes-status', title: '状态流转' },
      { id: 'notes-search', title: '搜索便签' },
      { id: 'notes-edit', title: '修改与删除' },
      { id: 'notes-list', title: '列表与排序' }
    ]
  },
  {
    id: 'template',
    title: '便签模板',
    hint: '周期自动生成',
    items: [
      { id: 'template-overview', title: '整体预览' },
      { id: 'template-create', title: '新建模板' },
      { id: 'template-frequency', title: '频率规则' },
      { id: 'template-card', title: '模板管理' },
      { id: 'template-run', title: '运行与容错' }
    ]
  },
  {
    id: 'settings',
    title: '设置',
    hint: '外观 · 窗口 · 工具',
    items: [
      { id: 'settings-overview', title: '整体预览' },
      { id: 'settings-appearance', title: '外观基调' },
      { id: 'settings-blur', title: '系统毛玻璃' },
      { id: 'settings-wallpaper', title: '壁纸' },
      { id: 'settings-window', title: '窗口与缩放' },
      { id: 'settings-tools', title: '数据与工具' }
    ]
  },
  {
    id: 'misc',
    title: '杂项',
    hint: '幕后能力',
    items: [
      { id: 'misc-snap', title: '贴边隐藏' },
      { id: 'misc-notify', title: '系统通知' },
      { id: 'misc-protocol', title: '通知点击跳转' },
      { id: 'misc-screenshot', title: '截图选取' },
      { id: 'misc-storage', title: '数据存储与找回' },
      { id: 'misc-scheduler', title: '后台调度器' },
      { id: 'misc-autostart', title: '开机自启' }
    ]
  }
]

/** 扁平化所有锚点并附带所属模块，供 scroll-spy 联动高亮使用。 */
const anchors = sections.flatMap((s) =>
  s.items.length
    ? s.items.map((it) => ({ ...it, moduleId: s.id }))
    : [{ id: s.id, title: s.title, moduleId: s.id }]
)

/** 作者可后续替换的个人信息占位。 */
const profile = reactive({
  greeting:
    '这是一个常驻桌面的便签工具，希望它能帮你把「要做的事」安静地放在看得见的地方。感谢试用 —— 有想法或问题都欢迎反馈。',
  repo: 'https://gitcode.com/zou-feiming/abandon_note2',
  blog: '',
  donateReady: false
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
        <!-- 首页：纯个人内容区 -->
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
                <div class="help-donate-slot">
                  <span v-if="!profile.donateReady">打赏二维码占位</span>
                  <img v-else :src="profile.donate" alt="打赏二维码" />
                </div>
                <div class="help-donate-slot">
                  <span v-if="!profile.donateReady">打赏二维码占位</span>
                  <img v-else :src="profile.donateAlt" alt="打赏二维码" />
                </div>
              </div>
              <p class="help-home-note">支持是持续更新的动力 ☕</p>
            </div>

            <div class="help-home-card">
              <h3>项目与联系</h3>
              <ul class="help-link-list">
                <li>
                  <span class="help-link-label">代码仓库</span>
                  <span class="help-link-value">{{ profile.repo || '待补充' }}</span>
                </li>
                <li>
                  <span class="help-link-label">博客</span>
                  <span class="help-link-value">{{ profile.blog || '待补充' }}</span>
                </li>
              </ul>
              <p class="help-home-note">后续这里放作者的更多内容。</p>
            </div>
          </div>
        </section>

        <!-- 模块一：便签列表 -->
        <section data-section-id="notes" class="help-section">
          <div class="help-section-head">
            <h2>便签列表</h2>
            <p class="help-summary">
              主界面的核心页面。所有便签以卡片形式呈现，从<strong>新建</strong>、<strong>查看</strong>、<strong>搜索</strong>到<strong>修改删除</strong>都在这里完成。便签按
              <strong>初始化 → 进行中 → 已完成</strong> 三态流转，点击卡片左侧圆环即可推进。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('notes-overview', el)"
            data-anchor-id="notes-overview"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">整体预览</h3>
            <p class="help-anchor-desc">
              下面是便签列表的完整界面（HTML
              仿造，仅供查看）。图上的红色编号对应下方逐条讲解的区域，看图对号即可。
            </p>
            <HelpMock
              caption="便签列表整机示意（仿造界面，非真实数据）"
              :annotations="[
                { n: 1, x: 25, y: 34 },
                { n: 2, x: 64, y: 52 },
                { n: 3, x: 11, y: 52 },
                { n: 4, x: 80, y: 34 },
                { n: 5, x: 52, y: 70 },
                { n: 6, x: 90, y: 12 }
              ]"
            >
              <MockNoteList />
            </HelpMock>
          </div>

          <div class="help-figures">
            <div :ref="(el) => registerAnchor('notes-create', el)" data-anchor-id="notes-create">
              <HelpFigureBlock :n="1" title="新建便签">
                <template #figure><MockNewNotePanel /></template>
                <p>点击顶部操作栏的「＋」按钮展开面板。下面是各字段说明：</p>
                <ol class="help-anno-list">
                  <li>
                    <strong>正文输入框</strong> —— 唯一必填项，支持多行（Enter
                    换行），无字数上限。正文为空时创建按钮不可点。
                  </li>
                  <li>
                    <strong>生效时间</strong> ——
                    默认「立即生效」，创建后直接进入「进行中」。也可选「指定时间」（最早当前 +2
                    分钟），到点前保持「初始化」，到点后自动切为「进行中」。
                  </li>
                  <li>
                    <strong>持续天数</strong> —— 选择生效时间后显示，默认 1
                    天。只决定便签在日历视图中连续占用的日期格数，不会自动完成便签，也不改变列表状态。
                  </li>
                  <li>
                    <strong>系统提醒</strong> ——
                    生效时间到达时弹出系统通知。仅在选择了「指定时间」后可开启；「立即生效」时此项不可用。<br />
                    <em class="help-anno-warn"
                      >⚠️ macOS 平台暂时无法开启系统通知（受限于 Electron 平台约束）。</em
                    >
                  </li>
                  <li>
                    <strong>置顶</strong> ——
                    开启后便签始终固定在列表最顶部，不受时间排序影响。多条置顶便签按创建时间倒序排列。
                  </li>
                  <li>
                    <strong>标签</strong> ——
                    每条便签最多添加一个分类标签，用于分类管理和搜索筛选。外层优先显示当前选中的标签，其余标签遵循标签分组中的手动顺序；「更多」后的数字是标签总数。打开更多面板可搜索和选择标签，进入「管理标签」后可新建、修改和删除。标签全局共享，所有便签和模板复用同一套。
                  </li>
                  <li>
                    <strong>图片附件</strong> —— 支持点击上传或粘贴。单张 ≤ 50MB，单批新增 ≤
                    200MB，每条最多 50 张（JPG / PNG / WebP）。
                  </li>
                  <li>
                    <strong>创建便签</strong> —— 正文非空后可点击。创建成功后显示绿色
                    ✔，面板自动收起并重置字段。
                  </li>
                </ol>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-card', el)" data-anchor-id="notes-card">
              <HelpFigureBlock :n="2" title="便签卡片">
                <template #figure>
                  <MockNoteCard
                    status="in_progress"
                    content="下午 3 点和设计团队过一遍新版本的交互稿。"
                    time-text="今天 15:00"
                    :tags="[{ name: '工作' }]"
                    :more-tags="1"
                    :attachments="2"
                    disclosure
                  />
                </template>
                <p>
                  卡片正文下方是信息行：左侧「状态 ·
                  时间」，右下角依次是<strong>标签</strong>、<strong>复制正文</strong>、<strong>图片附件</strong>。标签超过
                  2 个折叠为「+N」，点击展开；正文超过 3
                  行自动折叠，点右侧<strong>箭头</strong>展开或收起。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-status', el)" data-anchor-id="notes-status">
              <HelpFigureBlock :n="3" title="状态流转">
                <template #figure>
                  <div class="help-fig-rings">
                    <span><MockStatusRing status="initialized" /><em>初始化</em></span>
                    <span><MockStatusRing status="in_progress" /><em>进行中</em></span>
                    <span><MockStatusRing status="completed" /><em>已完成</em></span>
                  </div>
                </template>
                <p>
                  卡片左侧圆环既显示状态又是主操作按钮：<strong>蓝色</strong>初始化、<strong>橙色</strong>进行中、<strong>绿色</strong>已完成。点击圆环推进到下一状态，完成后还能点回「重新进行」。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-search', el)" data-anchor-id="notes-search">
              <HelpFigureBlock :n="4" title="搜索便签">
                <template #figure><MockActionBar grow="search" /></template>
                <p>
                  搜索框按正文关键词即时查找；点筛选按钮展开<strong>高级筛选</strong>，多条件可叠加：<strong>状态</strong>、<strong>标签</strong>（多选为「同时满足
                  AND」）、<strong>时间范围</strong>、<strong>置顶 / 含附件</strong
                  >、<strong>包含已删除</strong>（用于找回）。结果分屏加载，每屏 5 条。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-edit', el)" data-anchor-id="notes-edit">
              <HelpFigureBlock :n="5" title="修改与删除">
                <template #figure>
                  <div class="help-fig-menu">
                    <span>修改</span>
                    <span class="is-danger">删除</span>
                  </div>
                </template>
                <p>
                  在卡片上<strong>右键</strong>打开「修改 /
                  删除」菜单。修改会打开编辑器，可改正文、生效时间、提醒、置顶、标签与附件。删除是<strong>软删除</strong>（移入回收，数据仍在），在搜索里启用「包含已删除」即可找回并恢复。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('notes-list', el)" data-anchor-id="notes-list">
              <HelpFigureBlock :n="6" title="列表与排序">
                <template #figure>
                  <div class="help-fig-seg">
                    <span class="is-active">时间线</span>
                    <span>自定义</span>
                    <span>标签分组</span>
                  </div>
                </template>
                <p>
                  列表提供三种组织方式：<strong>时间线模式</strong>按生效时间自动排列、置顶始终在前；<strong>自定义模式</strong>可拖拽卡片手动调整顺序，适合固定清单；<strong>标签分组模式</strong>按筛选出的标签及“未分类”组织可折叠分组，组内从未来到过去排列并按需加载。点击“便签”标题旁的排序按钮会先收起全部分组，再进入整行拖动模式；点击勾号完成排序，“未分类”始终固定在末尾，筛选后的局部排序不会改动隐藏标签。分组空白处或便签右键可直接新建标签分组。右上角可直接选择。
                </p>
              </HelpFigureBlock>
            </div>
          </div>
        </section>

        <!-- 模块二：便签模板 -->
        <section data-section-id="template" class="help-section">
          <div class="help-section-head">
            <h2>便签模板</h2>
            <p class="help-summary">
              把重复出现的事情做成<strong>循环模板</strong>，系统会按设定的周期到点自动生成一条新便签，无需每次手动新建。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('template-overview', el)"
            data-anchor-id="template-overview"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">整体预览</h3>
            <p class="help-anchor-desc">
              下面是便签模板页的完整界面（仿造，仅供查看）。图上编号对应下方逐条讲解。
            </p>
            <HelpMock
              caption="便签模板页整机示意（仿造界面）"
              :annotations="[
                { n: 1, x: 30, y: 22 },
                { n: 2, x: 52, y: 56 },
                { n: 3, x: 62, y: 62 },
                { n: 4, x: 18, y: 56 }
              ]"
            >
              <MockTemplatePage />
            </HelpMock>
          </div>

          <div class="help-figures">
            <div
              :ref="(el) => registerAnchor('template-create', el)"
              data-anchor-id="template-create"
            >
              <HelpFigureBlock :n="1" title="新建模板">
                <template #figure>
                  <div class="help-fig-createbox">
                    <span class="help-fig-plus">+</span>
                    <em>展开以新建循环模板…</em>
                  </div>
                </template>
                <p>
                  在模板页新建模板，填正文再配置生成规则。除频率外可预设生成便签的附加属性：<strong>生成时刻</strong>（时分）、<strong
                    >通知 / 置顶 / 标签</strong
                  >。配置时会实时显示<strong>下次生成预览</strong>，便于确认规则正确。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('template-frequency', el)"
              data-anchor-id="template-frequency"
            >
              <HelpFigureBlock :n="2" title="频率规则">
                <template #figure>
                  <div class="help-fig-seg help-fig-seg--wrap">
                    <span class="is-active">每天</span>
                    <span>每周</span>
                    <span>每月</span>
                    <span>每年</span>
                  </div>
                </template>
                <p>
                  支持四种周期：<strong>每天</strong>（可设间隔 N
                  天，1–3650）、<strong>每周</strong>（勾选周几）、<strong>每月</strong>（第几日
                  1–31）、<strong>每年</strong>（月份 + 日期，对 2 月 29 日等做闰年处理）。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('template-card', el)" data-anchor-id="template-card">
              <HelpFigureBlock :n="3" title="模板管理">
                <template #figure>
                  <MockTemplateCard
                    state="running"
                    state-label="运行中"
                    rule="每天 09:00"
                    content="早会前梳理今天的三件要事。"
                    context-text="下次 明天 09:00"
                    :tags="[{ name: '工作' }]"
                    notify
                    pinned
                  />
                </template>
                <p>
                  每个模板是一张卡片，可随时调整运行状态：<strong>暂停 / 恢复</strong
                  >（暂停后不再生成，恢复从下一周期继续）、<strong>删除 / 恢复</strong
                  >（软删除可恢复）、<strong>彻底删除</strong>（永久移除）。还可按启用 / 暂停 /
                  已删除等状态<strong>筛选</strong>。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('template-run', el)" data-anchor-id="template-run">
              <HelpFigureBlock :n="4" title="运行与容错">
                <template #figure>
                  <MockTemplateCard
                    state="paused"
                    state-label="已暂停"
                    rule="每周 一/三/五 20:00"
                    content="健身打卡：完成一次力量训练。"
                    context-text="已暂停"
                    :tags="[{ name: '健康' }]"
                  />
                </template>
                <p>
                  后台调度按规则驱动模板，并内置稳健策略：<strong>错过不补偿</strong>（应用未运行错过的不批量补齐，只按最新周期继续）、<strong>通知去重</strong>（同一次生成不重复推送）、<strong>连续失败自动暂停</strong>（连续失败
                  3 次自动暂停，避免反复报错）。
                </p>
              </HelpFigureBlock>
            </div>
          </div>
        </section>

        <!-- 模块三：设置 -->
        <section data-section-id="settings" class="help-section">
          <div class="help-section-head">
            <h2>设置</h2>
            <p class="help-summary">
              设置面板集中管理<strong>外观、窗口与数据</strong>。所有数值改动都会即时预览，满意后自动保存。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('settings-overview', el)"
            data-anchor-id="settings-overview"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">整体预览</h3>
            <p class="help-anchor-desc">
              下面是设置面板的完整界面（仿造，仅供查看）。图上编号对应下方逐条讲解。
            </p>
            <HelpMock
              caption="设置面板整机示意（仿造界面）"
              :annotations="[
                { n: 1, x: 74, y: 30 },
                { n: 2, x: 82, y: 54 },
                { n: 3, x: 40, y: 62 },
                { n: 4, x: 82, y: 80 },
                { n: 5, x: 82, y: 90 }
              ]"
            >
              <MockSettings />
            </HelpMock>
          </div>

          <div class="help-figures">
            <div
              :ref="(el) => registerAnchor('settings-appearance', el)"
              data-anchor-id="settings-appearance"
            >
              <HelpFigureBlock :n="1" title="外观基调">
                <template #figure>
                  <div class="help-fig-appearance">
                    <span class="help-fig-dot" style="background: #1c1c1e" />
                    <span class="help-fig-dot help-fig-dot--active" style="background: #ffffff" />
                    <span class="help-fig-dot" style="background: #0a84ff" />
                    <span class="help-fig-hex">#FFFFFF</span>
                  </div>
                </template>
                <p>
                  调整整体配色与字号：<strong>背景色 / 文字色</strong>自定义窗口配色；<strong
                    >基准字号</strong
                  >
                  14–22（默认 17），整个界面按此比例缩放；<strong>窗口不透明度</strong> 0–1（默认
                  0.6）；<strong>弹层霜层浓度</strong> 0–1（默认 0.2）。
                </p>
              </HelpFigureBlock>
            </div>

            <div :ref="(el) => registerAnchor('settings-blur', el)" data-anchor-id="settings-blur">
              <HelpFigureBlock :n="2" title="系统毛玻璃">
                <template #figure>
                  <div class="help-fig-stack">
                    <span class="help-fig-toggle help-fig-toggle--on"><i /></span>
                    <span class="help-fig-slider"
                      ><i style="width: 52%" /><b style="left: 52%"
                    /></span>
                  </div>
                </template>
                <p>
                  开启后窗口背后呈现真实系统毛玻璃（默认开启），<strong>与壁纸互斥</strong>。可调<strong
                    >模糊半径</strong
                  >
                  0–40（默认 20）、<strong>饱和度</strong> 0–2（默认 1.8）、<strong>圆角</strong>
                  0–30（默认 12）、<strong>内容背景模糊</strong> 0–30（默认 10）。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('settings-wallpaper', el)"
              data-anchor-id="settings-wallpaper"
            >
              <HelpFigureBlock :n="3" title="壁纸">
                <template #figure>
                  <div class="help-fig-imgbox">
                    <svg viewBox="0 0 48 32" aria-hidden="true">
                      <rect
                        x="1"
                        y="1"
                        width="46"
                        height="30"
                        rx="3"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                      />
                      <circle cx="13" cy="11" r="3.5" fill="currentColor" />
                      <path
                        d="M4 27l11-10 7 6 6-5 16 12"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </div>
                </template>
                <p>
                  为窗口设置自定义背景图（默认关闭），<strong>启用后自动关闭系统毛玻璃</strong>。导入图片后可用<strong>裁剪编辑器</strong>缩放、平移到合适构图；<strong
                    >壁纸模糊</strong
                  >
                  0–30（默认 8）让背景不干扰阅读。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('settings-window', el)"
              data-anchor-id="settings-window"
            >
              <HelpFigureBlock :n="4" title="窗口与缩放">
                <template #figure>
                  <div class="help-fig-stack">
                    <span class="help-fig-toggle help-fig-toggle--on"><i /></span>
                    <span class="help-fig-toggle"><i /></span>
                  </div>
                </template>
                <p>
                  <strong>窗口置顶</strong
                  >默认开启，让便签始终浮在其他窗口之上；<strong>锁定窗口</strong>默认关闭，锁定后禁止拖动与缩放，防止误触；<strong>窗口缩放</strong>可拖动边缘调整，范围约
                  240–16384 像素。
                </p>
              </HelpFigureBlock>
            </div>

            <div
              :ref="(el) => registerAnchor('settings-tools', el)"
              data-anchor-id="settings-tools"
            >
              <HelpFigureBlock :n="5" title="数据与工具">
                <template #figure>
                  <div class="help-fig-stack">
                    <span class="help-fig-toggle help-fig-toggle--on"><i /></span>
                    <span class="help-fig-btn">调度器诊断</span>
                  </div>
                </template>
                <p>
                  <strong>开机自启</strong
                  >开启后随系统登录自动启动；<strong>调度器诊断</strong>查看后台调度运行状态，便于排查提醒异常；<strong
                    >清空数据 / 重置设置</strong
                  >请谨慎操作，用于彻底清理或恢复默认。
                </p>
              </HelpFigureBlock>
            </div>
          </div>
        </section>

        <!-- 模块四：杂项（无独立界面的幕后能力，用多级标题精确定位） -->
        <section data-section-id="misc" class="help-section help-section--last">
          <div class="help-section-head">
            <h2>杂项</h2>
            <p class="help-summary">
              这些能力没有独立的设置界面，却默默支撑着日常体验。下面按主题分条讲清它们各自「藏」在哪里、如何触发。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-snap', el)"
            data-anchor-id="misc-snap"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">贴边隐藏</h3>
            <p class="help-anchor-desc">
              把窗口拖到屏幕边缘（吸附阈值约 20
              像素）时，窗口会自动收起为一条细边，鼠标移上去再滑出，节省桌面空间。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-notify', el)"
            data-anchor-id="misc-notify"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">系统通知</h3>
            <div class="help-sub">
              <h4 class="help-subhead">通知展示</h4>
              <p class="help-sub-text">
                Windows 到生效时间时使用系统富通知提醒。macOS 系统通知需要付费的 Apple Developer
                证书签名，当前版本暂未开通，因此新建便签、修改便签和循环模板中的通知设置会被禁用。
              </p>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-protocol', el)"
            data-anchor-id="misc-protocol"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">通知点击跳转</h3>
            <p class="help-anchor-desc">
              Windows
              用户点击系统通知后，会通过自定义协议（<code>abandon-note://</code>）唤起应用并定位到对应便签，即使窗口当前被隐藏或最小化也能被唤出。macOS
              当前不启用系统通知。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-screenshot', el)"
            data-anchor-id="misc-screenshot"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">截图选取</h3>
            <p class="help-anchor-desc">
              新建 / 编辑便签时可发起截图，框选屏幕区域直接作为图片附件插入，无需先存成文件再上传。
            </p>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-storage', el)"
            data-anchor-id="misc-storage"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">数据存储与找回</h3>
            <div class="help-sub">
              <h4 class="help-subhead">本地存储</h4>
              <p class="help-sub-text">
                所有便签、模板与设置保存在本地 SQLite 数据库；图片附件与壁纸分别存放在独立的
                attachments / wallpapers 目录，随应用一起持久化。
              </p>
              <h4 class="help-subhead">软删除找回</h4>
              <p class="help-sub-text">
                删除便签或模板只是标记为已删除，数据仍在。便签可在搜索里启用「包含已删除」找回，模板可在其筛选中恢复；确认不再需要时再执行彻底删除。
              </p>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-scheduler', el)"
            data-anchor-id="misc-scheduler"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">后台调度器</h3>
            <div class="help-sub">
              <h4 class="help-subhead">整分对齐</h4>
              <p class="help-sub-text">
                调度主线按整分钟触发，负责激活到期便签、推送提醒、生成模板便签，让「到点」尽量精准。
              </p>
              <h4 class="help-subhead">看门狗与熔断</h4>
              <p class="help-sub-text">
                另有看门狗定期（约 5
                分钟）自检，发现主线卡住会重启；异常连续累积到阈值会触发熔断并弹出告警通知，提示可能需要检查。
              </p>
              <h4 class="help-subhead">状态自动流转</h4>
              <p class="help-sub-text">
                每分钟检查一次，把到达生效时间的「初始化」便签自动推进为「进行中」，无需手动干预。
              </p>
            </div>
          </div>

          <div
            :ref="(el) => registerAnchor('misc-autostart', el)"
            data-anchor-id="misc-autostart"
            class="help-anchor"
          >
            <h3 class="help-anchor-title">开机自启</h3>
            <p class="help-anchor-desc">
              在设置中开启开机自启后，应用会随系统登录在后台启动，确保循环模板与提醒不会因为忘记打开而错过。
            </p>
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
.help-donate-slot {
  display: grid;
  place-items: center;
  flex: 1;
  min-width: 0;
  aspect-ratio: 1 / 1;
  border: 1px dashed var(--ui-border-hover);
  border-radius: 12rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  text-align: center;
}
.help-donate-slot img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 12rem;
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
</style>
