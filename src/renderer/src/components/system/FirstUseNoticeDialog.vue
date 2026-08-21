<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { FIRST_USE_NOTICE_VERSION } from '../../../../shared/settings-schema.js'
import wechatAppreciationQr from '../../resources/help/wechat-appreciation-qr.png'
import alipayAppreciationQr from '../../resources/help/alipay-appreciation-qr.jpg'
import { useMessage } from '../../composables/useMessage.js'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'

const props = defineProps({
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['completed'])
const { showMessage } = useMessage()
const step = ref('story')
const saving = ref(false)
const readingProgress = ref(0)
const revealReady = ref(false)
const stageRef = ref(null)
const storyScrollRef = ref(null)
let revealObserver = null

const isSupportStep = computed(() => step.value === 'support')
const modalTitle = computed(() => (isSupportStep.value ? '感谢你的支持' : '欢迎使用 Abandon 便签'))
const modalSubtitle = computed(() =>
  isSupportStep.value ? '你的赞赏会成为继续维护和更新它的动力' : '开始之前，允许作者先碎碎念一会儿'
)

function updateReadingProgress() {
  const element = storyScrollRef.value
  if (!element) return
  const scrollable = Math.max(0, element.scrollHeight - element.clientHeight)
  readingProgress.value = scrollable === 0 ? 100 : (element.scrollTop / scrollable) * 100
}

function disconnectRevealObserver() {
  revealObserver?.disconnect()
  revealObserver = null
}

async function prepareStoryMotion() {
  disconnectRevealObserver()
  revealReady.value = false
  await nextTick()
  const root = storyScrollRef.value
  if (!root) return
  const targets = [...root.querySelectorAll('[data-reveal]')]
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        revealObserver?.unobserve(entry.target)
      })
    },
    { root, rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  )
  targets.forEach((target) => revealObserver.observe(target))
  requestAnimationFrame(() => {
    revealReady.value = true
  })
  updateReadingProgress()
}

function openSupport() {
  step.value = 'support'
}

function returnToStory() {
  step.value = 'story'
}

function focusCurrentStep() {
  const modal = stageRef.value?.closest('.app-modal-card')
  const target = modal?.querySelector('[data-modal-initial-focus]')
  target?.focus?.({ preventScroll: true })
}

async function complete(route) {
  if (saving.value) return
  saving.value = true
  try {
    await window.api.setSettingValue('onboarding.noticeVersion', FIRST_USE_NOTICE_VERSION)
    emit('completed', { route })
  } catch (error) {
    console.warn('[FirstUseNoticeDialog] 保存首次使用须知状态失败:', error)
    showMessage('error', '已阅读状态保存失败，请重试', 4000)
  } finally {
    saving.value = false
  }
}

watch(
  [() => props.visible, step],
  ([visible, currentStep], previous = []) => {
    const [previousVisible] = previous
    if (!visible) {
      disconnectRevealObserver()
      revealReady.value = false
      readingProgress.value = 0
      step.value = 'story'
      return
    }
    if (!previousVisible || currentStep === 'story') void prepareStoryMotion()
    else disconnectRevealObserver()
  },
  { immediate: true }
)

onBeforeUnmount(disconnectRevealObserver)
</script>

