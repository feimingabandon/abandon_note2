import './assets/tokens.css'
import './utils/smoothScroll.js'
import { createApp } from 'vue'
import MonthApp from './MonthApp.vue'
import { createDefaultSettings, VIEW_MODES } from '../../shared/settings-schema.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { installBrowserErrorCapture, installVueErrorCapture } from './utils/installErrorCapture.js'

document.documentElement.classList.add('month-view')
applySettingsSnapshot({ values: createDefaultSettings(VIEW_MODES.MONTH) })

const app = createApp(MonthApp)
installBrowserErrorCapture(window.api, {
  scope: 'month-renderer',
  captureStructuredConsole: true
})
installVueErrorCapture(app, window.api)
app.mount('#app')
