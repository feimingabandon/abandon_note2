import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/bootstrap.js')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.js'),
          screenshot: resolve('src/preload/screenshot.js'),
          sticky: resolve('src/preload/sticky.js')
        }
      }
    }
  },
  renderer: {
    server: {
      fs: {
        allow: [resolve('src'), resolve('node_modules/@zf-web-font/opposans')]
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('.')
      }
    },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          month: resolve('src/renderer/month.html'),
          week: resolve('src/renderer/week.html'),
          sticky: resolve('src/renderer/sticky.html')
        }
      }
    }
  }
})
