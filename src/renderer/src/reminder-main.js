import './assets/tokens.css'
import { createApp } from 'vue'
import ReminderApp from './ReminderApp.vue'
import { DEFAULT_SETTINGS } from '../../shared/settings-schema.js'
import { applySettingsSnapshot } from './utils/applySettingsSnapshot.js'

applySettingsSnapshot({ values: DEFAULT_SETTINGS })
createApp(ReminderApp).mount('#app')
