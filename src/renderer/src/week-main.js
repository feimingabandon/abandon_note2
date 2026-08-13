import './assets/tokens.css'
import './utils/smoothScroll.js'
import { createApp } from 'vue'
import MonthApp from './MonthApp.vue'
import { createDefaultSettings, VIEW_MODES } from '../../shared/settings-schema.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'
import { installBrowserErrorCapture, installVueErrorCapture } from './utils/installErrorCapture.js'

document.documentElement.classList.add('month-view', 'week-view')
applySettingsSnapshot({ values: createDefaultSettings(VIEW_MODES.WEEK) })

const app = createApp(MonthApp, { viewMode: VIEW_MODES.WEEK })
installBrowserErrorCapture(window.api, {
  scope: 'week-renderer',
  captureStructuredConsole: true
})
installVueErrorCapture(app, window.api)
app.mount('#app')
