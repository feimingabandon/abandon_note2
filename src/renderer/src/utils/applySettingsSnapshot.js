/**
 * 将主进程返回的完整设置快照应用到渲染端。
 *
 * 默认值、数据库回退和数值校验均由共享 schema / 主进程负责；这里仅负责把
 * 已解析的值映射为 CSS 自定义属性，避免 App 与 SettingsPanel 各维护一套映射。
 */
export function applySettingsSnapshot(snapshot, root = document.documentElement) {
  const css = snapshot?.values?.css
  if (!css) return

  root.style.setProperty('--bg-color', css.bgColor)
  root.style.setProperty('--popup-opacity', String(css.popupOpacity))
  root.style.setProperty('--bg-blur', `${css.bgBlur}px`)
  root.style.setProperty('--bg-saturation', String(css.bgSaturation))
  root.style.setProperty('--window-opacity', String(css.windowOpacity))
  root.style.setProperty('--bg-border', css.bgBorder ? '1' : '0')
  root.style.setProperty('--font-size-base', `${css.fontSizeBase}rem`)
  root.style.setProperty('--text-color', css.textColor)

  const cornerRadius = snapshot?.values?.blur?.cornerRadius
  if (cornerRadius !== undefined) {
    root.style.setProperty('--window-radius', `${cornerRadius}px`)
  }
}
