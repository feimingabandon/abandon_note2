<script setup>
import { weatherSelectionPath } from '../../utils/weatherSelectionPath.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePopoverLifecycle } from '../../composables/usePopoverLifecycle.js'
import { isComposingInput } from '../../utils/inputComposition.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  options: { type: Array, default: () => [] },
  displayValue: { type: String, default: '' },
  modelValue: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['complete'])
const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const cityColumnRef = ref(null)
const districtColumnRef = ref(null)
const activeProvinceCode = ref('')
const activeCityCode = ref('')
const activeDistrictCode = ref('')
const panelStyle = ref({})
const popover = usePopoverLifecycle(open, triggerRef, panelRef, updatePanelPosition, {
  focus: true
})
watch(
  () => props.disabled,
  (value) => {
    if (value) popover.close()
  }
)
async function onPanelKeydown(event) {
  if (isComposingInput(event)) return
  popover.onKeydown(event)
  if (event.key === 'Tab') {
    triggerRef.value?.focus()
    open.value = false
    return
  }
  const column = event.target.closest('[role="listbox"]')
  if (!column) return
  const options = [...column.querySelectorAll('button')]
  const index = options.indexOf(document.activeElement)
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
    options[next]?.focus()
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    if (event.key === 'ArrowRight') {
      options[index]?.click()
      await nextTick()
    }
    if (open.value)
      (event.key === 'ArrowRight' ? column.nextElementSibling : column.previousElementSibling)
        ?.querySelector('button')
        ?.focus()
  }
}
const selectionLocked = ref(false)

const activeProvince = computed(
  () => props.options.find((item) => item.code === activeProvinceCode.value) || null
)
const cities = computed(() => activeProvince.value?.children || [])
const activeCity = computed(
  () => cities.value.find((item) => item.code === activeCityCode.value) || null
)
const districts = computed(() => activeCity.value?.children || [])

function updatePanelPosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const viewportPadding = 8
  const panelGap = 4
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const maximumPanelHeight = 294 * rootRem
  const titlebarBottom =
    document.querySelector('.app-titlebar')?.getBoundingClientRect().bottom || viewportPadding
  // 无边框窗口的顶部标题栏在部分 Windows 设备上会参与原生命中测试。
  // Teleport 浮层必须避开这一区域，否则第一行可见却收不到 hover/click。
  const safeViewportTop = Math.max(viewportPadding, titlebarBottom + panelGap)
  const preferredWidth = Math.max(rect.width, 450)
  const width = Math.min(preferredWidth, Math.max(0, window.innerWidth - viewportPadding * 2))
  const left = Math.max(
    viewportPadding,
    Math.min(rect.left, window.innerWidth - width - viewportPadding)
  )
  const panelHeight = Math.min(maximumPanelHeight, window.innerHeight)
  const belowTop = rect.bottom + panelGap
  const availableBelow = Math.max(0, window.innerHeight - viewportPadding - belowTop)
  const availableAbove = Math.max(0, rect.top - panelGap - safeViewportTop)
  const shouldOpenAbove = panelHeight > availableBelow && availableAbove > availableBelow
  const availableHeight = shouldOpenAbove ? availableAbove : availableBelow
  const renderedHeight = Math.min(panelHeight, availableHeight)
  const top = shouldOpenAbove
    ? Math.max(safeViewportTop, rect.top - panelGap - renderedHeight)
    : Math.max(safeViewportTop, Math.min(belowTop, window.innerHeight - viewportPadding))
  panelStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    // 写入实际可渲染高度，不能写 availableHeight。后者会以内联样式覆盖
    // CSS 的 294rem 上限，并在二次测量时把面板错误放大到整个上方空间。
    maxHeight: `${renderedHeight}px`,
    '--popover-placement': shouldOpenAbove ? 'top' : 'bottom',
    zIndex: 'var(--z-global-popover)'
  }
}

