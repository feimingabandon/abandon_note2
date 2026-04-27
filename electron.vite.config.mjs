import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * ============================================================
 * electron-vite 构建配置
 * ============================================================
 * - main:    主进程入口（src/main/index.js）
 * - preload: preload 脚本（src/preload/index.js）
 * - renderer: 渲染进程多页面入口（4 个窗口 = 4 个 HTML 入口）
 *   主窗口      → index.html
 *   主窗口设置   → settings.html
 *   灵动岛窗口   → island.html
 *   灵动岛设置   → island-settings.html
 */
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html'),
          island: resolve('src/renderer/island.html'),
          'island-settings': resolve('src/renderer/island-settings.html')
        }
      }
    }
  }
})