<template>
  <AppModalShell
    :visible="visible"
    :title="modalTitle"
    :subtitle="modalSubtitle"
    eyebrow="初次使用须知"
    :aria-label="modalTitle"
    width="min(760rem, calc(100vw - 30rem))"
    height="min(760rem, calc(100vh - 30rem))"
    max-height="calc(100vh - 30rem)"
    :show-close="false"
    close-disabled
    :close-on-backdrop="false"
    flush
  >
    <div ref="stageRef" class="first-use-stage">
      <div
        class="reading-progress"
        :class="{ 'is-hidden': isSupportStep }"
        role="progressbar"
        aria-label="须知阅读进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(readingProgress)"
      >
        <span :style="{ width: `${readingProgress}%` }" />
      </div>

      <Transition name="notice-step" mode="out-in" @after-enter="focusCurrentStep">
        <article
          v-if="!isSupportStep"
          key="story"
          ref="storyScrollRef"
          class="notice-story scroll-y"
          :class="{ 'is-reveal-ready': revealReady }"
          @scroll.passive="updateReadingProgress"
        >
          <p class="opening-line" data-reveal>
            <span class="opening-year">2025</span>
            <span class="opening-copy">年，是一切罪恶的开始。</span>
          </p>

          <p data-reveal>
            作者正处于失业的煎熬中，本想找个免费的便签，写点规划。谁能想到，如此简单的应用居然也能收费。于是作者一怒之下，决定自己写一个。
          </p>

          <p data-reveal>就这样，Abandon 便签 0.0.1 版本问世了。</p>

          <p class="broken-result" data-reveal>过程是坎坷的，<span>结果是稀碎的。</span></p>

          <p data-reveal>
            第一次正儿八经开发软件，作者才发现需要处理的问题远比想象中多。多屏幕、多尺寸、多缩放……一个个始料未及的问题扑面而来，以至于最初的它看上去更像一个玩具，还是一碰就碎的那种。
          </p>

          <p data-reveal>但是，冥冥之中似乎总有一种力量推着我继续前行。</p>

          <p data-reveal>
            虽然软件稀碎，可自从发布到小红书以后，却得到了很多人的喜欢。即使到了 2026
            年，仍然时常有人点赞、收藏，也有很多同学认真地向我提出建议。
          </p>

          <p class="quiet-confession" data-reveal>坦白讲，我受之有愧。</p>

          <p data-reveal>
            从初版问世开始，我就一直琢磨着要重构它。但懒惰与拖延的诱惑，换来了一次又一次的延期。也正因如此，很长一段时间里，我甚至不敢打开小红书，不敢面对你们的点赞和收藏。
          </p>

          <p data-reveal>
            但是没招，小红书的消息总会在不经意间出现在我的通知列表中。每一次推送，每一个点赞、收藏和评论，都像是一种特别的催稿。
          </p>

          <p data-reveal>
            人总会给自己附加上一些奇怪的使命感，仿佛自己就站在道德高地上，居高临下地怒斥这个不公、那个不对。对不对先不说，但确实挺中二的。
          </p>

          <p data-reveal>这么看我好歹也整上一句：</p>

          <p class="mission-line" data-reveal>
            当我敲下第一行属于 Abandon 便签的代码时，我便知道——它会是这个赛道的
            <strong>天下第一</strong>。
          </p>

          <p data-reveal>过程自然不会一帆风顺，但不必多言。</p>

          <p data-reveal>我只想让你知道：</p>

          <p class="declaration-line" data-reveal>
            别的软件有的，它也有。<br />别的软件没有的，它还有。
          </p>

          <div class="feature-run" data-reveal>
            <p class="feature-cloud">
              <span>什么月视图、周视图、列表、标签分组、循环模板便签，都是基础。</span>
            </p>
          </div>

          <p class="interaction-line" data-reveal>
            它最大的优点，是<span>UI</span>，也是<span>交互</span>。
          </p>

          <div class="feature-ledger" aria-label="功能简介">
            <p data-reveal>
              Windows 10 和 Windows 11
              支持原生毛玻璃，可以自由调节毛玻璃样式。你喜欢的样子，它都有。
            </p>
            <p data-reveal>
              支持贴边隐藏，就像 QQ 那样。还可以选择触边确认或常显确认小黑条，减少误触。
            </p>
            <p data-reveal>支持丰富的样式设置。设置页面，值得你亲自探索。</p>
            <p data-reveal>支持丰富的交互动画。让每一次点击都尽量赏心悦目。</p>
            <p data-reveal>默认采用苹果式 UI 风格，也可以切换标题栏样式。</p>
            <p data-reveal>简约不等于简单，美好应该恰如其分。</p>
          </div>

          <p class="open-source-line" data-reveal>
            <span class="infinity-mark" aria-hidden="true">∞</span>
            <strong>永久免费，始终开源。</strong>
          </p>

          <p class="support-confession" data-reveal>
            当然，作者肯定也喜欢钱。只不过比起钱，更喜欢它真的被大家使用、分享和推荐。
          </p>

          <p class="recommend-line" data-reveal>你的推荐，我求之不得。</p>

          <p class="closing-line" data-reveal>Abandon 便签，等你来探索……</p>

          <section class="actual-notice" aria-label="真正的初次使用须知" data-reveal>
            <div class="actual-notice__lead">
              <span aria-hidden="true">!</span>
              <p>最后，还有几件真正需要告诉你的事：</p>
            </div>
            <ul>
              <li>
                便签、标签、模板、附件和壁纸保存在当前设备中。Abandon
                便签不提供云同步，也不会上传这些内容。重要资料请自行保留额外备份。
              </li>
              <li>
                首次启动会发送一次匿名基础设备统计，用于估算实际启动的安装数量。“接收软件通知”和“后续设备统计”默认开启，但不会上传便签正文、标签、模板、附件或壁纸。你可以在“设置
                →
                远程服务与隐私”中关闭；修改后的选择将在下次启动时停止后续通知或统计，不会撤回首次启动已经发送的统计。
              </li>
              <li>
                关闭主窗口后，Abandon
                便签会继续留在系统托盘。定时提醒依赖应用保持运行，也可能受到系统休眠、关机和通知权限的影响。
              </li>
              <li>
                软件仍在持续开发，难免存在不完善之处。重要内容不要只保存一份；遇到问题时，可以在设置中查看或导出运行日志。
              </li>
              <li>
                Abandon
                便签永久免费，也会始终保持开源。赞赏完全自愿，不会解锁功能，也不会影响任何功能。
              </li>
            </ul>
          </section>
        </article>

        <section v-else key="support" class="support-view scroll-y" aria-label="赞赏作者">
          <div class="support-symbol" aria-hidden="true">
            <span>☕</span>
          </div>
          <p class="support-lead">
            如果 Abandon 便签恰好帮到了你，可以请作者喝杯咖啡。金额不重要，心意已经足够。
          </p>

          <div class="qr-grid">
            <figure class="qr-card">
              <div class="qr-viewport qr-viewport--wechat">
                <img
                  class="qr-image qr-image--wechat"
                  :src="wechatAppreciationQr"
                  alt="小邹的微信赞赏码"
                />
              </div>
              <figcaption>
                <strong>微信赞赏</strong>
                <span>谢谢你愿意支持这个小项目</span>
              </figcaption>
            </figure>

            <figure class="qr-card">
              <div class="qr-viewport qr-viewport--alipay">
                <img
                  class="qr-image qr-image--alipay"
                  :src="alipayAppreciationQr"
                  alt="小邹的支付宝收款码"
                />
              </div>
              <figcaption>
                <strong>支付宝</strong>
                <span>量力而行，绝不影响正常使用</span>
              </figcaption>
            </figure>
          </div>

          <p class="support-note">
            赞赏不会解锁任何隐藏功能。不赞赏，也依然可以完整地使用 Abandon 便签。
          </p>
        </section>
      </Transition>
    </div>

    <template #footer>
      <template v-if="!isSupportStep">
        <BaseButton :disabled="saving" @click="openSupport">
          <span class="coffee-mark" aria-hidden="true">☕</span>
          赞赏作者
        </BaseButton>
        <BaseButton
          variant="primary"
          :disabled="saving"
          data-modal-initial-focus
          @click="complete('free')"
        >
          {{ saving ? '正在保存…' : '白嫖一下，已阅读' }}
        </BaseButton>
      </template>
      <template v-else>
        <BaseButton :disabled="saving" @click="returnToStory">返回须知</BaseButton>
        <BaseButton
          variant="primary"
          :disabled="saving"
          data-modal-initial-focus
          @click="complete('support')"
        >
          {{ saving ? '正在保存…' : '完成，进入 Abandon' }}
        </BaseButton>
      </template>
    </template>
  </AppModalShell>
