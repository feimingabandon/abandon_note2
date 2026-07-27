import { installBrowserErrorCapture } from '../src/utils/installErrorCapture.js'

installBrowserErrorCapture(window.stickyAPI, { scope: 'sticky-renderer' })

const contentElement = document.querySelector('[data-content]')
const errorElement = document.querySelector('[data-error]')
const fontDownButton = document.querySelector('[data-action="font-down"]')
const fontUpButton = document.querySelector('[data-action="font-up"]')
const colorButton = document.querySelector('[data-action="color"]')
const pinButton = document.querySelector('[data-action="pin"]')
const closeButton = document.querySelector('[data-action="close"]')
const paletteElement = document.querySelector('[data-palette]')
const swatchesElement = document.querySelector('[data-swatches]')
const colorInput = document.querySelector('[data-color-input]')

let appearance = {
  fontSize: 16,
  backgroundColor: '#FFF2A8',
  textColor: '#1F2328',
  cornerRadius: 0,
  pinned: false
}

function applyAppearance(nextAppearance) {
  appearance = { ...appearance, ...nextAppearance }
  document.documentElement.style.setProperty('--sticky-background', appearance.backgroundColor)
  document.documentElement.style.setProperty('--sticky-text', appearance.textColor)
  document.documentElement.style.setProperty('--sticky-font-size', `${appearance.fontSize}px`)
  document.documentElement.style.setProperty(
    '--sticky-corner-radius',
    `${appearance.cornerRadius}px`
  )
  colorInput.value = appearance.backgroundColor
  pinButton.setAttribute('aria-pressed', String(appearance.pinned))
  pinButton.textContent = appearance.pinned ? '已置顶' : '置顶'
  pinButton.title = appearance.pinned ? '取消置顶' : '置顶便利贴'
  fontDownButton.disabled = appearance.fontSize <= 12
  fontUpButton.disabled = appearance.fontSize >= 32
  for (const swatch of swatchesElement.querySelectorAll('.sticky-swatch')) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === appearance.backgroundColor))
  }
}

async function updateAppearance(payload) {
  try {
    applyAppearance(await window.stickyAPI.updateAppearance(payload))
  } catch (error) {
    showError(error.message || '无法修改便利贴外观')
  }
}

function showError(message) {
  errorElement.textContent = message
  errorElement.hidden = false
}

function setPaletteOpen(open) {
  paletteElement.hidden = !open
  colorButton.setAttribute('aria-expanded', String(open))
}

function createPalette(colors) {
  for (const color of colors) {
    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = 'sticky-swatch'
    swatch.dataset.color = color
    swatch.style.backgroundColor = color
    swatch.setAttribute('aria-label', `使用背景颜色 ${color}`)
    swatch.setAttribute('aria-pressed', 'false')
    swatch.addEventListener('click', () => {
      setPaletteOpen(false)
      updateAppearance({ backgroundColor: color })
    })
    swatchesElement.append(swatch)
  }
}

fontDownButton.addEventListener('click', () => {
  updateAppearance({ fontSize: Math.max(12, appearance.fontSize - 2) })
})

fontUpButton.addEventListener('click', () => {
  updateAppearance({ fontSize: Math.min(32, appearance.fontSize + 2) })
})

colorButton.addEventListener('click', () => {
  setPaletteOpen(paletteElement.hidden)
})

colorInput.addEventListener('change', () => {
  setPaletteOpen(false)
  updateAppearance({ backgroundColor: colorInput.value })
})

pinButton.addEventListener('click', async () => {
  try {
    applyAppearance(await window.stickyAPI.togglePin())
  } catch (error) {
    showError(error.message || '无法修改置顶状态')
  }
})

closeButton.addEventListener('click', () => {
  window.stickyAPI.close().catch(() => window.close())
})

document.addEventListener('pointerdown', (event) => {
  if (!paletteElement.hidden && !event.target.closest('.sticky-color-control')) {
    setPaletteOpen(false)
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !paletteElement.hidden) setPaletteOpen(false)
})

async function initialize() {
  try {
    const state = await window.stickyAPI.getState()
    contentElement.textContent = state.content
    createPalette(Array.isArray(state.palette) ? state.palette : [])
    applyAppearance(state)
    await window.stickyAPI.ready()
  } catch (error) {
    showError(error.message || '便利贴初始化失败')
  }
}

initialize()
