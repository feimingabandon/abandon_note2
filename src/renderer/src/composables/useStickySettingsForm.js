import { ref, watch } from 'vue'

const fontSizePresets = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
const colorPresets = [
  { label: '便签黄', value: '#fff2a8' },
  { label: '柔粉', value: '#ffd4e1' },
  { label: '浅蓝', value: '#d4eaff' },
  { label: '浅绿', value: '#ddf3d5' }
]

/** New-sticky defaults only; the existing sticky windows retain their own presentation. */
export function useStickySettingsForm({ defaults, save, showMessage }) {
  const fontSize = ref(defaults.fontSize)
  const backgroundColor = ref(defaults.backgroundColor)
  const cornerRadius = ref(defaults.cornerRadius)
  const alwaysOnTop = ref(defaults.alwaysOnTop)
  const colorInput = ref(backgroundColor.value)
  const colorInputError = ref(false)

  function onColorInput(event) {
    colorInput.value = event.target.value
    colorInputError.value = false
  }

  function commitColor() {
    const value = colorInput.value.trim()
    if (!value) {
      colorInput.value = backgroundColor.value
      return
    }
    if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(value)) {
      colorInput.value = backgroundColor.value
      colorInputError.value = true
      showMessage('warning', '请输入有效的便利贴十六进制颜色，如 #FFF2A8')
      return
    }
    const normalized = value.toLowerCase()
    backgroundColor.value =
      normalized.length === 4
        ? '#' + [...normalized.slice(1)].map((char) => char + char).join('')
        : normalized
    colorInput.value = backgroundColor.value
    colorInputError.value = false
  }

  function assign(config) {
    fontSize.value = config.fontSize
    backgroundColor.value = config.backgroundColor
    cornerRadius.value = config.cornerRadius
    alwaysOnTop.value = config.alwaysOnTop
  }

  watch(fontSize, (value) => save('sticky.fontSize', value))
  watch(backgroundColor, (value) => save('sticky.backgroundColor', value))
  watch(cornerRadius, (value) => save('sticky.cornerRadius', value))
  watch(alwaysOnTop, (value) => save('sticky.alwaysOnTop', value))
  watch(backgroundColor, (value) => {
    colorInput.value = value
    colorInputError.value = false
  })

  return {
    fontSize,
    backgroundColor,
    cornerRadius,
    alwaysOnTop,
    colorInput,
    colorInputError,
    fontSizePresets,
    colorPresets,
    onColorInput,
    commitColor,
    assign
  }
}