</template>

<style scoped>
.first-use-stage {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
}

.reading-progress {
  height: 2px;
  flex: 0 0 auto;
  overflow: hidden;
  background: var(--ui-fill-passive);
  opacity: 1;
  transition: opacity var(--motion-fast) ease;
}

.reading-progress.is-hidden {
  opacity: 0;
}

.reading-progress span {
  display: block;
  height: 100%;
  border-radius: 0 999px 999px 0;
  background: linear-gradient(90deg, var(--ui-accent), var(--ui-warning));
  transition: width 90ms linear;
}

.notice-story,
.support-view {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
}

.notice-story {
  padding: 28rem clamp(20rem, 5vw, 44rem) 40rem;
  color: var(--text-color);
  font-size: var(--fs-body);
  line-height: 1.85;
  scroll-behavior: smooth;
  overflow-wrap: anywhere;
}

.notice-story p {
  max-width: 650rem;
  margin-right: auto;
  margin-bottom: 22rem;
  margin-left: auto;
}

.notice-story.is-reveal-ready [data-reveal] {
  opacity: 0.34;
  transform: translateY(8rem);
  transition:
    opacity 520ms var(--ease-standard),
    transform 620ms var(--ease-emphasized);
}

.notice-story.is-reveal-ready [data-reveal].is-visible {
  opacity: 1;
  transform: translateY(0);
}

