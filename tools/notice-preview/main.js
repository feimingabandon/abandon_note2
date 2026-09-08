import { createApp } from 'vue'
import Preview from './Preview.vue'
import '../../src/renderer/src/assets/tokens.css'

// This adapter belongs only to the browser preview bundle, never the desktop.
window.api = {
  acknowledgeRemoteNotice: async () => false,
  openRemoteNoticeLink: () => {},
  openUpdateLink: async () => {}
}
createApp(Preview).mount('#app')
