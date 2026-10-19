<script setup>
import AppToggle from '../../ui/AppToggle.vue'
import AppSlider from '../../ui/AppSlider.vue'
import FontSizeInput from '../../ui/FontSizeInput.vue'
import HelpButton from '../../ui/HelpButton.vue'
import SettingsControlPopover from '../SettingsControlPopover.vue'
const props = defineProps({
  model: { type: Object, required: true },
  isResetting: Boolean,
  panelActive: Boolean
})
const {
  fontSize: stickyFontSize,
  backgroundColor: stickyBackgroundColor,
  cornerRadius: stickyCornerRadius,
  alwaysOnTop: stickyAlwaysOnTop,
  colorInput: stickyColorInput,
  colorInputError: stickyColorInputError,
  fontSizePresets: stickyFontSizePresets,
  colorPresets: stickyColorPresets,
  onColorInput: onStickyColorInput,
  commitColor: commitStickyColor
} = props.model
</script>
<template>
  <section class="settings-section">
    <h4 class="section-title">便利贴</h4>

    <div class="setting-item">
      <div class="setting-left">
        <span class="setting-label"
          >默认字体大小<HelpButton
            text="只决定之后新建便利贴的初始字号，不会修改当前已经展示的便利贴。"
        /></span>
      </div>
      <div class="setting-right">
        <FontSizeInput
          v-model="stickyFontSize"
          data-diagnostic-action="settings.stickyFontSize"
          :presets="stickyFontSizePresets"
          :min="12"
          :max="32"
          width="76px"
        />
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-left">
        <span class="setting-label"
          >默认背景颜色<HelpButton
            text="新建便利贴会使用该背景色，并自动选择具有足够对比度的文字颜色。"
        /></span>
      </div>
      <div class="setting-right settings-color-control">
        <SettingsControlPopover
          label="默认背景颜色"
          :summary="stickyBackgroundColor"
          :disabled="isResetting || !panelActive"
          :width="260"
        >
          <template #summary>
            <span
              class="settings-color-swatch"
              :style="{ backgroundColor: stickyBackgroundColor }"
            />
            <span class="settings-color-value">{{ stickyBackgroundColor.toUpperCase() }}</span>
          </template>
          <div class="settings-color-editor">
            <button
              v-for="color in stickyColorPresets"
              :key="color.value"
              class="color-dot"
              :class="{ active: stickyBackgroundColor === color.value }"
              :style="{ backgroundColor: color.value }"
              :title="color.label"
              :aria-label="color.label"
              @click="stickyBackgroundColor = color.value"
            />
            <input
              v-model="stickyBackgroundColor"
              type="color"
              class="color-input"
              aria-label="自定义颜色"
            />
            <div class="color-hex-input-wrap">
              <input
                type="text"
                class="color-hex-input"
                aria-label="十六进制颜色"
                spellcheck="false"
                :class="{ 'has-error': stickyColorInputError }"
                :value="stickyColorInput"
                placeholder="#FFF2A8"
                maxlength="7"
                @input="onStickyColorInput"
                @blur="commitStickyColor"
                @keydown.enter="commitStickyColor"
              />
            </div>
          </div>
        </SettingsControlPopover>
      </div>
    </div>

    <div class="setting-item setting-item-slider">
      <span class="setting-label"
        >默认圆角<HelpButton
          text="设置新建便利贴的窗口圆角。0 为直角；圆角便利贴会使用透明窗口裁切。"
      /></span>
      <div class="setting-slider-control">
        <AppSlider
          v-model="stickyCornerRadius"
          data-diagnostic-action="settings.stickyCornerRadius"
          :min="0"
          :max="32"
          :step="1"
        />
        <span class="setting-value">{{ stickyCornerRadius }}px</span>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-left">
        <span class="setting-label"
          >默认置顶<HelpButton
            text="开启后，之后新建的便利贴默认保持在其他窗口上方；仍可在单张便利贴上临时取消。"
        /></span>
      </div>
      <div class="setting-right">
        <AppToggle
          v-model="stickyAlwaysOnTop"
          aria-label="便利贴默认置顶"
          size="sm"
          data-diagnostic-action="settings.stickyAlwaysOnTop"
        />
      </div>
    </div>
  </section>
</template>
<style scoped src="./settings-form.css"></style>
