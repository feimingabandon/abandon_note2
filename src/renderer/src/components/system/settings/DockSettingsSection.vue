<script setup>
import HelpButton from '../../ui/HelpButton.vue'
const props = defineProps({
  model: { type: Object, required: true },
  currentViewLabel: { type: String, required: true }
})
const {
  revealHandleMode: dockRevealHandleMode,
  enabledEdges: dockEnabledEdges,
  runtime: dockRuntime,
  edgeOptions: dockEdgeOptions,
  revealModeOptions: dockRevealModeOptions,
  isRevealModeDisabled: isDockRevealModeDisabled,
  setRevealHandleMode: setDockRevealHandleMode,
  toggleEdge: toggleDockEdge
} = props.model
</script>
<template>
  <section class="settings-section">
    <h4 class="section-title">贴边隐藏</h4>

    <div class="setting-item dock-reveal-setting">
      <div class="setting-left">
        <span class="setting-label"
          >隐藏后的唤出方式<HelpButton
            text="直接唤出会在鼠标触边后立即展开窗口；触边确认会先显示小黑条，鼠标离开后自动收回；常显确认会在窗口隐藏完成后自动显示小黑条并保持，点击后展开窗口，长按拖动可调整其沿屏幕边缘的位置。外部程序全屏时常显条会暂时收回，退出全屏后自动恢复。"
        /></span>
        <span v-if="!dockRuntime.supported" class="setting-hint-caption dock-runtime-hint">
          {{ dockRuntime.reason || '当前平台暂不支持贴边隐藏' }}
        </span>
      </div>
      <div class="setting-right">
        <div class="dock-reveal-mode-selector" role="radiogroup" aria-label="隐藏后的唤出方式">
          <button
            v-for="option in dockRevealModeOptions"
            :key="option.value"
            type="button"
            role="radio"
            :title="option.title"
            :aria-checked="dockRevealHandleMode === option.value"
            :disabled="isDockRevealModeDisabled(option.value)"
            :class="{ 'is-selected': dockRevealHandleMode === option.value }"
            @click="setDockRevealHandleMode(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="setting-item" :class="{ 'has-hint': dockEnabledEdges.length === 0 }">
      <div class="setting-left">
        <span class="setting-label"
          >启用边缘<HelpButton
            text="可同时选择上、左、右边缘。把当前视图拖到已选择且真实可触达的屏幕外边缘后，鼠标离开窗口才会触发隐藏。"
        /></span>
        <span v-if="dockEnabledEdges.length === 0" class="setting-hint-caption dock-empty-hint">
          未选择边缘时，当前{{ currentViewLabel }}不会贴边隐藏
        </span>
      </div>
      <div class="dock-edge-selector" role="group" aria-label="贴边隐藏方向，可多选">
        <button
          v-for="edge in dockEdgeOptions"
          :key="edge.value"
          type="button"
          :disabled="!dockRuntime.supported"
          :aria-pressed="dockEnabledEdges.includes(edge.value)"
          :class="{ 'is-selected': dockEnabledEdges.includes(edge.value) }"
          @click="toggleDockEdge(edge.value)"
        >
          <span class="dock-edge-check" aria-hidden="true">
            <svg v-if="dockEnabledEdges.includes(edge.value)" viewBox="0 0 16 16">
              <path d="m3 8 3 3 7-7" />
            </svg>
          </span>
          {{ edge.label }}
        </button>
      </div>
    </div>
  </section>
</template>
<style scoped src="./settings-form.css"></style>

<style scoped>
/* The white check is a drawing on the semantic accent fill, matching the existing control. */
.dock-reveal-setting .setting-right {
  max-width: 100%;
  width: max-content;
}
.dock-reveal-mode-selector {
  display: flex;
  flex-wrap: wrap;
  width: max-content;
  max-width: 100%;
  min-width: 0;
  gap: 2rem;
  padding: 2rem;
  border-radius: 8rem;
  background: var(--ui-surface-subtle);
}
.dock-reveal-mode-selector button {
  flex: 1 0 auto;
  max-width: 100%;
  min-height: max(26rem, 1.8em);
  padding: 2rem 6rem;
  border: 0;
  border-radius: 6rem;
  color: var(--text-color-secondary);
  background: transparent;
  font: inherit;
  font-size: var(--fs-secondary);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-control) var(--ease-standard),
    transform var(--motion-fast) ease;
}
.dock-reveal-mode-selector button:hover:not(:disabled, .is-selected) {
  color: var(--text-color);
  background: var(--ui-fill-hover);
}
.dock-reveal-mode-selector button.is-selected {
  color: var(--text-color);
  background: var(--ui-accent-subtle);
}
.dock-reveal-mode-selector button:active:not(:disabled) {
  transform: scale(0.98);
}
.dock-reveal-mode-selector button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 1px;
}
.dock-reveal-mode-selector button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

@container (max-width: 340px) {
  .dock-reveal-setting {
    flex-wrap: wrap;
  }
  .dock-reveal-setting .setting-left {
    flex-basis: 100%;
  }
  .dock-reveal-setting .setting-right {
    width: 100%;
  }
  .dock-reveal-mode-selector {
    width: 100%;
  }
}

.dock-edge-selector {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6rem;
}
.dock-edge-selector button {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 0;
  border-radius: 15rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.dock-edge-selector button:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}
.dock-edge-selector button:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 1px;
}
.dock-edge-selector button:active:not(:disabled) {
  transform: scale(0.98);
}
.dock-edge-selector button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
.dock-edge-selector button.is-selected {
  background: var(--ui-accent-subtle);
  color: var(--text-color);
}
.dock-edge-check {
  display: grid;
  width: 16rem;
  height: 16rem;
  place-items: center;
  border-radius: 50%;
  background: var(--ui-fill-pressed);
}
.dock-edge-selector button.is-selected .dock-edge-check {
  background: var(--ui-accent);
}
.dock-edge-check svg {
  width: 11rem;
  height: 11rem;
  fill: none;
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.dock-empty-hint {
  color: var(--ui-warning);
  opacity: 1;
}
.dock-runtime-hint {
  color: var(--ui-warning);
  opacity: 1;
}
</style>