.opening-line {
  display: flex;
  align-items: flex-end;
  gap: 10rem;
  padding-top: 4rem;
  line-height: 1;
}

.opening-year {
  color: transparent;
  background: linear-gradient(135deg, var(--ui-accent), var(--ui-warning));
  background-clip: text;
  font-size: clamp(46rem, 12vw, 82rem);
  font-weight: 700;
  letter-spacing: -0.06em;
}

.opening-copy {
  padding-bottom: 7rem;
  font-size: calc(var(--fs-title) * 1.05);
  font-weight: 700;
  line-height: 1.4;
}

.broken-result span {
  display: inline-block;
  margin-left: 4rem;
  letter-spacing: 0.1em;
  transform: rotate(0.7deg);
}

.quiet-confession {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}

.mission-line {
  padding: 28rem clamp(10rem, 5vw, 34rem);
  font-size: calc(var(--fs-title) * 1.08);
  font-weight: 700;
  line-height: 1.75;
  text-align: center;
}

.mission-line strong {
  position: relative;
  z-index: var(--z-local-content);
  display: inline-block;
  margin-left: 4rem;
  color: transparent;
  background: linear-gradient(120deg, var(--ui-accent), var(--ui-warning));
  background-clip: text;
  font-size: 1.38em;
  letter-spacing: 0.12em;
}

.mission-line strong::after {
  position: absolute;
  z-index: var(--z-local-base);
  inset: -7rem -12rem -5rem -10rem;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 60%, transparent);
  border-radius: 50%;
  content: '';
  opacity: 0;
  transform: rotate(-4deg) scale(0.82);
  transition:
    opacity 420ms 360ms ease,
    transform 680ms 360ms var(--ease-emphasized);
}

.mission-line.is-visible strong::after {
  opacity: 1;
  transform: rotate(-4deg) scale(1);
}

.declaration-line {
  padding: 16rem 0 42rem;
  font-size: calc(var(--fs-title) * 1.03);
  font-weight: 700;
  line-height: 1.9;
  text-align: center;
}

.feature-run {
  max-width: 650rem;
  margin: 0 auto 24rem;
  padding: 10rem 0;
}

.feature-cloud {
  margin-bottom: 0 !important;
  font-weight: 600;
  text-align: center;
}

.interaction-line {
  display: flex;
  align-items: baseline;
  justify-content: center;
  padding: 26rem 0 38rem;
  font-size: calc(var(--fs-title) * 1.08);
  font-weight: 700;
}

.interaction-line span {
  position: relative;
  margin: 0 5rem;
  color: var(--ui-accent);
  font-size: 1.35em;
  letter-spacing: 0.08em;
}

.interaction-line span::after {
  position: absolute;
  right: -3rem;
  bottom: 2rem;
  left: -3rem;
  height: 5rem;
  border-radius: 999px;
  background: var(--ui-accent-subtle);
  content: '';
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 520ms 280ms var(--ease-emphasized);
}

.interaction-line.is-visible span::after {
  transform: scaleX(1);
}

.feature-ledger {
  max-width: 650rem;
  margin: 0 auto 34rem;
}

.feature-ledger p {
  position: relative;
  padding-left: 22rem;
}

.feature-ledger p::before {
  position: absolute;
  top: 0.72em;
  left: 2rem;
  width: 6rem;
  height: 6rem;
  border-radius: 50%;
  background: var(--ui-accent);
  content: '';
}

.feature-ledger p:nth-child(even)::before {
  background: var(--ui-warning);
}

.open-source-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 13rem;
  padding: 38rem 0 20rem;
  text-align: center;
}

.infinity-mark {
  display: grid;
  width: 48rem;
  height: 48rem;
  place-items: center;
  border: 1px solid var(--ui-accent);
  border-radius: 50%;
  color: var(--ui-accent);
  font-family: var(--font-family-mono);
  font-size: 30rem;
  line-height: 1;
  opacity: 0;
  transform: translateY(-12rem) rotate(-8deg);
  transition:
    opacity 300ms 220ms ease,
    transform 520ms 220ms var(--ease-emphasized);
}

