import { resolve, dirname } from 'path'
import { readFileSync } from 'node:fs'
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

// 同一份策略/运输源码可供多个 preload 使用，但 sandbox 运行时仍各自内联。
function isolateSandboxPreloadModules() {
  const entries = new Set(['index', 'screenshot', 'sticky'])
  const suffix = '?sandbox-entry='
  return {
    name: 'isolate-sandbox-preload-modules',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const normalized = importer.replaceAll('\\', '/')
      const entry = normalized.includes(suffix)
        ? normalized.split(suffix)[1]
        : /^.*\/src\/preload\/(index|screenshot|sticky)\.js$/.exec(normalized)?.[1]
      if (!entries.has(entry)) return null
      return `${resolve(dirname(importer.split(suffix)[0]), source)}${suffix}${entry}`
    },
    load(id) {
      if (id.includes(suffix)) return readFileSync(id.split(suffix)[0], 'utf8')
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/bootstrap.js'),
          'log-writer': resolve('src/main/logging/log-writer.mjs')
        }
      }
    }
  },
  preload: {
    plugins: [isolateSandboxPreloadModules(), enforceSandboxPreloadSingleFile()],
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
