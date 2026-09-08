import { installBrowserErrorCapture } from '../src/utils/installErrorCapture.js'

installBrowserErrorCapture(window.stickyAPI, {
  scope: 'sticky-renderer',
  captureStructuredConsole: true
})

const contentElement = document.querySelector('[data-content]')
const messageElement = document.querySelector('[data-message]')
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
let committedContent = ''
let pendingSyncedContent = null
let editing = false
let savingContent = false
let pendingContentSave = null
let pinning = false
let closing = false
let messageTimer = null

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
    console.error('[Sticky] 修改便利贴外观失败:', error)
    showError(error.message || '无法修改便利贴外观')
  }
}

function showMessage(type, message, { persistent = false } = {}) {
  if (messageTimer) clearTimeout(messageTimer)
  messageElement.textContent = message
  messageElement.dataset.type = type
  messageElement.setAttribute('role', type === 'error' ? 'alert' : 'status')
  messageElement.hidden = false
  if (persistent) {
    messageTimer = null
    return
  }
  messageTimer = setTimeout(
    () => {
      messageElement.hidden = true
      messageTimer = null
    },
    type === 'error' ? 4_000 : 2_500
  )
}

function showError(message, options) {
  showMessage('error', message, options)
}

function clearMessage() {
  if (messageTimer) clearTimeout(messageTimer)
  messageTimer = null
  messageElement.hidden = true
}

function setEditing(nextEditing) {
  editing = nextEditing
  if (editing) {
    contentElement.setAttribute('contenteditable', 'plaintext-only')
    contentElement.setAttribute('aria-readonly', 'false')
    contentElement.dataset.editing = 'true'
    contentElement.spellcheck = true
    return
  }
  contentElement.removeAttribute('contenteditable')
  contentElement.setAttribute('aria-readonly', 'true')
  delete contentElement.dataset.editing
  contentElement.spellcheck = false
}

function readEditorText() {
  return contentElement.innerText.replace(/\r\n?/g, '\n')
}

function beginEditing() {
  if (editing || savingContent) return
  clearMessage()
  committedContent = contentElement.textContent
  setEditing(true)
  contentElement.focus({ preventScroll: true })
}

function applySyncedContent(value) {
  const content = String(value ?? '')
  if (editing || savingContent) {
    pendingSyncedContent = content
    return
  }
  pendingSyncedContent = null
  committedContent = content
  contentElement.textContent = content
}

function finishEditing({ save = true } = {}) {
  if (!editing) return pendingContentSave || Promise.resolve(true)
  const nextContent = readEditorText()
  setEditing(false)
  if (!save) {
    if (pendingSyncedContent !== null) applySyncedContent(pendingSyncedContent)
    else contentElement.textContent = committedContent
    return Promise.resolve(true)
  }
  contentElement.textContent = nextContent
  if (nextContent === committedContent) {
    if (pendingSyncedContent !== null) applySyncedContent(pendingSyncedContent)
    return Promise.resolve(true)
  }

  savingContent = true
  contentElement.dataset.saving = 'true'
  const request = window.stickyAPI
    .updateContent({ content: nextContent, expectedContent: committedContent })
    .then((result) => {
      if (result?.conflict) {
        const latestSourceContent =
          pendingSyncedContent ?? String(result.content ?? committedContent)
        pendingSyncedContent = null
        committedContent = latestSourceContent
        contentElement.textContent = nextContent
        setEditing(true)
        contentElement.focus({ preventScroll: true })
        showError('来源便签已更新，本次修改尚未保存；请确认正文后重新保存')
        return false
      }
      const latestSourceContent = pendingSyncedContent ?? String(result.content ?? nextContent)
      pendingSyncedContent = null
      committedContent = latestSourceContent
      contentElement.textContent = committedContent
      showMessage('success', '便签已保存')
      return true
    })
    .catch((error) => {
      // 写入失败保留草稿；同步到的新正文继续等待取消或版本冲突处理，不能覆盖输入。
      contentElement.textContent = nextContent
      setEditing(true)
      contentElement.focus({ preventScroll: true })
      console.error('[Sticky] 保存便利贴正文失败:', error)
      showError(error.message || '便利贴正文保存失败，请重试', { persistent: true })
      return false
    })
    .finally(() => {
      savingContent = false
      delete contentElement.dataset.saving
      if (pendingSyncedContent !== null && !editing) applySyncedContent(pendingSyncedContent)
      if (pendingContentSave === request) pendingContentSave = null
    })
  pendingContentSave = request
  return request
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
  if (pinning) return
  pinning = true
  pinButton.disabled = true
  try {
    applyAppearance(await window.stickyAPI.togglePin())
  } catch (error) {
    console.error('[Sticky] 修改便利贴置顶状态失败:', error)
    showError(error.message || '无法修改置顶状态')
  } finally {
    pinning = false
    pinButton.disabled = false
  }
})

contentElement.addEventListener('dblclick', beginEditing)

contentElement.addEventListener('blur', () => {
  void finishEditing()
})

contentElement.addEventListener('keydown', (event) => {
  if (!editing || event.key !== 'Escape') return
  event.preventDefault()
  void finishEditing({ save: false })
  contentElement.blur()
})

closeButton.addEventListener('click', async () => {
  if (closing) return
  closing = true
  closeButton.disabled = true
  try {
    if (!(await finishEditing())) return
    await window.stickyAPI.close()
  } catch (error) {
    console.error('[Sticky] 请求主进程关闭失败:', error)
    showError(error.message || '便利贴关闭失败，请重试')
  } finally {
    closing = false
    closeButton.disabled = false
  }
})

document.addEventListener('pointerdown', (event) => {
  if (editing && !contentElement.contains(event.target)) contentElement.blur()
  if (!paletteElement.hidden && !event.target.closest('.sticky-color-control')) {
    setPaletteOpen(false)
  }
})

window.addEventListener('blur', () => {
  if (editing) contentElement.blur()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !paletteElement.hidden) setPaletteOpen(false)
})

async function initialize() {
  try {
    const state = await window.stickyAPI.getState()
    committedContent = state.content
    contentElement.textContent = state.content
    createPalette(Array.isArray(state.palette) ? state.palette : [])
    applyAppearance(state)
    await window.stickyAPI.ready()
  } catch (error) {
    console.error('[Sticky] 初始化失败:', error)
    showError(error.message || '便利贴初始化失败', { persistent: true })
  }
}

window.stickyAPI.onContentChanged?.((payload) => applySyncedContent(payload?.content))

initialize()