.open-source-line.is-visible .infinity-mark {
  opacity: 1;
  transform: translateY(0) rotate(-8deg);
}

.open-source-line strong {
  color: var(--ui-accent);
  font-size: calc(var(--fs-title) * 1.1);
}

.recommend-line {
  margin-top: 26rem;
  font-weight: 700;
  text-align: center;
}

.support-confession {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}

.closing-line {
  padding: 22rem 0 48rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-title) * 1.02);
  letter-spacing: 0.06em;
  text-align: center;
}

.actual-notice {
  max-width: 650rem;
  margin: 0 auto;
  padding: 20rem 22rem 22rem;
  border-radius: 14rem;
  background: var(--ui-surface-subtle);
}

.actual-notice__lead {
  display: flex;
  align-items: center;
  gap: 10rem;
  margin-bottom: 14rem;
}

.actual-notice__lead > span {
  display: grid;
  width: 24rem;
  height: 24rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: rgb(var(--bg-color));
  background: var(--ui-warning);
  font-size: var(--fs-secondary);
  font-weight: 700;
}

.actual-notice__lead p {
  margin: 0;
  font-weight: 700;
}

.actual-notice ul {
  display: grid;
  gap: 11rem;
  padding: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.65;
}

.actual-notice li {
  position: relative;
  padding-left: 16rem;
}

.actual-notice li::before {
  position: absolute;
  top: 0.72em;
  left: 2rem;
  width: 4rem;
  height: 4rem;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.support-view {
  padding: 28rem clamp(20rem, 5vw, 42rem) 34rem;
  text-align: center;
}

.support-symbol {
  display: grid;
  width: 58rem;
  height: 58rem;
  place-items: center;
  margin: 0 auto 14rem;
  border-radius: 50%;
  color: var(--text-color);
  background: var(--ui-accent-subtle);
  font-size: 28rem;
  animation: support-cup-in 520ms var(--ease-emphasized) both;
}

.support-lead {
  max-width: 520rem;
  margin: 0 auto 24rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
  line-height: 1.65;
}

.qr-grid {
  display: grid;
  max-width: 560rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rem;
  margin: 0 auto;
}

.qr-card {
  min-width: 0;
  padding: 14rem;
  border-radius: 14rem;
  background: var(--ui-surface-subtle);
}

.qr-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 11rem;
  background: #fff;
}

.qr-image {
  position: absolute;
  max-width: none;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}

.qr-image--wechat {
  top: 0;
  left: 0;
  width: 184%;
  transform: translate(-22%, -8%);
}

.qr-image--alipay {
  top: 0;
  left: 0;
  width: 130%;
  transform: translate(-11.5%, -29.5%);
}

.qr-card figcaption {
  display: flex;
  flex-direction: column;
  gap: 3rem;
  margin-top: 11rem;
}

.qr-card figcaption strong {
  font-size: var(--fs-body);
}

.qr-card figcaption span {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.4;
}

.support-note {
  max-width: 540rem;
  margin: 22rem auto 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.55;
}

.coffee-mark {
  margin-right: 6rem;
}

.notice-step-enter-active,
.notice-step-leave-active {
  transition:
    opacity 180ms ease,
    transform 240ms var(--ease-standard);
}

.notice-step-enter-from {
  opacity: 0;
  transform: translateX(12rem);
}

.notice-step-leave-to {
  opacity: 0;
  transform: translateX(-10rem);
}

@keyframes support-cup-in {
  from {
    opacity: 0;
    transform: translateY(12rem) rotate(-9deg) scale(0.86);
  }
  to {
    opacity: 1;
    transform: translateY(0) rotate(0) scale(1);
  }
}

@media (max-width: 560px) {
  .qr-grid {
    max-width: 300rem;
    grid-template-columns: 1fr;
  }

  .opening-line {
    align-items: flex-start;
    flex-direction: column;
    gap: 2rem;
  }

  .opening-copy {
    padding-bottom: 0;
  }

  .feature-ledger p {
    padding-right: 0;
    padding-left: 18rem;
    text-align: left;
  }

  .open-source-line {
    align-items: center;
    flex-direction: column;
  }
}
</style>