function toggle() {
  if (props.disabled || !props.options.length) return
  if (open.value) {
    open.value = false
    return
  }
  selectionLocked.value = false
  const [province = '', city = '', district = ''] = weatherSelectionPath(
    props.options,
    props.modelValue
  )
  activeProvinceCode.value = province
  activeCityCode.value = city
  activeDistrictCode.value = district
  updatePanelPosition()
  open.value = true
}

function chooseProvince(province) {
  if (selectionLocked.value || props.disabled) return
  activeDistrictCode.value = ''
  activeProvinceCode.value = province.code
  activeCityCode.value = ''
  // 列容器会被 Vue 复用；切换省份时必须清除上一省份留下的滚动位置，
  // 否则新城市列表的第一项可能仍在可视区域上方，看起来像无法选中。
  nextTick(() => {
    if (cityColumnRef.value) cityColumnRef.value.scrollTop = 0
    if (districtColumnRef.value) districtColumnRef.value.scrollTop = 0
  })
  if (!province.children?.length) complete(province.candidate)
}

function chooseCity(city) {
  if (selectionLocked.value || props.disabled) return
  activeDistrictCode.value = ''
  activeCityCode.value = city.code
  // 区县列同样是稳定 DOM，切换城市后从第一项开始展示。
  nextTick(() => {
    if (districtColumnRef.value) districtColumnRef.value.scrollTop = 0
  })
  if (!city.children?.length) complete(city.candidate)
}

function complete(candidate) {
  if (!candidate || selectionLocked.value || props.disabled) return
  selectionLocked.value = true
  // options 会被 Vue 深度响应式化，直接把其中的 Proxy 传给 contextBridge
  // 会触发 Electron 的 "An object could not be cloned"。这里只传递字段均为
  // 基础类型的普通对象，并在收起动画开始前提交，避免快速重开或卸载丢失选择。
  emit('complete', {
    id: candidate.id ?? null,
    name: candidate.name || '',
    admin1: candidate.admin1 || '',
    admin2: candidate.admin2 || '',
    country: candidate.country || '',
    countryCode: candidate.countryCode || '',
    latitude: candidate.latitude ?? null,
    longitude: candidate.longitude ?? null,
    timezone: candidate.timezone || 'auto'
  })
  popover.close(true)
}

function onEnter(element, done) {
  enterPopover(element, done, 'dropdown')
}

function onLeave(element, done) {
  leavePopover(element, done, 'dropdown')
}

function onDocumentPointerDown(event) {
  if (!open.value) return
  if (triggerRef.value?.contains(event.target) || panelRef.value?.contains(event.target)) return
  open.value = false
}

watch(open, (value) => {
  if (value) {
    nextTick(() => {
      updatePanelPosition()
      for (const option of panelRef.value?.querySelectorAll('[aria-selected="true"]') || []) {
        option.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    })
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)
  } else {
    window.removeEventListener('resize', updatePanelPosition)
    window.removeEventListener('scroll', updatePanelPosition, true)
  }
})

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
})
</script>

