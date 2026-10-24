const { ipcRenderer } = require('electron')

const phaseChannel = 'sticky-initialization:phase'
const repeatChannel = 'sticky-initialization:repeat-ready'
const parameters = new URLSearchParams(window.location.search)
const caseId = parameters.get('case')
const mode = parameters.get('mode')
let state = null

function report(phase, details = {}) {
  ipcRenderer.send(phaseChannel, { caseId, mode, phase, ...details })
}

async function sendReady(phase) {
  report('ready-invoking', {
    reason: phase,
    renderedContent: document.querySelector('[data-content]')?.textContent,
    stateId: state?.id
  })
  try {
    const value = await ipcRenderer.invoke('sticky:ready')
    report(phase, { ok: true, value })
  } catch (error) {
    report(phase, { ok: false, error: error.message })
  }
}

ipcRenderer.on(repeatChannel, (_event, payload) => {
  if (payload?.caseId === caseId && state) void sendReady('duplicate-ready-result')
})

window.addEventListener(
  'DOMContentLoaded',
  async () => {
    try {
      state = await ipcRenderer.invoke('sticky:get-state')
      const content = document.querySelector('[data-content]')
      const palette = document.querySelector('[data-palette]')
      if (!content || !palette) throw new Error('Sticky initialization fixture DOM is missing')
      content.textContent = state.content
      document.body.style.backgroundColor = state.backgroundColor
      document.body.style.color = state.textColor
      document.body.style.fontSize = state.fontSize + 'px'
      document.body.style.borderRadius = state.cornerRadius + 'px'
      document.body.dataset.stateId = state.id
      for (const color of state.palette) {
        const swatch = document.createElement('span')
        swatch.style.backgroundColor = color
        palette.appendChild(swatch)
      }
      document.body.dataset.stateFilled = 'true'
      report('state-filled', {
        stateId: state.id,
        renderedContent: content.textContent,
        paletteSize: palette.children.length,
        backgroundColor: document.body.style.backgroundColor,
        fontSize: document.body.style.fontSize,
        readyState: document.readyState
      })
      if (mode === 'early-ready') await sendReady('ready-result')
      else report('ready-skipped')
    } catch (error) {
      report('fixture-error', { error: error.stack || error.message })
    }
  },
  { once: true }
)
