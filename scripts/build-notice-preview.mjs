import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('tools/notice-preview')
const outDir = resolve('tmp/notice-preview-dist')
const sources = new Set([resolve(root, 'index.html'), resolve('package-lock.json')])
await build({
  configFile: false,
  root,
  base: './',
  plugins: [
    vue(),
    {
      name: 'preview-source-manifest',
      transform(_code, id) {
        const path = id.split('?')[0]
        if (!path.includes('\0') && !path.includes('node_modules') && /\.(vue|js|css)$/.test(path))
          sources.add(path)
      }
    }
  ],
  build: { outDir, emptyOutDir: true }
})
const files = {}
for (const path of [...sources].sort()) {
  const relative = path.replaceAll('\\', '/').replace(process.cwd().replaceAll('\\', '/') + '/', '')
  files[relative] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
await mkdir(outDir, { recursive: true })
await writeFile(
  resolve(outDir, 'source-manifest.json'),
  JSON.stringify({ version: 1, files }, null, 2) + '\n'
)
console.log(`Preview built from client sources: ${outDir}`)
