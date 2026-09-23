import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

function enforceSandboxPreloadSingleFile() {
  return {
    name: 'enforce-sandbox-preload-single-file',
    generateBundle(_options, bundle) {
      const sharedChunks = Object.values(bundle)
        .filter((output) => output.type === 'chunk' && !output.isEntry)
        .map((output) => output.fileName)
      if (sharedChunks.length) {
        this.error(`Sandbox preload 必须保持单文件，不能引用共享 chunk：${sharedChunks.join(', ')}`)
      }
    }
  }
}

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
    plugins: [enforceSandboxPreloadSingleFile()],
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