<template>
  <div class="china-area-cascader">
    <button
      ref="triggerRef"
      type="button"
      class="china-area-cascader__trigger"
      :class="{ 'is-open': open, 'is-placeholder': !displayValue }"
      :disabled="disabled || !options.length"
      aria-label="选择天气地区"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span>{{
        displayValue || (options.length ? '请选择省 / 市 / 区县' : '正在加载行政区划…')
      }}</span>
      <svg
        class="china-area-cascader__arrow"
        :class="{ 'is-open': open }"
        width="10"
        height="6"
        viewBox="0 0 10 6"
        aria-hidden="true"
      >
        <path
          d="M1 1l4 4 4-4"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <Transition :css="false" @enter="onEnter" @leave="onLeave">
        <div
          v-if="open"
          ref="panelRef"
          class="china-area-cascader__panel"
          data-keep-settings-open
          :style="panelStyle"
          @keydown="onPanelKeydown"
          @pointerdown.stop
        >
          <div class="china-area-cascader__column scroll-y" role="listbox" aria-label="省级地区">
            <button
              v-for="province in options"
              :key="province.code"
              role="option"
              :aria-selected="activeProvinceCode === province.code"
              type="button"
              :class="{ 'is-active': activeProvinceCode === province.code }"
              @click="chooseProvince(province)"
            >
              <span>{{ province.name }}</span
              ><span aria-hidden="true">{{
                activeProvinceCode === province.code ? '✓' : province.children?.length ? '›' : ''
              }}</span>
            </button>
          </div>
          <div
            ref="cityColumnRef"
            class="china-area-cascader__column scroll-y"
            role="listbox"
            aria-label="市级地区"
          >
            <p v-if="!activeProvince">请选择省级地区</p>
            <template v-else>
              <button
                v-for="city in cities"
                :key="city.code"
                role="option"
                :aria-selected="activeCityCode === city.code"
                type="button"
                :class="{ 'is-active': activeCityCode === city.code }"
                @click="chooseCity(city)"
              >
                <span>{{ city.name }}</span
                ><span aria-hidden="true">{{
                  activeCityCode === city.code ? '✓' : city.children?.length ? '›' : ''
                }}</span>
              </button>
            </template>
          </div>
          <div
            ref="districtColumnRef"
            class="china-area-cascader__column scroll-y"
            role="listbox"
            aria-label="区县级地区"
          >
            <p v-if="!activeCity">请选择市级地区</p>
            <template v-else>
              <button
                v-for="district in districts"
                :key="district.code"
                role="option"
                :aria-selected="activeDistrictCode === district.code"
                :class="{ 'is-active': activeDistrictCode === district.code }"
                type="button"
                @click="complete(district.candidate)"
              >
                <span>{{ district.name }}</span
                ><span v-if="activeDistrictCode === district.code" aria-hidden="true">✓</span>
              </button>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.china-area-cascader {
  min-width: 0;
  flex: 1;
}
.china-area-cascader__trigger {
  display: flex;
  width: 100%;
  height: 34rem;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  padding: 0 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 8rem;
  outline: none;
  background: var(--ui-surface-control);
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.china-area-cascader__trigger:hover:not(:disabled),
.china-area-cascader__trigger.is-open {
  border-color: var(--ui-border-hover);
}
.china-area-cascader__trigger:focus-visible {
  border-color: var(--ui-border-hover);
}
.china-area-cascader__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.china-area-cascader__trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.china-area-cascader__trigger.is-placeholder span {
  color: var(--text-color-secondary);
}
.china-area-cascader__arrow {
  flex: 0 0 auto;
  opacity: 0.5;
  transition: transform 200ms ease;
}
.china-area-cascader__arrow.is-open {
  transform: rotate(180deg);
}
.china-area-cascader__panel {
  display: grid;
  max-height: 294rem;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: var(--ui-menu-shadow);
  transform-origin: top center;
  will-change: clip-path;
}
.china-area-cascader__column {
  min-width: 0;
  min-height: 0;
  max-height: inherit;
  overflow-y: auto;
  padding: 5rem;
}
.china-area-cascader__column + .china-area-cascader__column {
  border-left: 1px solid var(--ui-border-divider);
}
.china-area-cascader__column button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 6rem;
  padding: 7rem 9rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.china-area-cascader__column button:hover {
  background: var(--ui-fill-hover);
}
.china-area-cascader__column button:active {
  transform: scale(0.98);
}
.china-area-cascader__column button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: -2px;
}
.china-area-cascader__column button.is-active {
  background: var(--ui-fill-pressed);
  color: var(--text-color);
}
.china-area-cascader__column button span:first-child {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.china-area-cascader__column button span:last-child:not(:first-child),
.china-area-cascader__column p {
  color: var(--text-color-secondary);
}
.china-area-cascader__column p {
  margin: 8rem;
  font-size: var(--fs-secondary);
}
@media (max-width: 480px) {
  .china-area-cascader__panel {
    grid-template-columns: repeat(3, minmax(128rem, 1fr));
    overflow-x: auto;
  }
}
</style>
