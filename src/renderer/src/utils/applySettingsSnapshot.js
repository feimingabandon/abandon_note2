/**
 * 将主进程返回的完整设置快照应用到渲染端。
 *
 * 默认值、数据库回退和数值校验均由共享 schema / 主进程负责；这里仅负责把
 * 已解析的值映射为 CSS 自定义属性，避免 App 与 SettingsPanel 各维护一套映射。
 */
import { reportEvidence } from './diagnosticEvidence.js'

const GLASS_PRESETS = Object.freeze({
  select: { blurRatio: 1.2, blurMax: 16, opacityRatio: 1.6, opacityMax: 0.72 },
  complex: { blurRatio: 2, blurMax: 24, opacityRatio: 1.35, opacityMax: 0.65 },
  tooltip: { blurRatio: 0.8, blurMax: 8, opacityRatio: 2, opacityMax: 0.75 }
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const roundToken = (value) => Math.round(value * 1000) / 1000

export function applyTitlebarIconScale(value, root = document.documentElement) {
  const scale = clamp(Number(value) || 100, 100, 150) / 100
  root.style.setProperty('--titlebar-apple-control-size', `${roundToken(18 * scale)}rem`)
  root.style.setProperty('--titlebar-apple-icon-size', `${roundToken(14 * scale)}rem`)
  root.style.setProperty('--titlebar-microsoft-icon-size', `${roundToken(15 * scale)}rem`)
  root.style.setProperty('--calendar-toolbar-icon-size', `${roundToken(17 * scale)}rem`)
}

export function applyIconColor(value, root = document.documentElement) {
  root.setAttribute?.('data-icon-color', value === 'white' ? 'white' : 'black')
}

/**
 * 由用户设置的两个全局基准值生成各类浮层的最终材质参数。
 * 比例在这里集中维护，避免组件各自写死数值；模糊基准最低为 5px，防止霜层裸透。
 */
export function applyGlassBaseSettings({ blur, opacity }, root = document.documentElement) {
  const baseBlur = clamp(Number(blur) || 0, 5, 30)
  const baseOpacity = clamp(Number(opacity) || 0, 0, 1)

  root.style.setProperty('--bg-blur', `${baseBlur}px`)
  root.style.setProperty('--popup-opacity', String(baseOpacity))
  root.style.setProperty('--glass-opacity-base', String(baseOpacity))

  Object.entries(GLASS_PRESETS).forEach(([name, preset]) => {
    const presetBlur = roundToken(clamp(baseBlur * preset.blurRatio, 0, preset.blurMax))
    const presetOpacity = roundToken(clamp(baseOpacity * preset.opacityRatio, 0, preset.opacityMax))
    root.style.setProperty(`--glass-${name}-blur`, `${presetBlur}px`)
    root.style.setProperty(`--glass-${name}-opacity`, String(presetOpacity))
  })
}

export function applySettingsSnapshot(snapshot, root = document.documentElement) {
  const titlebarIconScale = snapshot?.values?.appearance?.titlebarIconScale
  if (titlebarIconScale !== undefined) applyTitlebarIconScale(titlebarIconScale, root)
  applyIconColor(snapshot?.values?.appearance?.iconColor, root)

  const compactFontSize = snapshot?.values?.window?.compactFontSize
  if (compactFontSize !== undefined) {
    root.style.setProperty('--compact-content-font-size', `${compactFontSize}px`)
  }

  const css = snapshot?.values?.css
  if (!css) return

  root.classList?.toggle(
    'is-system-glass-active',
    Boolean(snapshot?.runtime?.blur?.effectiveEnabled)
  )
  root.style.setProperty('--bg-color', css.bgColor)
  applyGlassBaseSettings({ blur: css.bgBlur, opacity: css.popupOpacity }, root)
  root.style.setProperty('--window-opacity', String(css.windowOpacity))
  root.style.setProperty('--window-border-width', css.windowBorder ? '1px' : '0px')
  root.style.setProperty('--font-size-base', `${css.fontSizeBase}rem`)
  root.style.setProperty('--note-remark-font-size', `${css.noteRemarkFontSize}rem`)
  root.style.setProperty('--text-color', css.textColor)

  const cornerRadius = snapshot?.values?.blur?.cornerRadius
  if (cornerRadius !== undefined) {
    root.style.setProperty('--window-radius', `${cornerRadius}px`)
  }
  // CSS 提交证据，不声称整页所有控件和原生窗口均已正确绘制。
  if (snapshot.revision !== undefined)
    reportEvidence(
      'settings.css-applied',
      {
        revision: snapshot.revision,
        fontSize: root.style.getPropertyValue?.('--font-size-base'),
        textColor: root.style.getPropertyValue?.('--text-color'),
        tagColorEnabled: snapshot.values?.notes?.tagColorEnabled
      },
      { actionId: snapshot.diagnostic?.actionId, outcome: 'css-applied' }
    )
}
