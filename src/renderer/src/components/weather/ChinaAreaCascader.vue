<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  options: { type: Array, default: () => [] },
  displayValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['complete'])
const open = ref(false)
const triggerRef = ref(null)
const panelRef = ref(null)
const activeProvinceCode = ref('')
const activeCityCode = ref('')
const panelStyle = ref({})

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
  const preferredWidth = Math.max(rect.width, 450)
  const width = Math.min(preferredWidth, window.innerWidth - viewportPadding * 2)
  const left = Math.max(
    viewportPadding,
    Math.min(rect.left, window.innerWidth - width - viewportPadding)
  )
  const panelHeight = panelRef.value?.getBoundingClientRect().height || 0
  const belowTop = rect.bottom + panelGap
  const aboveTop = rect.top - panelGap - panelHeight
  const shouldOpenAbove =
    panelHeight > 0 &&
    belowTop + panelHeight > window.innerHeight - viewportPadding &&
    aboveTop >= viewportPadding
  const top = shouldOpenAbove
    ? aboveTop
    : Math.max(
        viewportPadding,
        Math.min(belowTop, window.innerHeight - panelHeight - viewportPadding)
      )
  panelStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    zIndex: 'var(--z-global-popover)'
  }
}

function toggle() {
  if (props.disabled || !props.options.length) return
  if (open.value) {
    open.value = false
    return
  }
  updatePanelPosition()
  open.value = true
}

function chooseProvince(province) {
  activeProvinceCode.value = province.code
  activeCityCode.value = ''
  if (!province.children?.length) complete(province.candidate)
}

function chooseCity(city) {
  activeCityCode.value = city.code
  if (!city.children?.length) complete(city.candidate)
}

function complete(candidate) {
  if (!candidate) return
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
  open.value = false
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
    nextTick(updatePanelPosition)
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
          @pointerdown.stop
        >
          <div class="china-area-cascader__column scroll-y" role="listbox" aria-label="省级地区">
            <button
              v-for="province in options"
              :key="province.code"
              type="button"
              :class="{ 'is-active': activeProvinceCode === province.code }"
              @click="chooseProvince(province)"
            >
              <span>{{ province.name }}</span
              ><span v-if="province.children?.length">›</span>
            </button>
          </div>
          <div class="china-area-cascader__column scroll-y" role="listbox" aria-label="市级地区">
            <p v-if="!activeProvince">请选择省级地区</p>
            <template v-else>
              <button
                v-for="city in cities"
                :key="city.code"
                type="button"
                :class="{ 'is-active': activeCityCode === city.code }"
                @click="chooseCity(city)"
              >
                <span>{{ city.name }}</span
                ><span v-if="city.children?.length">›</span>
              </button>
            </template>
          </div>
          <div class="china-area-cascader__column scroll-y" role="listbox" aria-label="区县级地区">
            <p v-if="!activeCity">请选择市级地区</p>
            <template v-else>
              <button
                v-for="district in districts"
                :key="district.code"
                type="button"
                @click="complete(district.candidate)"
              >
                <span>{{ district.name }}</span>
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
  border-color: #0a84ff;
  box-shadow: 0 0 0 2px color-mix(in srgb, #0a84ff 24%, transparent);
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
  box-shadow: 0 10rem 30rem rgb(0 0 0 / 0.24);
  transform-origin: top center;
  will-change: clip-path;
}
.china-area-cascader__column {
  min-width: 0;
  max-height: 292rem;
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
  outline: 2px solid color-mix(in srgb, #0a84ff 42%, transparent);
  outline-offset: -2px;
}
.china-area-cascader__column button.is-active {
  background: var(--ui-fill-pressed);
  color: var(--text-color);
}
.china-area-cascader__column button span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
